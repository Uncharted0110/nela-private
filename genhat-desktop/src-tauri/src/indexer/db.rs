use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRecord {
    pub path: String,
    pub filename: String,
    pub is_dir: bool,
    pub size: i64,
    pub mtime: i64,
}

#[derive(Clone)]
pub struct IndexerDb {
    pool: Pool<SqliteConnectionManager>,
}

impl IndexerDb {
    /// Open or create the indexer database.
    pub fn open(db_path: &Path) -> Result<Self, String> {
        let manager = SqliteConnectionManager::file(db_path);
        let pool = Pool::builder()
            .max_size(5) // Keep pool small and lightweight
            .build(manager)
            .map_err(|e| format!("Failed to create SQLite pool: {e}"))?;

        let conn = pool.get().map_err(|e| format!("Failed to get connection: {e}"))?;

        // 1. Enable performance configurations
        conn.execute("PRAGMA journal_mode = WAL;", []).ok();
        conn.execute("PRAGMA synchronous = NORMAL;", []).ok();

        // 2. Create tables
        conn.execute(
            "CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT UNIQUE,
                filename TEXT,
                mtime INTEGER,
                size INTEGER,
                is_dir INTEGER
            );",
            [],
        )
        .map_err(|e| format!("Failed to create files table: {e}"))?;

        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
                path,
                filename,
                content,
                tokenize='porter unicode61'
            );",
            [],
        )
        .map_err(|e| format!("Failed to create files_fts virtual table: {e}"))?;

        Ok(Self { pool })
    }

    /// Retrieve mtime and size of a file by path to check if it has been modified.
    pub fn get_file_metadata(&self, path: &str) -> Result<Option<(i64, i64)>, String> {
        let conn = self.pool.get().map_err(|e| format!("Database connection error: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT mtime, size FROM files WHERE path = ? LIMIT 1")
            .map_err(|e| format!("Prepare statement failed: {e}"))?;

        let mut rows = stmt
            .query(params![path])
            .map_err(|e| format!("Query metadata failed: {e}"))?;

        if let Some(row) = rows.next().map_err(|e| format!("Fetch row failed: {e}"))? {
            let mtime: i64 = row.get(0).unwrap_or(0);
            let size: i64 = row.get(1).unwrap_or(0);
            Ok(Some((mtime, size)))
        } else {
            Ok(None)
        }
    }

    /// Retrieve all paths currently stored in the metadata database.
    pub fn get_all_paths(&self) -> Result<Vec<String>, String> {
        let conn = self.pool.get().map_err(|e| format!("Database connection error: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT path FROM files")
            .map_err(|e| format!("Prepare query failed: {e}"))?;

        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("Map paths failed: {e}"))?;

        let mut paths = Vec::new();
        for path in rows {
            if let Ok(p) = path {
                paths.push(p);
            }
        }
        Ok(paths)
    }

    /// Retrieve the cached content (tokens/headers) of a file from the FTS5 table.
    pub fn get_file_content(&self, path: &str) -> Result<Option<String>, String> {
        let conn = self.pool.get().map_err(|e| format!("Database connection error: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT content FROM files_fts WHERE path = ? LIMIT 1")
            .map_err(|e| format!("Prepare statement failed: {e}"))?;

        let mut rows = stmt
            .query(params![path])
            .map_err(|e| format!("Query content failed: {e}"))?;

        if let Some(row) = rows.next().map_err(|e| format!("Fetch row failed: {e}"))? {
            let content: String = row.get(0).unwrap_or_default();
            Ok(Some(content))
        } else {
            Ok(None)
        }
    }

    /// Insert or update a file metadata and FTS index.
    pub fn insert_or_update(
        &self,
        path: &str,
        filename: &str,
        mtime: i64,
        size: i64,
        is_dir: bool,
        content: Option<&str>,
    ) -> Result<(), String> {
        let mut conn = self.pool.get().map_err(|e| format!("Database connection error: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {e}"))?;

        // 1. Insert/Replace metadata
        tx.execute(
            "INSERT OR REPLACE INTO files (path, filename, mtime, size, is_dir)
             VALUES (?, ?, ?, ?, ?)",
            params![path, filename, mtime, size, if is_dir { 1 } else { 0 }],
        )
        .map_err(|e| format!("Insert metadata failed: {e}"))?;

        // 2. Clean old FTS index
        tx.execute("DELETE FROM files_fts WHERE path = ?", params![path])
            .map_err(|e| format!("Delete old FTS failed: {e}"))?;

        // 3. Insert new FTS index
        tx.execute(
            "INSERT INTO files_fts (path, filename, content) VALUES (?, ?, ?)",
            params![path, filename, content.unwrap_or("")],
        )
        .map_err(|e| format!("Insert FTS failed: {e}"))?;

        tx.commit()
            .map_err(|e| format!("Failed to commit insert/update transaction: {e}"))?;
        Ok(())
    }

    /// Delete a file from both metadata and FTS index.
    pub fn delete(&self, path: &str) -> Result<(), String> {
        let mut conn = self.pool.get().map_err(|e| format!("Database connection error: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {e}"))?;

        tx.execute("DELETE FROM files WHERE path = ?", params![path])
            .map_err(|e| format!("Delete metadata failed: {e}"))?;

        tx.execute("DELETE FROM files_fts WHERE path = ?", params![path])
            .map_err(|e| format!("Delete FTS failed: {e}"))?;

        tx.commit()
            .map_err(|e| format!("Failed to commit delete transaction: {e}"))?;
        Ok(())
    }

    /// Search for files matching the query using FTS5. Fallback to simple filename substring search if FTS5 fails.
    pub fn search(&self, query_str: &str) -> Result<Vec<FileRecord>, String> {
        let conn = self.pool.get().map_err(|e| format!("Database connection error: {e}"))?;

        // Escape double quotes to prevent FTS syntax errors, format query as OR'd prefix tokens
        let sanitized_query = query_str.replace('"', "\"\"");
        let stop_words = [
            "can", "you", "tell", "me", "about", "from", "my", "system", "files", 
            "to", "and", "the", "a", "an", "for", "in", "on", "of", "with", "at", 
            "by", "this", "that", "these", "those", "is", "are", "was", "were", 
            "be", "been", "have", "has", "had", "do", "does", "did", "please", "find", "show"
        ];
        // Split into individual words and create FTS5-compatible prefix queries
        let words: Vec<&str> = sanitized_query
            .split_whitespace()
            .filter(|t| !t.is_empty() && !stop_words.contains(&t.to_lowercase().as_str()))
            .collect();
        
        let mut fts_tokens: Vec<String> = words
            .iter()
            .map(|t| format!("\"{}\"*", t.replace('"', "")))
            .collect();
        
        // Also add underscore-joined and hyphen-joined variants for filename matching (e.g., "form 1a" → "form_1a")
        if words.len() > 1 {
            let underscore_variant = words.join("_");
            fts_tokens.push(format!("\"{}\"*", underscore_variant));
            let hyphen_variant = words.join("-");
            fts_tokens.push(format!("\"{}\"*", hyphen_variant));
            // Also try without separators (e.g., "form1a")
            let joined_variant: String = words.iter().copied().collect();
            fts_tokens.push(format!("\"{}\"*", joined_variant));
        }
        
        let fts_query = if fts_tokens.is_empty() {
            format!("\"{}\"*", sanitized_query)
        } else {
            fts_tokens.join(" OR ")
        };

        // Attempt FTS query
        let mut stmt = conn.prepare(
            "SELECT f.path, f.filename, f.is_dir, f.size, f.mtime 
             FROM files_fts fts
             JOIN files f ON f.path = fts.path
             WHERE files_fts MATCH ?
             LIMIT 100",
        );

        match &mut stmt {
            Ok(s) => {
                let rows = s.query_map(params![fts_query], |row| {
                    Ok(FileRecord {
                        path: row.get(0)?,
                        filename: row.get(1)?,
                        is_dir: row.get::<_, i32>(2)? == 1,
                        size: row.get(3)?,
                        mtime: row.get(4)?,
                    })
                });

                match rows {
                    Ok(mapped_rows) => {
                        let results: Result<Vec<FileRecord>, _> = mapped_rows.collect();
                        if let Ok(vec) = results {
                            if !vec.is_empty() {
                                return Ok(vec);
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("FTS5 search failed: {e}. Falling back to substring search.");
                    }
                }
            }
            Err(e) => {
                log::warn!("FTS5 prepare failed: {e}. Falling back to substring search.");
            }
        }

        // Fallback search using LIKE query on both filename AND path
        let like_query = format!("%{}%", query_str);
        // Also generate underscore and hyphen variants for LIKE
        let underscore_like = format!("%{}%", words.join("_"));
        let hyphen_like = format!("%{}%", words.join("-"));
        let mut stmt_fallback = conn
            .prepare(
                "SELECT path, filename, is_dir, size, mtime 
                 FROM files 
                 WHERE filename LIKE ?1 OR path LIKE ?1 
                    OR filename LIKE ?2 OR path LIKE ?2
                    OR filename LIKE ?3 OR path LIKE ?3
                 LIMIT 100",
            )
            .map_err(|e| format!("Prepare fallback query failed: {e}"))?;

        let rows_fallback = stmt_fallback
            .query_map(params![like_query, underscore_like, hyphen_like], |row| {
                Ok(FileRecord {
                    path: row.get(0)?,
                    filename: row.get(1)?,
                    is_dir: row.get::<_, i32>(2)? == 1,
                    size: row.get(3)?,
                    mtime: row.get(4)?,
                })
            })
            .map_err(|e| format!("Execute fallback query failed: {e}"))?;

        let mut results = Vec::new();
        for row in rows_fallback {
            if let Ok(record) = row {
                results.push(record);
            }
        }

        Ok(results)
    }
}
