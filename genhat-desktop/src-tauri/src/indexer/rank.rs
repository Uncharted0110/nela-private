//! Two-stage ambient file ranking: FTS5 BM25 candidates → cross-encoder rerank → threshold.
//!
//! Mirrors the RAG grading pattern (`rag/pipeline.rs`): a cheap recall stage followed by the
//! ms-marco-grader cross-encoder for precision. CPU-bounded by a hard deadline.

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::indexer::db::{Candidate, IndexerDb};
use crate::indexer::paths::{delete_index_paths, index_path_exists, is_low_value_path};
use crate::indexer::query::{parse_search_hints, SearchHints};
use crate::registry::types::TaskResponse;
use crate::router::tasks::grade_request;
use crate::router::TaskRouter;

const BM25_POOL: usize = 40;
const RERANK_POOL: usize = 15;
const PASSAGE_MAX_CHARS: usize = 400;
const RERANK_DEADLINE_MS: u128 = 650;
const MIN_CONTENT_RELEVANCE: f32 = 0.65;
/// Minimum score required before a result is returned to the frontend.
const MIN_RETURN_SCORE: f32 = 0.55;
/// Floor for strong filename matches (cross-encoder scores filenames poorly).
const STRONG_NAME_MATCH_SCORE: f32 = 0.72;
const WEAK_NAME_MATCH_SCORE: f32 = 0.58;
const TOP_K: usize = 5;
const LOW_VALUE_PENALTY: f32 = 0.35;
const RECENCY_BOOST_MAX: f32 = 0.12;

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
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

fn query_tokens(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|w| w.trim_matches(|ch: char| !ch.is_alphanumeric()).to_lowercase())
        .filter(|w| w.len() >= 2)
        .collect()
}

/// Build the short passage the cross-encoder scores against.
fn passage_for(c: &Candidate) -> String {
    let base = format!("{} | {} | {}", c.filename, c.location, c.snippet);
    truncate_chars(&base, PASSAGE_MAX_CHARS)
}

fn filename_matches_doc_types(filename: &str, doc_types: &[String]) -> bool {
    let hay = filename.to_lowercase();
    doc_types.iter().any(|dt| match dt.as_str() {
        "resume" => hay.contains("resume") || hay.contains("résumé") || hay.contains("resumé"),
        "cv" => hay.contains("cv") || hay.contains("curriculum"),
        "cover" => hay.contains("cover") && hay.contains("letter"),
        other => hay.contains(other),
    })
}

fn count_name_token_hits(tokens: &[String], c: &Candidate) -> usize {
    let hay = format!("{} {}", c.filename.to_lowercase(), c.location.to_lowercase());
    tokens.iter().filter(|w| hay.contains(w.as_str())).count()
}

fn is_strong_name_match(hints: &SearchHints, tokens: &[String], c: &Candidate) -> bool {
    if let Some(ref literal) = hints.filename_literal {
        if c.filename.to_lowercase() == *literal {
            return true;
        }
    }
    if !hints.doc_type_tokens.is_empty() && filename_matches_doc_types(&c.filename, &hints.doc_type_tokens)
    {
        return true;
    }
    if tokens.is_empty() {
        return false;
    }
    let hits = count_name_token_hits(tokens, c);
    if tokens.len() == 1 {
        hits >= 1
    } else {
        hits >= 2 || (hits as f32 / tokens.len() as f32) >= 0.5
    }
}

fn is_weak_name_match(tokens: &[String], c: &Candidate) -> bool {
    !tokens.is_empty() && count_name_token_hits(tokens, c) >= 1
}

fn recency_boost(mtime: i64) -> f32 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(mtime);
    if mtime <= 0 || now <= mtime {
        return 0.0;
    }
    let age_days = ((now - mtime) as f32) / 86_400.0;
    if age_days <= 7.0 {
        RECENCY_BOOST_MAX
    } else if age_days <= 30.0 {
        RECENCY_BOOST_MAX * 0.6
    } else if age_days <= 180.0 {
        RECENCY_BOOST_MAX * 0.25
    } else {
        0.0
    }
}

