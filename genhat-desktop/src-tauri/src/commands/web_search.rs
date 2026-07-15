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
use crate::commands::web_tables::{
    extract_html_tables, extract_markdown_tables, extract_row_limit,
    resolve_wikipedia_list_title, select_best_table, table_to_markdown, ExtractedWebTable,
};
use crate::registry::types::TaskResponse;
use crate::router::tasks::grade_request;
use crate::router::TaskRouter;

/// Number of candidate results to over-fetch before reranking down to the
/// caller-requested `max_results`. A larger pool gives the cross-encoder room
/// to surface authoritative pages DuckDuckGo ranked lower.
const OVERFETCH_CANDIDATES: usize = 20;

/// Max chars kept from a full-page fetch (Jina or direct HTML extract).
const FULL_CONTENT_CHAR_LIMIT: usize = 6000;

/// Max chars kept per snippet-only result.
const SNIPPET_CHAR_LIMIT: usize = 600;

/// Host fragments that are almost never reliable primary sources.
const BLOCKED_HOST_FRAGMENTS: &[&str] = &[
    "pinterest.",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "duckduckgo.com",
];

/// Trusted reference / data publishers — boosted during reranking.
const TRUSTED_HOST_FRAGMENTS: &[&str] = &[
    "wikipedia.org",
    "wikidata.org",
    "britannica.com",
    "imdb.com",
    "boxofficemojo.com",
    "the-numbers.com",
    "statista.com",
    "worldbank.org",
    "who.int",
    "cdc.gov",
    "nih.gov",
    "sec.gov",
    "reuters.com",
    "apnews.com",
    "bbc.com",
    "bbc.co.uk",
    "nytimes.com",
    "theguardian.com",
    "economist.com",
    "bloomberg.com",
    "ft.com",
    "nature.com",
    "science.org",
    "arxiv.org",
    ".gov",
    ".edu",
];

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
    /// Structured tables extracted from Wikipedia / page content for deterministic spreadsheets.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extracted_tables: Vec<ExtractedWebTable>,
}

// ── Query refinement ──────────────────────────────────────────────────────────

/// Strip leading slash commands (`/web /excel …`) from the raw user message.
fn refine_search_query(raw: &str) -> String {
    let mut q = raw.trim().to_string();
    while q.starts_with('/') {
        let Some(rest) = q.strip_prefix('/') else { break };
        let Some(space) = rest.find(char::is_whitespace) else {
            q.clear();
            break;
        };
        q = rest[space..].trim().to_string();
    }
    q
}

/// Nudge factual queries toward phrasing that surfaces authoritative data pages.
fn enhance_factual_query(query: &str) -> String {
    let lower = query.to_lowercase();
    let mut parts: Vec<&str> = vec![query.trim()];

    if (lower.contains("movie") || lower.contains("film") || lower.contains("grossing"))
        && !lower.contains("box office")
    {
        parts.push("box office");
    }
    if (lower.contains("top ") || lower.contains("highest") || lower.contains("best "))
        && (lower.contains("grossing") || lower.contains("revenue") || lower.contains("sales"))
        && !lower.contains("worldwide")
        && !lower.contains("domestic")
    {
        parts.push("worldwide");
    }

    parts.join(" ")
}

fn host_from_url(url: &str) -> String {
    let trimmed = url.trim();
    let after_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let host = after_scheme.split('/').next().unwrap_or("");
    host.strip_prefix("www.")
        .unwrap_or(host)
        .to_lowercase()
}

fn should_reject_hit(hit: &SearchHit) -> bool {
    if hit.url.trim().is_empty() || hit.title.trim().is_empty() {
        return true;
    }
    let host = host_from_url(&hit.url);
    if host.is_empty() {
        return true;
    }
    BLOCKED_HOST_FRAGMENTS
        .iter()
        .any(|frag| host.contains(frag))
}

