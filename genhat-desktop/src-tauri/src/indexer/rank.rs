//! Two-stage ambient file ranking: FTS5 BM25 candidates → cross-encoder rerank → threshold.
//!
//! Mirrors the RAG grading pattern (`rag/pipeline.rs`): a cheap recall stage followed by the
//! ms-marco-grader cross-encoder for precision. CPU-bounded by a hard deadline.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::indexer::db::{Candidate, IndexerDb};
use crate::indexer::paths::{delete_index_paths, index_path_exists};
use crate::registry::types::TaskResponse;
use crate::router::tasks::grade_request;
use crate::router::TaskRouter;

const BM25_POOL: usize = 40;
const RERANK_POOL: usize = 15;
const PASSAGE_MAX_CHARS: usize = 400;
const RERANK_DEADLINE_MS: u128 = 650;
const MIN_RELEVANCE: f32 = 0.50;
/// Effective relevance floor granted to BM25 name/folder matches. The cross-encoder
/// is a prose-relevance model and scores short filename passages ~0 even on exact
/// matches, so name/folder hits are trusted at this floor instead of being graded.
const NAME_MATCH_SCORE: f32 = 0.50;
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
    let base = format!("{} | {} | {}", c.filename, c.location, c.snippet);
    truncate_chars(&base, PASSAGE_MAX_CHARS)
}

/// True when a meaningful query token appears in the candidate's filename or folder
/// `location`. Such matches are trusted on BM25 merit: the cross-encoder cannot judge
/// filename-style passages (it scores them ~0 even on exact matches), so it must not
/// be allowed to drop them.
fn is_name_or_location_match(query: &str, c: &Candidate) -> bool {
    let hay = format!("{} {}", c.filename.to_lowercase(), c.location.to_lowercase());
    query
        .split_whitespace()
        .map(|w| w.trim_matches(|ch: char| !ch.is_alphanumeric()).to_lowercase())
        .filter(|w| w.len() >= 2)
        .any(|w| hay.contains(w.as_str()))
}

/// Map a graded candidate to the frontend record. `score = -1.0` marks "returned
/// without grading (deadline overflow)"; the frontend ignores `score`.
fn to_ranked(c: Candidate, score: f32) -> RankedFileRecord {
    RankedFileRecord {
        path: c.path,
        filename: c.filename,
        is_dir: c.is_dir,
        size: c.size,
        mtime: c.mtime,
        score,
        snippet: c.snippet,
    }
}

pub async fn search_ranked(
    db: &IndexerDb,
    router: &TaskRouter,
    query: &str,
) -> Result<Vec<RankedFileRecord>, String> {
    let started = Instant::now();

    // Stage 1: BM25 candidates.
    let mut candidates = db.search_candidates(query, BM25_POOL)?;
    candidates.retain(|c| {
        if c.is_dir {
            return false;
        }
        if index_path_exists(&c.path) {
            return true;
        }
        delete_index_paths(db, std::path::Path::new(&c.path));
        false
    });
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // Stage 2: grade the top RERANK_POOL with the cross-encoder, deadline-guarded.
    let pool = candidates.into_iter().take(RERANK_POOL).collect::<Vec<_>>();
    let mut graded: Vec<(Candidate, f32)> = Vec::new();
    let mut overflow: Vec<Candidate> = Vec::new(); // deadline-skipped; keep in BM25 order
    let mut deadline_hit = false;
    for c in pool {
        if started.elapsed().as_millis() > RERANK_DEADLINE_MS {
            deadline_hit = true;
            overflow.push(c);
            continue;
        }
        let passage = passage_for(&c);
        let req = grade_request(query, &passage);
        let score = match router.route(&req).await {
            Ok(TaskResponse::Score(s)) => s,
            Ok(_) => 0.0,
            Err(e) => {
                log::debug!("ambient rerank grade failed: {e}");
                0.0
            }
        };
        graded.push((c, score));
    }

    // Stage 3 (hybrid gate): the cross-encoder is a prose-relevance model — it scores
    // filename/folder passages ~0 even on exact matches, so it must only be allowed to
    // *drop* a candidate when the match came purely from document content. Name/folder
    // matches (and matches with no content snippet) are trusted on BM25 merit and floored
    // at NAME_MATCH_SCORE so strong content matches can still rank above them.
    let mut kept: Vec<(Candidate, f32)> = Vec::new();
    for (c, score) in graded {
        let name_hit = is_name_or_location_match(query, &c) || c.snippet.trim().is_empty();
        if !name_hit && score < MIN_RELEVANCE {
            // Pure content match the cross-encoder judged irrelevant — drop for precision.
            continue;
        }
        let effective = if name_hit { score.max(NAME_MATCH_SCORE) } else { score };
        kept.push((c, effective));
    }

    // Stable sort by effective score desc; equal scores preserve BM25 order.
    kept.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<RankedFileRecord> = kept
        .into_iter()
        .take(TOP_K)
        .map(|(c, s)| to_ranked(c, s))
        .collect();

    // Only if we hit the deadline AND still have empty slots, backfill with BM25-order overflow
    // so a slow CPU still returns *something*. These are explicitly "unscored" (score = -1.0).
    if deadline_hit && out.len() < TOP_K {
        for c in overflow.into_iter().take(TOP_K - out.len()) {
            out.push(to_ranked(c, -1.0));
        }
    }
    out.truncate(TOP_K);

    // Final guard: never return paths that disappeared between BM25 and rerank.
    out.retain(|r| {
        if index_path_exists(&r.path) {
            return true;
        }
        delete_index_paths(db, std::path::Path::new(&r.path));
        false
    });

    log::info!(
        "ambient search_ranked: '{}' -> {} results in {} ms (deadline_hit={})",
        truncate_chars(query, 60), out.len(), started.elapsed().as_millis(), deadline_hit
    );
    Ok(out)
}
