//! FastEmbed ONNX wrapper — quantized BAAI/bge-small-en-v1.5 (INT8).

use crate::doc_graph::errors::EngineError;
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use parking_lot::Mutex;
use std::sync::Arc;

/// Default ONNX micro-batch size passed to FastEmbed's single `embed` call.
pub const EMBED_BATCH_SIZE: usize = 256;

pub struct Embedder {
    inner: Mutex<TextEmbedding>,
    dim: usize,
}

impl Embedder {
    pub fn new() -> Result<Self, EngineError> {
        // Quantized INT8 BGE-small — ~5–10× faster on CPU than full-precision.
        let model = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::BGESmallENV15Q).with_show_download_progress(true),
        )
        .map_err(|e| EngineError::Embedding(e.to_string()))?;

        let mut model = model;
        let probe = model
            .embed(vec!["dimension probe".to_string()], Some(EMBED_BATCH_SIZE))
            .map_err(|e| EngineError::Embedding(e.to_string()))?;
        let dim = probe.first().map(|v| v.len()).unwrap_or(384);

        Ok(Self {
            inner: Mutex::new(model),
            dim,
        })
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    /// Embed **all** texts in one FastEmbed call (`batch_size = 256`).
    /// Do not call this per-file or per-chunk from the pipeline.
    pub fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EngineError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut model = self.inner.lock();
        model
            .embed(texts.to_vec(), Some(EMBED_BATCH_SIZE))
            .map_err(|e| EngineError::Embedding(e.to_string()))
    }

    pub fn embed_one(&self, text: &str) -> Result<Vec<f32>, EngineError> {
        let mut v = self.embed_batch(&[text.to_string()])?;
        v.pop()
            .ok_or_else(|| EngineError::Embedding("empty embedding".into()))
    }
}

pub type SharedEmbedder = Arc<Embedder>;

/// Cosine similarity between two equal-length vectors.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom < 1e-12 {
        0.0
    } else {
        dot / denom
    }
}
