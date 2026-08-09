//! Tantivy schema for structural chunk indexing.
//!
//! `file_name` is a dedicated searchable TEXT field (basename only) so
//! queries like "resume" prefer `amogh_latest_resume.pdf` over path/body
//! homographs. `file_path` stays stored for display / debugging.

use tantivy::schema::{Field, Schema, FAST, STORED, STRING, TEXT};

pub struct IndexSchemaManager {
    pub schema: Schema,
    pub field_chunk_id: Field,
    /// Absolute path — stored, not used as a primary BM25 field (avoids path noise).
    pub field_file_path: Field,
    /// Basename only (`amogh_latest_resume.pdf`) — searchable TEXT.
    pub field_file_name: Field,
    pub field_title: Field,
    pub field_content: Field,
    pub field_node_index: Field,
}

impl IndexSchemaManager {
    pub fn build() -> Self {
        let mut builder = Schema::builder();
        let field_chunk_id = builder.add_text_field("chunk_id", STRING | STORED);
        let field_file_path = builder.add_text_field("file_path", STRING | STORED);
        let field_file_name = builder.add_text_field("file_name", TEXT | STORED);
        let field_title = builder.add_text_field("title", TEXT | STORED);
        let field_content = builder.add_text_field("content", TEXT | STORED);
        let field_node_index = builder.add_u64_field("node_index", FAST | STORED);
        // Bumps field count so older indexes (path-as-TEXT / no basename boost) rebuild.
        let _schema_rev = builder.add_text_field("schema_rev_v3", STRING | STORED);

        Self {
            schema: builder.build(),
            field_chunk_id,
            field_file_path,
            field_file_name,
            field_title,
            field_content,
            field_node_index,
        }
    }
}
