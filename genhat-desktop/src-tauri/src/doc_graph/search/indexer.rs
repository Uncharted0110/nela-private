//! Tantivy BM25 writer / reader for doc-graph chunks.
//!
//! `add_chunk` uses an RwLock **read** guard so Rayon workers can index in parallel.
//! `commit` takes a write guard and runs once at the end of ingestion.
//!
//! BM25 queries search `file_name` / `title` / `content` with field boosts that
//! prefer basename matches over body text (avoids path/homograph collisions).
//!
//! Query-side stopwords are stripped before BM25 (not at index time, not for
//! dense embeddings) so phrases like "how to make mazes" do not latch onto
//! unrelated titles such as "How to Eat.pptx" via `how`/`to` + file_name×4.

use super::schema::IndexSchemaManager;
use crate::doc_graph::errors::EngineError;
use parking_lot::RwLock;
use std::path::Path;
use std::sync::Arc;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};

/// Basename boost — filename hits outrank title/body.
pub const BOOST_FILE_NAME: f32 = 4.0;
pub const BOOST_TITLE: f32 = 2.0;
pub const BOOST_CONTENT: f32 = 1.0;

/// Common English function words stripped only from the *query* side of BM25.
/// They carry almost no discriminating power and otherwise drown content terms
/// when basename/title fields are boosted. Never applied to indexed documents
/// or to text sent to the embedder.
const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he",
    "in", "is", "it", "its", "of", "on", "that", "the", "to", "was", "were",
    "will", "with", "i", "you", "your", "my", "me", "who", "what", "when",
    "where", "why", "how", "do", "does", "did", "can", "could", "would",
    "should", "this", "these", "those", "there", "here", "am",
];

pub struct TantivyIndex {
    pub schema_mgr: IndexSchemaManager,
    index: Index,
    reader: IndexReader,
    writer: RwLock<IndexWriter>,
}

impl TantivyIndex {
    pub fn open(index_dir: &Path) -> Result<Self, EngineError> {
        std::fs::create_dir_all(index_dir)?;
        let schema_mgr = IndexSchemaManager::build();
        let index = if index_dir.join("meta.json").exists() {
            Index::open_in_dir(index_dir).map_err(|e| EngineError::Search(e.to_string()))?
        } else {
            Index::create_in_dir(index_dir, schema_mgr.schema.clone())
                .map_err(|e| EngineError::Search(e.to_string()))?
        };

        if index.schema().num_fields() != schema_mgr.schema.num_fields() {
            let _ = std::fs::remove_dir_all(index_dir);
            std::fs::create_dir_all(index_dir)?;
            let index = Index::create_in_dir(index_dir, schema_mgr.schema.clone())
                .map_err(|e| EngineError::Search(e.to_string()))?;
            return Self::from_index(index, schema_mgr);
        }

        Self::from_index(index, schema_mgr)
    }

    fn from_index(index: Index, schema_mgr: IndexSchemaManager) -> Result<Self, EngineError> {
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|e| EngineError::Search(e.to_string()))?;
        let writer = index
            .writer(50_000_000)
            .map_err(|e| EngineError::Search(e.to_string()))?;
        Ok(Self {
            schema_mgr,
            index,
            reader,
            writer: RwLock::new(writer),
        })
    }

    pub fn clear(&self) -> Result<(), EngineError> {
        let w = self.writer.write();
        w.delete_all_documents()
            .map_err(|e| EngineError::Search(e.to_string()))?;
        Ok(())
    }

    /// Delete all Tantivy docs whose stored `file_path` equals `path`.
    pub fn delete_by_file_path(&self, path: &str) -> Result<(), EngineError> {
        let w = self.writer.read();
        let term = Term::from_field_text(self.schema_mgr.field_file_path, path);
        w.delete_term(term);
        Ok(())
    }

    /// Delete docs by exact `chunk_id` terms.
    pub fn delete_chunk_ids(&self, chunk_ids: &[String]) -> Result<(), EngineError> {
        let w = self.writer.read();
        for id in chunk_ids {
            let term = Term::from_field_text(self.schema_mgr.field_chunk_id, id);
            w.delete_term(term);
        }
        Ok(())
    }

    /// Thread-safe: multiple Rayon workers may call this concurrently.
    pub fn add_chunk(
        &self,
        chunk_id: &str,
        file_path: &str,
        title: &str,
        content: &str,
        node_index: u64,
    ) -> Result<(), EngineError> {
        let file_name = Path::new(file_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(file_path);
        // Tokenize underscores / dashes / dots so `amogh_latest_resume.pdf`
        // yields searchable terms `amogh`, `latest`, `resume`, `pdf`.
        let file_name_search = file_name.replace(['_', '-', '.'], " ");

        let w = self.writer.read();
        let term = Term::from_field_text(self.schema_mgr.field_chunk_id, chunk_id);
        w.delete_term(term);
        w.add_document(doc!(
            self.schema_mgr.field_chunk_id => chunk_id,
            self.schema_mgr.field_file_path => file_path,
            self.schema_mgr.field_file_name => file_name,
            self.schema_mgr.field_file_name => file_name_search.as_str(),
            self.schema_mgr.field_title => title,
            self.schema_mgr.field_content => content,
            self.schema_mgr.field_node_index => node_index,
        ))
        .map_err(|e| EngineError::Search(e.to_string()))?;
        Ok(())
    }

    pub fn commit(&self) -> Result<(), EngineError> {
        let mut w = self.writer.write();
        w.commit()
            .map_err(|e| EngineError::Search(e.to_string()))?;
        drop(w);
        self.reader
            .reload()
            .map_err(|e| EngineError::Search(e.to_string()))?;
        Ok(())
    }

    /// Multi-field BM25 parser: `file_name` ×4, `title` ×2, `content` ×1.
    /// Intentionally omits `file_path` to avoid directory-segment / verb collisions.
    pub fn bm25_query_parser(&self) -> QueryParser {
        let mut parser = QueryParser::for_index(
            &self.index,
            vec![
                self.schema_mgr.field_file_name,
                self.schema_mgr.field_title,
                self.schema_mgr.field_content,
            ],
        );
        parser.set_field_boost(self.schema_mgr.field_file_name, BOOST_FILE_NAME);
        parser.set_field_boost(self.schema_mgr.field_title, BOOST_TITLE);
        parser.set_field_boost(self.schema_mgr.field_content, BOOST_CONTENT);
        parser
    }

    /// BM25 search returning (chunk_id, score) ranked best-first.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<(String, f32)>, EngineError> {
        let searcher = self.reader.searcher();
        let parser = self.bm25_query_parser();
        let expanded = expand_query_terms(query);
        let q = parser
            .parse_query(&expanded)
            .or_else(|_| parser.parse_query(&escape_query(&expanded)))
            .or_else(|_| parser.parse_query(&escape_query(query)))
            .map_err(|e| EngineError::Search(e.to_string()))?;

        let top = searcher
            .search(&q, &TopDocs::with_limit(limit))
            .map_err(|e| EngineError::Search(e.to_string()))?;

        let mut out = Vec::with_capacity(top.len());
        for (score, addr) in top {
            let doc: tantivy::TantivyDocument = searcher
                .doc(addr)
                .map_err(|e| EngineError::Search(e.to_string()))?;
            if let Some(val) = doc.get_first(self.schema_mgr.field_chunk_id) {
                if let tantivy::schema::OwnedValue::Str(chunk_id) = val {
                    out.push((chunk_id.to_string(), score));
                }
            }
        }
        Ok(out)
    }
}

