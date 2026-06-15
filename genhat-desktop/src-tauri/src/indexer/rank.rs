//! Two-stage ambient file ranking: FTS5 BM25 candidates → cross-encoder rerank → threshold.
//!
//! Mirrors the RAG grading pattern (`rag/pipeline.rs`): a cheap recall stage followed by the
//! ms-marco-grader cross-encoder for precision. CPU-bounded by a hard deadline.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::indexer::db::{Candidate, IndexerDb};
use crate::registry::types::TaskResponse;
use crate::router::tasks::grade_request;
use crate::router::TaskRouter;

const BM25_POOL: usize = 40;
const RERANK_POOL: usize = 15;
const PASSAGE_MAX_CHARS: usize = 400;
const RERANK_DEADLINE_MS: u128 = 650;
const MIN_RELEVANCE: f32 = 0.50;
const TOP_K: usize = 5;

/// Returned to the frontend (serde -> JSON). Mirrors FileRecord + score + snippet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankedFileRecord {
    pub path: String,
    pub filename: String,
    pub is_dir: bool,
    pub size: i64,
    pub mtime: i64,
    pub score: f32,
    pub snippet: String,
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { s.chars().take(max).collect() }
}

/// Build the short passage the cross-encoder scores against.
fn passage_for(c: &Candidate) -> String {
    // Filename + folder context + content snippet, capped.
    let base = format!("{} | {}", c.filename, c.snippet);
    truncate_chars(&base, PASSAGE_MAX_CHARS)
}

pub async fn search_ranked(
    db: &IndexerDb,
    router: &TaskRouter,
    query: &str,
) -> Result<Vec<RankedFileRecord>, String> {
    let started = Instant::now();

    // Stage 1: BM25 candidates.
    let mut candidates = db.search_candidates(query, BM25_POOL)?;
    candidates.retain(|c| !c.is_dir); // we feed file content to the SLM, skip directories
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // Stage 2: rerank the top RERANK_POOL with the cross-encoder, deadline-guarded.
    let pool = candidates.into_iter().take(RERANK_POOL).collect::<Vec<_>>();
    let mut scored: Vec<(Candidate, f32)> = Vec::with_capacity(pool.len());
    let mut deadline_hit = false;
    for c in pool {
        if started.elapsed().as_millis() > RERANK_DEADLINE_MS {
            // Keep the rest in BM25 order with a neutral score so we still return *something*.
            deadline_hit = true;
            scored.push((c, MIN_RELEVANCE)); // neutral; will pass threshold as a fallback
            continue;
        }
        let passage = passage_for(&c);
        let req = grade_request(query, &passage);
        let score = match router.route(&req).await {
            Ok(TaskResponse::Score(s)) => s,
            Ok(_) => MIN_RELEVANCE, // unexpected variant; treat as borderline
            Err(e) => {
                log::debug!("ambient rerank grade failed: {e}");
                MIN_RELEVANCE
            }
        };
        scored.push((c, score));
    }

    // Stage 3: sort desc, threshold, take TOP_K.
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let out: Vec<RankedFileRecord> = scored
        .into_iter()
        .filter(|(_, s)| *s >= MIN_RELEVANCE)
        .take(TOP_K)
        .map(|(c, s)| RankedFileRecord {
            path: c.path, filename: c.filename, is_dir: c.is_dir,
            size: c.size, mtime: c.mtime, score: s, snippet: c.snippet,
        })
        .collect();

    log::info!(
        "ambient search_ranked: '{}' -> {} results in {} ms (deadline_hit={})",
        truncate_chars(query, 60), out.len(), started.elapsed().as_millis(), deadline_hit
    );
    Ok(out)
}
