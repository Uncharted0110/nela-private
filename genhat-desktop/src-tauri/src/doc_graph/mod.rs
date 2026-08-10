//! Structural Knowledge Graph & Hybrid Retrieval Engine.
//!
//! Indexes multi-format documents into a petgraph DAG + Tantivy BM25 +
//! FastEmbed dense vectors, then retrieves expanded Markdown context via RRF.

pub mod engine;
pub mod errors;
pub mod graph;
pub mod manifest;
pub mod parsers;
pub mod search;
pub mod state;
pub mod watcher;

pub use engine::{query_kb, run_incremental_sync, run_pipeline, IndexingProgress, PipelineReport};
pub use state::{DocGraphEngine, DocGraphState};