/// Expand known document-type synonyms for **single-term** BM25 queries only.
///
/// Example: query `resume` → `(resume OR cv OR "curriculum vitae")` so
/// CV-named files surface alongside `*_resume.pdf`. Multi-word queries are
/// left unchanged aside from alphanumeric cleaning + stopword stripping
/// (`"how to make mazes"` → `"make mazes"`).
pub fn expand_query_terms(query: &str) -> String {
    let raw_tokens: Vec<String> = query
        .split_whitespace()
        .map(|t| {
            t.chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>()
        })
        .filter(|t| !t.is_empty())
        .collect();

    if raw_tokens.is_empty() {
        return query.to_string();
    }

    let tokens = {
        let filtered: Vec<String> = raw_tokens
            .iter()
            .filter(|t| {
                let lower = t.to_ascii_lowercase();
                !STOPWORDS.iter().any(|s| *s == lower)
            })
            .cloned()
            .collect();
        if filtered.is_empty() {
            raw_tokens
        } else {
            filtered
        }
    };

    // Synonym expansion only when the whole query is a single term.
    if tokens.len() == 1 {
        let tok = &tokens[0];
        let lower = tok.to_ascii_lowercase();
        return match lower.as_str() {
            "resume" | "resumes" => format!("({tok} OR cv OR \"curriculum vitae\")"),
            "cv" => format!("({tok} OR resume OR \"curriculum vitae\")"),
            _ => tok.clone(),
        };
    }

    tokens.join(" ")
}

fn escape_query(q: &str) -> String {
    // Same cleaning + stopword strip as expand_query_terms, without synonym
    // expansion — used when the primary parser rejects the expanded form.
    let raw_tokens: Vec<String> = q
        .split_whitespace()
        .map(|t| {
            t.chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>()
        })
        .filter(|t| !t.is_empty())
        .collect();

    if raw_tokens.is_empty() {
        return q.to_string();
    }

    let filtered: Vec<String> = raw_tokens
        .iter()
        .filter(|t| {
            let lower = t.to_ascii_lowercase();
            !STOPWORDS.iter().any(|s| *s == lower)
        })
        .cloned()
        .collect();
    if filtered.is_empty() {
        raw_tokens.join(" ")
    } else {
        filtered.join(" ")
    }
}

pub type SharedTantivyIndex = Arc<TantivyIndex>;

#[cfg(test)]
mod tests {
    use super::expand_query_terms;

    #[test]
    fn expands_single_word_resume_synonyms() {
        let q = expand_query_terms("resume");
        assert!(q.to_ascii_lowercase().contains("cv"));
        assert!(q.to_ascii_lowercase().contains("curriculum vitae"));
    }

    #[test]
    fn does_not_expand_multi_word_queries() {
        let q = expand_query_terms("amogh kalasapura resume");
        assert!(!q.to_ascii_lowercase().contains("curriculum vitae"));
        assert!(q.to_ascii_lowercase().contains("amogh"));
        assert!(q.to_ascii_lowercase().contains("resume"));
    }

    #[test]
    fn leaves_unrelated_queries_alone() {
        let q = expand_query_terms("revenue growth metrics");
        assert_eq!(q, "revenue growth metrics");
    }

    #[test]
    fn strips_how_to_stopwords_from_content_queries() {
        assert_eq!(expand_query_terms("how to make mazes"), "make mazes");
        assert_eq!(expand_query_terms("Generating mazes"), "Generating mazes");
    }

    #[test]
    fn keeps_all_stopword_queries() {
        assert_eq!(expand_query_terms("how to"), "how to");
    }
}