fn authority_boost(url: &str) -> f32 {
    let host = host_from_url(url);
    if host.is_empty() {
        return 0.0;
    }
    let mut boost = 0.0f32;
    for frag in TRUSTED_HOST_FRAGMENTS {
        if host.contains(frag) || host.ends_with(frag) {
            boost = boost.max(0.28);
        }
    }
    if host.ends_with(".gov") || host.ends_with(".edu") {
        boost = boost.max(0.32);
    }
    boost
}

fn decode_ddg_href(href: &str) -> String {
    if let Some(pos) = href.find("uddg=") {
        let encoded = &href[pos + 5..];
        let decoded = urlencoding::decode(encoded.split('&').next().unwrap_or(encoded))
            .map(|s| s.into_owned())
            .unwrap_or_else(|_| encoded.to_owned());
        return decoded;
    }
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_owned();
    }
    if href.starts_with("//") {
        return format!("https:{href}");
    }
    format!("https://duckduckgo.com{href}")
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
        "https://html.duckduckgo.com/html/?q={}&kl=us-en",
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

        // Prefer the decoded redirect target from the title link — most reliable.
        let url = result
            .select(&title_sel)
            .next()
            .and_then(|el| el.value().attr("href"))
            .map(decode_ddg_href)
            .filter(|u| !u.is_empty())
            .or_else(|| {
                result.select(&url_sel).next().map(|el| {
                    let raw = el.text().collect::<String>().trim().to_owned();
                    if raw.starts_with("http") {
                        raw
                    } else {
                        format!("https://{raw}")
                    }
                })
            })
            .unwrap_or_default();

        if should_reject_hit(&SearchHit {
            title: title.clone(),
            snippet: snippet.clone(),
            url: url.clone(),
            image_url: None,
        }) {
            continue;
        }

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

// ── Page content extraction ───────────────────────────────────────────────────

/// Extract readable paragraph/list text from raw HTML (fallback when Jina fails).
fn extract_readable_text(html: &str) -> String {
    let document = Html::parse_document(html);
    let container_sels = [
        "article",
        "main",
        "[role=main]",
        "#content",
        ".article-body",
        ".post-content",
        ".entry-content",
        ".mw-parser-output",
    ];
    let block_sels = ["p", "li", "td", "th", "h1", "h2", "h3"];

    for container_sel in container_sels {
        let Ok(c_sel) = Selector::parse(container_sel) else {
            continue;
        };
        if let Some(container) = document.select(&c_sel).next() {
            let mut buf = String::new();
            for block_sel in block_sels {
                let Ok(b_sel) = Selector::parse(block_sel) else {
                    continue;
                };
                for el in container.select(&b_sel) {
                    let t = el.text().collect::<String>().trim().to_string();
                    if t.len() < 3 {
                        continue;
                    }
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(&t);
                }
            }
            if buf.len() > 120 {
                return buf;
            }
        }
    }

    // Fallback: all paragraphs on the page.
    let Ok(p_sel) = Selector::parse("p") else {
        return String::new();
    };
    let mut buf = String::new();
    for el in document.select(&p_sel).take(40) {
        let t = el.text().collect::<String>().trim().to_string();
        if t.len() < 3 {
            continue;
        }
        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str(&t);
    }
    buf
}

/// Fetch page HTML and extract readable text directly from the publisher.
async fn fetch_direct_page_text(url: &str, max_chars: usize) -> Option<String> {
    let client = match reqwest::Client::builder()
        .default_headers(browser_headers())
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return None,
    };

    let html = match client.get(url).send().await {
        Ok(resp) => {
            let status = resp.status();
            if !status.is_success() {
                log::debug!("[web_search] Direct fetch HTTP {status} for {url}");
                return None;
            }
            resp.text().await.ok()?
        }
        Err(e) => {
            log::debug!("[web_search] Direct fetch failed for {url}: {e}");
            return None;
        }
    };

    let text = extract_readable_text(&html);
    if text.trim().len() < 80 {
        return None;
    }
    Some(text.chars().take(max_chars).collect())
}

// ── Jina AI Reader (full-page content) ───────────────────────────────────────

