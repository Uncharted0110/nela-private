//! Web search command — zero-setup DuckDuckGo HTML scraping.
//!
//! Uses DuckDuckGo's no-JS HTML endpoint so no API key is ever required.
//! Optional full-page content is fetched via Jina AI Reader (r.jina.ai),
//! which is also free and requires no credentials.
//!
//! ## Accuracy (Phase 1: candidate over-fetch + cross-encoder reranking)
//!
//! DuckDuckGo's native ordering mixes authoritative pages with SEO spam, so
//! the model used to receive whatever DDG ranked first. We now over-fetch a
//! larger candidate pool, deduplicate it, and rerank every candidate's
//! `title + snippet` against the query using the in-process ms-marco
//! cross-encoder (the `grade` task). Only the top `max_results` survive, and
//! full-page content (when requested) is fetched solely for those — keeping
//! network and memory usage low. If the grader model is unavailable, the
//! original DuckDuckGo ordering is preserved so search never breaks.
//!
//! All errors are soft: parse or network failures return empty results so
//! the chat flow is never blocked.

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;

use crate::commands::inference::TaskRouterState;
use crate::registry::types::TaskResponse;
use crate::router::tasks::grade_request;
use crate::router::TaskRouter;

/// Number of candidate results to over-fetch before reranking down to the
/// caller-requested `max_results`. A larger pool gives the cross-encoder room
/// to surface authoritative pages DuckDuckGo ranked lower.
const OVERFETCH_CANDIDATES: usize = 15;

/// A single web search result.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchHit {
    pub title: String,
    pub snippet: String,
    pub url: String,
}

/// The full result returned to the frontend.
#[derive(Debug, Serialize, Deserialize)]
pub struct WebSearchResult {
    pub query: String,
    pub results: Vec<SearchHit>,
    /// Pre-formatted context block ready to be injected into the model prompt.
    pub formatted_context: String,
}

// ── DDG HTML scraper ──────────────────────────────────────────────────────────

/// Build headers that look like a real browser request.
fn browser_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
        ),
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
    );
    headers.insert(
        ACCEPT_LANGUAGE,
        HeaderValue::from_static("en-US,en;q=0.5"),
    );
    headers
}

/// Fetch and parse DuckDuckGo HTML search results.
///
/// Returns an empty Vec on any failure — never panics or propagates.
async fn fetch_ddg_results(query: &str, max_results: usize) -> Vec<SearchHit> {
    let client = match reqwest::Client::builder()
        .default_headers(browser_headers())
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[web_search] Failed to build HTTP client: {e}");
            return vec![];
        }
    };

    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding::encode(query)
    );

    let html_text = match client.get(&url).send().await {
        Ok(resp) => match resp.text().await {
            Ok(t) => t,
            Err(e) => {
                log::warn!("[web_search] Failed to read DDG response body: {e}");
                return vec![];
            }
        },
        Err(e) => {
            log::warn!("[web_search] DDG request failed: {e}");
            return vec![];
        }
    };

    parse_ddg_html(&html_text, max_results)
}

