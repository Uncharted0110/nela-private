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
    /// Preview image from og:image / twitter:image or Jina markdown, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
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

        hits.push(SearchHit {
            title,
            snippet,
            url,
            image_url: None,
        });
    }

    hits
}

// ── Preview image extraction ─────────────────────────────────────────────────

/// Extract the first markdown image URL from Jina Reader output.
fn extract_first_markdown_image(text: &str) -> Option<String> {
    for line in text.lines() {
        let Some(paren) = line.find("](") else {
            continue;
        };
        let url_start = paren + 2;
        let rest = &line[url_start..];
        let Some(end) = rest.find(')') else {
            continue;
        };
        let url = rest[..end]
            .trim()
            .trim_matches('"')
            .split_whitespace()
            .next()
            .unwrap_or("");
        if url.starts_with("http://") || url.starts_with("https://") {
            return Some(url.to_owned());
        }
    }
    None
}

fn page_origin(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let rest = &url[scheme_end + 3..];
    let host_end = rest.find('/').unwrap_or(rest.len());
    Some(format!("{}{}", &url[..scheme_end + 3], &rest[..host_end]))
}

fn resolve_image_url(page_url: &str, candidate: &str) -> Option<String> {
    let c = candidate.trim();
    if c.is_empty() || c.starts_with("data:") {
        return None;
    }
    if c.starts_with("http://") || c.starts_with("https://") {
        return Some(c.to_owned());
    }
    if c.starts_with("//") {
        return Some(format!("https:{c}"));
    }
    let origin = page_origin(page_url)?;
    if c.starts_with('/') {
        return Some(format!("{origin}{c}"));
    }
    let base = page_url.rsplit_once('/').map(|(b, _)| b).unwrap_or(page_url);
    Some(format!("{base}/{c}"))
}

fn is_reasonable_image_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && !lower.contains("data:")
        && url.len() <= 2048
}

/// Parse Open Graph / Twitter Card image meta tags from HTML.
fn parse_og_image_from_html(html: &str, page_url: &str) -> Option<String> {
    let document = Html::parse_document(html);
    let meta_sel = Selector::parse(
        r#"meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[name="twitter:image:src"]"#,
    )
    .ok()?;

    for el in document.select(&meta_sel) {
        if let Some(content) = el.value().attr("content") {
            if let Some(resolved) = resolve_image_url(page_url, content) {
                if is_reasonable_image_url(&resolved) {
                    return Some(resolved);
                }
            }
        }
    }

    None
}

/// Fetch a result page and extract its primary preview image.
async fn fetch_preview_image(url: &str) -> Option<String> {
    let client = match reqwest::Client::builder()
        .default_headers(browser_headers())
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return None,
    };

    let html = match client.get(url).send().await {
        Ok(resp) => {
            let text = resp.text().await.ok()?;
            text.chars().take(256 * 1024).collect::<String>()
        }
        Err(e) => {
            log::debug!("[web_search] Image fetch failed for {url}: {e}");
            return None;
        }
    };

    parse_og_image_from_html(&html, url)
}

/// Attach preview images to search hits (markdown from Jina, else og:image scrape).
async fn enrich_hit_images(hits: &mut [SearchHit]) {
    let fetch_inputs: Vec<(String, String)> = hits
        .iter()
        .map(|hit| (hit.url.clone(), hit.snippet.clone()))
        .collect();

    let image_futures: Vec<_> = fetch_inputs
        .into_iter()
        .map(|(url, snippet)| async move {
            if url.is_empty() {
                return None;
            }
            if let Some(img) = extract_first_markdown_image(&snippet) {
                return Some(img);
            }
            fetch_preview_image(&url).await
        })
        .collect();

    let images = futures_util::future::join_all(image_futures).await;
    for (hit, image) in hits.iter_mut().zip(images) {
        hit.image_url = image;
    }
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

    enrich_hit_images(&mut results).await;

    let formatted_context = format_context(&results);

    Ok(WebSearchResult {
        query: trimmed_query,
        results,
        formatted_context,
    })
}
