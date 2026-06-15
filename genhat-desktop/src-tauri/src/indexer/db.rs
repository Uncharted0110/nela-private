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

#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: String,
    pub filename: String,
    pub is_dir: bool,
    pub size: i64,
    pub mtime: i64,
    pub snippet: String, // query-relevant excerpt from the content column (may be empty)
}

const INDEXER_SCHEMA_VERSION: i64 = 2;

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

        // Migration: if the stored schema version is old, drop and rebuild.
        let current: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);
        if current < INDEXER_SCHEMA_VERSION {
            conn.execute_batch(
                "DROP TABLE IF EXISTS files_fts; DROP TABLE IF EXISTS files;",
            ).ok();
            conn.execute(&format!("PRAGMA user_version = {INDEXER_SCHEMA_VERSION}"), []).ok();
        }

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
                name,
                location,
                content,
                path UNINDEXED,
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
        name_tokens: &str,   // NEW: tokenize_filename(filename)
        location: &str,      // NEW: parent_location(path, 2)
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
            "INSERT INTO files_fts (name, location, content, path) VALUES (?, ?, ?, ?)",
            params![name_tokens, location, content.unwrap_or(""), path],
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

    /// BM25-ranked candidate retrieval. Returns up to `limit` rows, best-first.
    pub fn search_candidates(&self, query_str: &str, limit: usize) -> Result<Vec<Candidate>, String> {
        let conn = self.pool.get().map_err(|e| format!("Database connection error: {e}"))?;

        // 1. Tokenize the query: drop stop words, keep meaningful terms.
        let stop_words = [
            "can","you","tell","me","about","from","my","system","files","to","and","the","a","an",
            "for","in","on","of","with","at","by","this","that","these","those","is","are","was",
            "were","be","been","have","has","had","do","does","did","please","find","show","get",
            "open","read","where","what","i","want","all","any","some","each","every","file","folder",
            "folders","directory","directories","path","paths","location","locations","document",
            "documents","pdf","pdfs","docx","xlsx","txt","csv","md","named","called","titled",
            "containing","contains","content","contents","here","there",
        ];
        let words: Vec<String> = query_str
            .split_whitespace()
            .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
            .filter(|w| !w.is_empty() && !stop_words.contains(&w.as_str()))
            .collect();

        if words.is_empty() {
            return Ok(Vec::new());
        }

        // Each term becomes a quoted prefix token: "tax"*  (quoting avoids FTS syntax errors).
        let terms: Vec<String> = words.iter().map(|w| format!("\"{}\"*", w.replace('"', ""))).collect();

        // 2. AND-first (precision), OR-fallback (recall).
        let and_query = terms.join(" AND ");
        let or_query = terms.join(" OR ");

        // bm25 weights map to indexed columns in declared order: name, location, content, path(UNINDEXED).
        // (path is UNINDEXED and contributes nothing.) Lower bm25() = more relevant, so ORDER BY ASC.
        // snippet(files_fts, 2, ...) -> excerpt from the `content` column (index 2).
        let sql = "
            SELECT f.path, f.filename, f.is_dir, f.size, f.mtime,
                   snippet(files_fts, 2, '', '', '…', 24) AS snip
            FROM files_fts fts
            JOIN files f ON f.path = fts.path
            WHERE files_fts MATCH ?1
            ORDER BY bm25(files_fts, 10.0, 4.0, 1.0, 1.0)
            LIMIT ?2";

        let run = |match_expr: &str| -> Result<Vec<Candidate>, String> {
            let mut stmt = conn.prepare(sql).map_err(|e| format!("Prepare FTS query failed: {e}"))?;
            let rows = stmt
                .query_map(params![match_expr, limit as i64], |row| {
                    Ok(Candidate {
                        path: row.get(0)?,
                        filename: row.get(1)?,
                        is_dir: row.get::<_, i32>(2)? == 1,
                        size: row.get(3)?,
                        mtime: row.get(4)?,
                        snippet: row.get::<_, String>(5).unwrap_or_default(),
                    })
                })
                .map_err(|e| format!("FTS query_map failed: {e}"))?;
            let mut out = Vec::new();
            for r in rows { if let Ok(c) = r { out.push(c); } }
            Ok(out)
        };

        // Try AND, then OR.
        match run(&and_query) {
            Ok(v) if !v.is_empty() => return Ok(v),
            Ok(_) => {} // empty -> fall through to OR
            Err(e) => log::warn!("FTS AND query failed: {e}; trying OR"),
        }
        match run(&or_query) {
            Ok(v) if !v.is_empty() => return Ok(v),
            Ok(_) => {}
            Err(e) => log::warn!("FTS OR query failed: {e}; falling back to LIKE"),
        }

        // 3. LIKE fallback (filename/path only).
        let like = format!("%{}%", words.join("%"));
        let mut stmt = conn.prepare(
            "SELECT path, filename, is_dir, size, mtime FROM files
             WHERE filename LIKE ?1 OR path LIKE ?1 LIMIT ?2",
        ).map_err(|e| format!("Prepare LIKE fallback failed: {e}"))?;
        let rows = stmt.query_map(params![like, limit as i64], |row| {
            Ok(Candidate {
                path: row.get(0)?, filename: row.get(1)?,
                is_dir: row.get::<_, i32>(2)? == 1, size: row.get(3)?, mtime: row.get(4)?,
                snippet: String::new(),
            })
        }).map_err(|e| format!("LIKE query_map failed: {e}"))?;
        let mut out = Vec::new();
        for r in rows { if let Ok(c) = r { out.push(c); } }
        Ok(out)
    }

    /// Search for files matching the query using FTS5. Fallback to simple filename substring search if FTS5 fails.
    pub fn search(&self, query_str: &str) -> Result<Vec<FileRecord>, String> {
        self.search_candidates(query_str, 100).map(|candidates| {
            candidates
                .into_iter()
                .map(|c| FileRecord {
                    path: c.path,
                    filename: c.filename,
                    is_dir: c.is_dir,
                    size: c.size,
                    mtime: c.mtime,
                })
                .collect()
        })
    }
}