/// Parse DuckDuckGo HTML into `SearchHit` structs.
fn parse_ddg_html(html: &str, max_results: usize) -> Vec<SearchHit> {
    let document = Html::parse_document(html);

    // DDG HTML result selectors (as of 2024-2026)
    let result_sel = match Selector::parse(".result") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let title_sel = match Selector::parse(".result__a") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let snippet_sel = match Selector::parse(".result__snippet") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let url_sel = match Selector::parse(".result__url") {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let mut hits: Vec<SearchHit> = Vec::new();

    for result in document.select(&result_sel) {
        if hits.len() >= max_results {
            break;
        }

        let title = result
            .select(&title_sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_owned())
            .unwrap_or_default();

        if title.is_empty() {
            continue;
        }

        let snippet = result
            .select(&snippet_sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_owned())
            .unwrap_or_default();

        // Try to get a clean URL from the visible .result__url span.
        // DDG wraps the real href in a redirect; the visible text is usually cleaner.
        let url = result
            .select(&url_sel)
            .next()
            .map(|el| {
                let raw = el.text().collect::<String>().trim().to_owned();
                if raw.starts_with("http") {
                    raw
                } else {
                    format!("https://{raw}")
                }
            })
            // fallback: pull href from the title link and strip DDG redirect prefix
            .or_else(|| {
                result.select(&title_sel).next().and_then(|el| {
                    el.value().attr("href").map(|href| {
                        // DDG links look like "/l/?uddg=https%3A%2F%2F..."
                        if let Some(pos) = href.find("uddg=") {
                            let encoded = &href[pos + 5..];
                            urlencoding::decode(encoded)
                                .map(|s| s.into_owned())
                                .unwrap_or_else(|_| href.to_owned())
                        } else if href.starts_with("http") {
                            href.to_owned()
                        } else {
                            format!("https://duckduckgo.com{href}")
                        }
                    })
                })
            })
            .unwrap_or_default();

        hits.push(SearchHit { title, snippet, url });
    }

    hits
}

// ── Jina AI Reader (full-page content) ───────────────────────────────────────

/// Fetch full-page markdown content for a URL via `r.jina.ai`.
///
/// Returns `None` on any failure — caller should fall back to snippet.
async fn fetch_jina_content(url: &str) -> Option<String> {
    let jina_url = format!("https://r.jina.ai/{url}");

    let client = match reqwest::Client::builder()
        .default_headers(browser_headers())
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(_) => return None,
    };

    match client.get(&jina_url).send().await {
        Ok(resp) => match resp.text().await {
            Ok(text) => {
                // Truncate to ~2000 chars to keep context lean for small models
                let truncated: String = text.chars().take(2000).collect();
                Some(truncated)
            }
            Err(_) => None,
        },
        Err(e) => {
            log::warn!("[web_search] Jina fetch failed for {url}: {e}");
            None
        }
    }
}

// ── Dedup + cross-encoder reranking ───────────────────────────────────────────

/// Normalize a URL into a dedup key: strip scheme, leading `www.`, and any
/// trailing slash, then lowercase. Two URLs that point at the same page (e.g.
/// `http://www.x.com/a/` and `https://x.com/a`) collapse to one key.
fn normalize_url_key(url: &str) -> String {
    let trimmed = url.trim();
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let without_www = without_scheme.strip_prefix("www.").unwrap_or(without_scheme);
    without_www.trim_end_matches('/').to_lowercase()
}

/// Remove duplicate hits that resolve to the same normalized URL, preserving
/// first-seen order. Hits without a usable URL are always kept.
fn dedup_hits(hits: Vec<SearchHit>) -> Vec<SearchHit> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<SearchHit> = Vec::with_capacity(hits.len());

    for hit in hits {
        let key = normalize_url_key(&hit.url);
        if key.is_empty() || seen.insert(key) {
            out.push(hit);
        }
    }

    out
}

