//! Hybrid BM25 + lazy dense rerank with Reciprocal Rank Fusion.
//!
//! Dense vectors are **not** stored at index time. At query time we:
//!   1. BM25-retrieve the top [`RRF_CANDIDATE_POOL`] ContentBlocks via a
//!      multi-field QueryParser over `file_name`×4, `title`×2, `content`×1
//!      (basename preferred; full `file_path` is intentionally excluded).
//!      Query stopwords are stripped for BM25 only; single-term queries like
//!      `resume` expand to `cv` / `curriculum vitae`.
//!   2. Embed those candidates + the **original** query with FastEmbed
//!      (stopwords kept — they help sentence semantics)
//!   3. Cosine-rank the candidates and RRF-fuse with BM25
//!   4. Truncate the fused list to [`RRF_CANDIDATE_POOL`] before graph expansion

use super::embeddings::{cosine_similarity, Embedder};
use super::indexer::{TantivyIndex, BOOST_CONTENT, BOOST_FILE_NAME, BOOST_TITLE};
use crate::doc_graph::graph::schema::{KnowledgeBase, NodeType};
use petgraph::graph::NodeIndex;
use std::collections::HashMap;

const RRF_K: f64 = 60.0;
/// Initial BM25 + dense RRF candidate pool prior to graph expansion.
pub const RRF_CANDIDATE_POOL: usize = 50;

#[derive(Debug, Clone)]
pub struct HybridHit {
    pub chunk_id: String,
    pub rrf_score: f64,
}

/// Fuse ranked lists with RRF: score(d) = Σ 1/(k + rank_m(d)).
pub fn rrf_fuse(rankings: &[Vec<String>], k: f64) -> Vec<HybridHit> {
    let mut scores: HashMap<String, f64> = HashMap::new();
    for ranking in rankings {
        for (rank, chunk_id) in ranking.iter().enumerate() {
            *scores.entry(chunk_id.clone()).or_insert(0.0) += 1.0 / (k + (rank as f64) + 1.0);
        }
    }
    let mut hits: Vec<HybridHit> = scores
        .into_iter()
        .map(|(chunk_id, rrf_score)| HybridHit {
            chunk_id,
            rrf_score,
        })
        .collect();
    hits.sort_by(|a, b| {
        b.rrf_score
            .partial_cmp(&a.rrf_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits
}

fn content_from_kb(kb: &KnowledgeBase, chunk_id: &str) -> Option<String> {
    let ni = *kb.chunk_to_node.get(chunk_id)?;
    match kb.graph.node_weight(NodeIndex::new(ni as usize))? {
        NodeType::ContentBlock { content, .. } => Some(content.clone()),
        _ => None,
    }
}

pub fn hybrid_search(
    query: &str,
    kb: &KnowledgeBase,
    index: &TantivyIndex,
    embedder: &Embedder,
    _bm25_top: usize,
    _vector_top: usize,
) -> Result<Vec<HybridHit>, crate::doc_graph::errors::EngineError> {
    log::debug!(
        "BM25 field boosts: file_name={BOOST_FILE_NAME} title={BOOST_TITLE} content={BOOST_CONTENT}"
    );
    let bm25 = index.search(query, RRF_CANDIDATE_POOL)?;
    let bm25_ids: Vec<String> = bm25.into_iter().map(|(id, _)| id).collect();
    if bm25_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut embed_ids: Vec<String> = Vec::with_capacity(bm25_ids.len());
    let mut embed_texts: Vec<String> = Vec::with_capacity(bm25_ids.len() + 1);
    for id in &bm25_ids {
        if let Some(text) = content_from_kb(kb, id) {
            if text.trim().len() >= 20 {
                embed_ids.push(id.clone());
                embed_texts.push(text);
            }
        }
    }

    // Prepend query as first item so one FastEmbed call covers query + candidates.
    let mut batch = Vec::with_capacity(embed_texts.len() + 1);
    batch.push(query.to_string());
    batch.extend(embed_texts);

    let embeddings = embedder.embed_batch(&batch)?;
    if embeddings.is_empty() {
        return Ok(rrf_fuse(&[bm25_ids], RRF_K)
            .into_iter()
            .take(RRF_CANDIDATE_POOL)
            .collect());
    }

    let q_vec = &embeddings[0];
    let mut vector_scored: Vec<(String, f32)> = embed_ids
        .iter()
        .zip(embeddings.iter().skip(1))
        .map(|(id, vec)| (id.clone(), cosine_similarity(q_vec, vec)))
        .collect();
    vector_scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let vector_ids: Vec<String> = vector_scored.into_iter().map(|(id, _)| id).collect();

    Ok(rrf_fuse(&[bm25_ids, vector_ids], RRF_K)
        .into_iter()
        .take(RRF_CANDIDATE_POOL)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rrf_prefers_shared_top_hits() {
        let a = vec!["x".into(), "y".into(), "z".into()];
        let b = vec!["y".into(), "z".into(), "x".into()];
        let fused = rrf_fuse(&[a, b], 60.0);
        assert_eq!(fused[0].chunk_id, "y");
        assert_eq!(fused.len(), 3);
    }
}