/// Fetch full-page markdown content for a URL via `r.jina.ai`.
///
/// Returns `None` on any failure — caller should fall back to snippet.
async fn fetch_jina_content(url: &str, max_chars: usize) -> Option<String> {
    let jina_url = format!("https://r.jina.ai/{url}");

    let client = match reqwest::Client::builder()
        .default_headers(browser_headers())
        .timeout(std::time::Duration::from_secs(18))
        .build()
    {
        Ok(c) => c,
        Err(_) => return None,
    };

    match client.get(&jina_url).send().await {
        Ok(resp) => {
            if !resp.status().is_success() {
                log::debug!("[web_search] Jina HTTP {} for {url}", resp.status());
                return None;
            }
            match resp.text().await {
                Ok(text) => {
                    let cleaned = text.trim();
                    if cleaned.len() < 80 {
                        return None;
                    }
                    Some(cleaned.chars().take(max_chars).collect())
                }
                Err(_) => None,
            }
        }
        Err(e) => {
            log::warn!("[web_search] Jina fetch failed for {url}: {e}");
            None
        }
    }
}

/// Jina Reader first, then direct HTML extraction from the publisher.
async fn fetch_page_content(url: &str, max_chars: usize) -> Option<String> {
    if let Some(jina) = fetch_jina_content(url, max_chars).await {
        return Some(jina);
    }
    fetch_direct_page_text(url, max_chars).await
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
                    s + authority_boost(&hit.url)
                }
                _ => f32::NEG_INFINITY,
            }
        };

        scored.push((score, hit));
    }

    if !any_scored {
        log::warn!("[web_search] Cross-encoder grader unavailable; using authority-weighted DDG order");
        let mut boosted: Vec<(f32, SearchHit)> = scored
            .into_iter()
            .map(|(_, hit)| (authority_boost(&hit.url), hit))
            .collect();
        boosted.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        return boosted.into_iter().map(|(_, hit)| hit).collect();
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
        "VERIFIED WEB SOURCES — use ONLY facts explicitly stated in the excerpts below.\n\
         Do NOT invent, estimate, or guess values. If sources conflict or omit data, say so.\n\
         Cite the source URL when stating a fact.\n\n\
         Web Search Results:\n",
    );

    for (i, hit) in results.iter().enumerate() {
        let host = host_from_url(&hit.url);
        ctx.push_str(&format!(
            "\n[{}] {}\nSource: {}\nURL: {}\nExcerpt:\n{}\n",
            i + 1,
            hit.title,
            if host.is_empty() { "unknown" } else { &host },
            hit.url,
            hit.snippet.trim()
        ));
        if let Some(ref img) = hit.image_url {
            ctx.push_str(&format!("Image: {img}\n"));
        }
    }

    ctx.push_str("\n--- End of web sources ---\n");
    ctx
}

async fn fetch_raw_html(url: &str) -> Option<String> {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("Mozilla/5.0 (compatible; GenhatDesktop/1.0)")
        .build()
    {
        Ok(c) => c,
        Err(_) => return None,
    };

    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.text().await.ok()
}

/// Fetch the canonical Wikipedia list page when the query maps to a known title.
async fn fetch_wikipedia_list_table(query: &str) -> Option<ExtractedWebTable> {
    let title = resolve_wikipedia_list_title(query)?;
    let url = format!("https://en.wikipedia.org/wiki/{title}");
    let html = fetch_raw_html(&url).await?;
    let display_title = title.replace('_', " ");
    let tables = extract_html_tables(&html, &url, &display_title);
    let row_limit = extract_row_limit(query);
    select_best_table(tables, query, row_limit)
}