/// Rerank search hits by cross-encoder relevance to the query.
///
/// Scores each hit's `title + snippet` against the query using the in-process
/// ms-marco cross-encoder (the `grade` task), then sorts by descending
/// relevance. Scoring is sequential because the cross-encoder serializes on a
/// single ONNX session anyway, and each pair scores in a few milliseconds.
///
/// If the grader model is unavailable (e.g. not installed), the original
/// DuckDuckGo ordering is preserved so search degrades gracefully.
async fn rerank_hits(router: &TaskRouter, query: &str, hits: Vec<SearchHit>) -> Vec<SearchHit> {
    if hits.len() <= 1 {
        return hits;
    }

    let mut scored: Vec<(f32, SearchHit)> = Vec::with_capacity(hits.len());
    let mut any_scored = false;

    for hit in hits {
        let passage = if hit.snippet.trim().is_empty() {
            hit.title.clone()
        } else {
            format!("{}. {}", hit.title, hit.snippet)
        };

        let score = if passage.trim().is_empty() {
            f32::NEG_INFINITY
        } else {
            let request = grade_request(query, &passage);
            match router.route(&request).await {
                Ok(TaskResponse::Score(s)) => {
                    any_scored = true;
                    s
                }
                // Wrong response shape or grader unavailable → sink this hit
                // below any successfully scored ones.
                _ => f32::NEG_INFINITY,
            }
        };

        scored.push((score, hit));
    }

    if !any_scored {
        log::warn!("[web_search] Cross-encoder grader unavailable; preserving DDG order");
        return scored.into_iter().map(|(_, hit)| hit).collect();
    }

    // Stable-ish descending sort by relevance score.
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
    });

    if log::log_enabled!(log::Level::Debug) {
        for (score, hit) in scored.iter().take(5) {
            log::debug!(
                "[web_search] rerank {:.3} :: {}",
                score,
                truncate_for_log(&hit.title, 70)
            );
        }
    }

    scored.into_iter().map(|(_, hit)| hit).collect()
}

fn truncate_for_log(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max).collect();
        format!("{truncated}…")
    }
}

// ── Context formatter ─────────────────────────────────────────────────────────

fn format_context(results: &[SearchHit]) -> String {
    if results.is_empty() {
        return String::new();
    }

    let mut ctx = String::from(
        "Use the following up-to-date web search results to inform your answer. \
         Cite sources where relevant.\n\nWeb Search Results:\n",
    );

    for (i, hit) in results.iter().enumerate() {
        ctx.push_str(&format!(
            "\n[{}] {}\nURL: {}\n{}\n",
            i + 1,
            hit.title,
            hit.url,
            hit.snippet
        ));
    }

    ctx
}

// ── Tauri command ─────────────────────────────────────────────────────────────

/// Search the web and return structured results + a formatted context block.
///
/// * `query` — the user's message (trimmed to 150 chars before sending to DDG).
/// * `max_results` — how many results to return (typically 5 for snippets, 2 for full).
/// * `fetch_content` — if true, fetches full-page markdown via Jina AI Reader for each result.
///
/// Internally over-fetches a larger candidate pool, deduplicates it, and
/// reranks by cross-encoder relevance before truncating to `max_results`.
/// Full-page content (when requested) is fetched only for the surviving
/// top results.
///
/// This command never returns an Err that blocks chat: parse/network failures
/// produce an empty `results` list with an empty `formatted_context`.
#[tauri::command]
pub async fn web_search(
    query: String,
    max_results: u32,
    fetch_content: bool,
    router: State<'_, TaskRouterState>,
) -> Result<WebSearchResult, String> {
    let trimmed_query: String = query.chars().take(150).collect();
    let n = (max_results.min(10)).max(1) as usize;

    // Over-fetch a broad candidate pool so the cross-encoder has room to surface
    // authoritative pages DuckDuckGo ranked lower, then dedup and rerank.
    let candidates = fetch_ddg_results(&trimmed_query, OVERFETCH_CANDIDATES).await;
    let candidates = dedup_hits(candidates);
    let reranked = rerank_hits(&router.0, &trimmed_query, candidates).await;

    let mut results: Vec<SearchHit> = reranked.into_iter().take(n).collect();

    if fetch_content && !results.is_empty() {
        // Enrich each result with full page content
        let enriched_futures: Vec<_> = results
            .iter()
            .map(|hit| fetch_jina_content(&hit.url))
            .collect();

        let contents = futures_util::future::join_all(enriched_futures).await;

        for (hit, content_opt) in results.iter_mut().zip(contents) {
            if let Some(content) = content_opt {
                // Replace brief snippet with richer page content
                hit.snippet = content;
            }
        }
    }

    let formatted_context = format_context(&results);

    Ok(WebSearchResult {
        query: trimmed_query,
        results,
        formatted_context,
    })
}