fn apply_score_adjustments(score: f32, hints: &SearchHints, c: &Candidate) -> f32 {
    let mut adjusted = score;
    if is_low_value_path(&c.path) {
        adjusted *= LOW_VALUE_PENALTY;
    }
    if hints.wants_latest {
        adjusted += recency_boost(c.mtime);
    }
    adjusted.clamp(0.0, 1.0)
}

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
    let hints = parse_search_hints(query);
    let tokens = query_tokens(query);

    let mut candidates = db.search_candidates(query, BM25_POOL)?;
    candidates.retain(|c| {
        if c.is_dir || is_low_value_path(&c.path) {
            return false;
        }
        if !index_path_exists(&c.path) {
            delete_index_paths(db, std::path::Path::new(&c.path));
            return false;
        }
        // When the user asked for a resume/CV/etc., drop candidates whose filename doesn't fit.
        if !hints.doc_type_tokens.is_empty()
            && !filename_matches_doc_types(&c.filename, &hints.doc_type_tokens)
            && !is_strong_name_match(&hints, &tokens, c)
        {
            return false;
        }
        true
    });
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let pool = candidates.into_iter().take(RERANK_POOL).collect::<Vec<_>>();
    let mut graded: Vec<(Candidate, f32)> = Vec::new();

    for c in pool {
        if started.elapsed().as_millis() > RERANK_DEADLINE_MS {
            log::debug!("ambient rerank deadline hit; using graded results only");
            break;
        }

        let strong_name = is_strong_name_match(&hints, &tokens, &c);
        let weak_name = is_weak_name_match(&tokens, &c);
        let has_content_snippet = !c.snippet.trim().is_empty();

        let raw_score = if strong_name && !has_content_snippet {
            STRONG_NAME_MATCH_SCORE
        } else {
            let passage = passage_for(&c);
            let req = grade_request(query, &passage);
            match router.route(&req).await {
                Ok(TaskResponse::Score(s)) => s,
                Ok(_) => 0.0,
                Err(e) => {
                    log::debug!("ambient rerank grade failed: {e}");
                    0.0
                }
            }
        };

        let mut effective = raw_score;
        if strong_name {
            effective = effective.max(STRONG_NAME_MATCH_SCORE);
        } else if weak_name && !has_content_snippet {
            effective = effective.max(WEAK_NAME_MATCH_SCORE);
        }

        if !strong_name && !weak_name && has_content_snippet && raw_score < MIN_CONTENT_RELEVANCE {
            continue;
        }

        effective = apply_score_adjustments(effective, &hints, &c);
        if effective < MIN_RETURN_SCORE {
            continue;
        }

        graded.push((c, effective));
    }

    graded.sort_by(|a, b| {
        let by_score = b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal);
        if by_score != std::cmp::Ordering::Equal {
            return by_score;
        }
        if hints.wants_latest {
            return b.0.mtime.cmp(&a.0.mtime);
        }
        std::cmp::Ordering::Equal
    });

    let mut out: Vec<RankedFileRecord> = graded
        .into_iter()
        .take(TOP_K)
        .map(|(c, s)| to_ranked(c, s))
        .collect();

    out.retain(|r| {
        if index_path_exists(&r.path) {
            return true;
        }
        delete_index_paths(db, std::path::Path::new(&r.path));
        false
    });

    log::info!(
        "ambient search_ranked: '{}' -> {} results in {} ms (latest={})",
        truncate_chars(query, 60),
        out.len(),
        started.elapsed().as_millis(),
        hints.wants_latest
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strong_name_match_requires_multiple_tokens() {
        let hints = parse_search_hints("cs grad resume");
        let c = Candidate {
            path: "/home/u/Documents/cs-grad-resume.pdf".into(),
            filename: "cs-grad-resume.pdf".into(),
            is_dir: false,
            size: 100,
            mtime: 0,
            location: "documents".into(),
            snippet: String::new(),
        };
        let tokens = query_tokens("cs grad resume");
        assert!(is_strong_name_match(&hints, &tokens, &c));
    }

    #[test]
    fn low_value_paths_are_penalized() {
        let hints = SearchHints::default();
        let c = Candidate {
            path: "/home/u/.local/lib/python3.12/site-packages/torch/autograd.py".into(),
            filename: "autograd.py".into(),
            is_dir: false,
            size: 100,
            mtime: 0,
            location: String::new(),
            snippet: "class autograd".into(),
        };
        let adjusted = apply_score_adjustments(0.8, &hints, &c);
        assert!(adjusted < 0.35);
    }
}