fn collect_tables_from_hits(hits: &[SearchHit]) -> Vec<ExtractedWebTable> {
    let mut all = Vec::new();
    for hit in hits {
        all.extend(extract_markdown_tables(
            &hit.snippet,
            &hit.url,
            &hit.title,
        ));
        if hit.snippet.contains("<table") {
            all.extend(extract_html_tables(
                &hit.snippet,
                &hit.url,
                &hit.title,
            ));
        }
    }
    all
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
    let refined = refine_search_query(&query);
    let enhanced = enhance_factual_query(&refined);
    let trimmed_query: String = enhanced.chars().take(150).collect();
    let n = (max_results.min(10)).max(1) as usize;
    let content_limit = if fetch_content {
        FULL_CONTENT_CHAR_LIMIT
    } else {
        SNIPPET_CHAR_LIMIT
    };

    log::info!("[web_search] query={trimmed_query:?} fetch_content={fetch_content} max={n}");

    let candidates = fetch_ddg_results(&trimmed_query, OVERFETCH_CANDIDATES).await;
    let candidates: Vec<SearchHit> = candidates
        .into_iter()
        .filter(|h| !should_reject_hit(h))
        .collect();
    let candidates = dedup_hits(candidates);
    let reranked = rerank_hits(&router.0, &trimmed_query, candidates).await;

    let mut results: Vec<SearchHit> = reranked.into_iter().take(n).collect();

    if fetch_content && !results.is_empty() {
        let enriched_futures: Vec<_> = results
            .iter()
            .map(|hit| fetch_page_content(&hit.url, content_limit))
            .collect();

        let contents = futures_util::future::join_all(enriched_futures).await;

        for (hit, content_opt) in results.iter_mut().zip(contents) {
            if let Some(content) = content_opt {
                hit.snippet = content;
            } else if hit.snippet.chars().count() > SNIPPET_CHAR_LIMIT {
                hit.snippet = hit.snippet.chars().take(SNIPPET_CHAR_LIMIT).collect();
            }
        }
    } else {
        for hit in &mut results {
            if hit.snippet.chars().count() > SNIPPET_CHAR_LIMIT {
                hit.snippet = hit.snippet.chars().take(SNIPPET_CHAR_LIMIT).collect();
            }
        }
    }

    enrich_hit_images(&mut results).await;

    let row_limit = extract_row_limit(&trimmed_query);
    let mut candidate_tables: Vec<ExtractedWebTable> = Vec::new();

    if fetch_content {
        if let Some(wiki_table) = fetch_wikipedia_list_table(&trimmed_query).await {
            candidate_tables.push(wiki_table);
        }
    }

    candidate_tables.extend(collect_tables_from_hits(&results));

    let extracted_tables: Vec<ExtractedWebTable> = match select_best_table(candidate_tables, &trimmed_query, row_limit) {
        Some(table) => vec![table],
        None => Vec::new(),
    };

    let mut formatted_context = format_context(&results);
    if let Some(table) = extracted_tables.first() {
        let table_block = format!(
            "AUTHORITATIVE DATA TABLE — use these EXACT values in WRITE_DATA (do not invent, round, or modify):\n\n{}\n",
            table_to_markdown(table)
        );
        formatted_context = format!("{table_block}\n{formatted_context}");
    }

    Ok(WebSearchResult {
        query: trimmed_query,
        results,
        formatted_context,
        extracted_tables,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refine_strips_slash_commands() {
        assert_eq!(
            refine_search_query("/web /excel Top 10 movies"),
            "Top 10 movies"
        );
    }

    #[test]
    fn enhance_box_office_query() {
        let q = enhance_factual_query("top 10 highest grossing movies");
        assert!(q.contains("box office"));
    }

    #[test]
    fn authority_boosts_wikipedia() {
        assert!(authority_boost("https://en.wikipedia.org/wiki/List") > 0.2);
    }

    #[test]
    fn blocks_pinterest() {
        assert!(should_reject_hit(&SearchHit {
            title: "Pins".into(),
            snippet: String::new(),
            url: "https://www.pinterest.com/pin/1".into(),
            image_url: None,
        }));
    }

    #[test]
    fn decode_ddg_redirect() {
        let decoded = decode_ddg_href(
            "/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FFilm&rut=abc",
        );
        assert_eq!(decoded, "https://en.wikipedia.org/wiki/Film");
    }
}
