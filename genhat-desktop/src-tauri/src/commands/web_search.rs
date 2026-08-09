//! Web search + page extraction — thin client over the NELA backend's
//! Tavily proxy (`/v1/search`, `/v1/extract`).
//!
//! The backend applies profile presets (Tavily best practices):
//! * `simple`   — general lookups: basic depth, 5 results, LLM answer seed.
//! * `news`     — time-sensitive: news topic + recency filter.
//! * `research` — summaries/analysis: advanced depth, 10 results, full
//!                markdown page content (free on Tavily search).
//!
//! All errors are soft: network/auth failures return empty results so the
//! chat flow is never blocked. Structured tables are still extracted from
//! returned markdown so the spreadsheet-from-web flow keeps working.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::web_tables::{
    extract_markdown_tables, extract_row_limit, select_best_table, table_to_markdown,
    ExtractedWebTable,
};

/// Max chars of full-page (raw) content kept per hit in the model context.
const FULL_CONTENT_CHAR_LIMIT: usize = 6000;

/// Max chars kept per snippet-only result.
const SNIPPET_CHAR_LIMIT: usize = 600;

/// Max query-level images forwarded to the UI gallery.
const MAX_GALLERY_IMAGES: usize = 8;

/// A single web search result.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SearchHit {
    pub title: String,
    pub snippet: String,
    pub url: String,
    /// Preview image for this result, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    /// Favicon URL for the source site (Gemini-style source cards).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
    /// Tavily relevance score (0..1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    /// Publish date for news results (ISO-ish string from Tavily).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
}

/// The full result returned to the frontend.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct WebSearchResult {
    pub query: String,
    pub results: Vec<SearchHit>,
    /// Pre-formatted context block ready to be injected into the model prompt.
    pub formatted_context: String,
    /// Structured tables extracted from page content for deterministic spreadsheets.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extracted_tables: Vec<ExtractedWebTable>,
    /// Tavily's LLM-generated answer seed (simple profile only). Extra context
    /// for our model — never shown to the user directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    /// Query-level images for the UI gallery.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

/// One extracted page returned by `web_extract`.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ExtractedPage {
    pub url: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

/// The full result returned by `web_extract`.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct WebExtractResult {
    pub results: Vec<ExtractedPage>,
    pub formatted_context: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extracted_tables: Vec<ExtractedWebTable>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed: Vec<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

fn host_from_url(url: &str) -> String {
    let trimmed = url.trim();
    let after_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let host = after_scheme.split('/').next().unwrap_or("");
    host.strip_prefix("www.").unwrap_or(host).to_lowercase()
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

fn str_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| s.starts_with("http"))
                .collect()
        })
        .unwrap_or_default()
}

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))
}

// ── Context formatter ─────────────────────────────────────────────────────────

fn format_context(results: &[SearchHit], answer: Option<&str>) -> String {
    if results.is_empty() && answer.is_none() {
        return String::new();
    }

    let mut ctx = String::from(
        "VERIFIED WEB SOURCES — use ONLY facts explicitly stated in the excerpts below.\n\
         Do NOT invent, estimate, or guess values. If sources conflict or omit data, say so.\n\
         Cite the source URL when stating a fact.\n\n",
    );

    if let Some(seed) = answer {
        if !seed.trim().is_empty() {
            ctx.push_str(&format!("Quick answer (verify against sources): {}\n\n", seed.trim()));
        }
    }

    ctx.push_str("Web Search Results:\n");

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

fn collect_tables(sources: &[(String, String, String)]) -> Vec<ExtractedWebTable> {
    let mut all = Vec::new();
    for (text, url, title) in sources {
        all.extend(extract_markdown_tables(text, url, title));
    }
    all
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Search the web via the NELA backend Tavily proxy.
///
/// * `query` — the user's message (trimmed to 400 chars).
/// * `max_results` — how many results to return (1–10).
/// * `profile` — `simple` (default) | `news` | `research`.
/// * `site` — optional domain filter (e.g. "booking.com").
/// * `time_range` — optional recency filter: day | week | month | year.
///
/// Never returns an Err that blocks chat: failures produce empty results.
#[tauri::command]
pub async fn web_search(
    app: AppHandle,
    query: String,
    max_results: u32,
    profile: Option<String>,
    site: Option<String>,
    time_range: Option<String>,
) -> Result<WebSearchResult, String> {
    let refined = refine_search_query(&query);
    let trimmed_query = truncate_chars(&refined, 400);
    let n = (max_results.min(10)).max(1);
    let profile = match profile.as_deref() {
        Some("news") => "news",
        Some("research") => "research",
        _ => "simple",
    };

    log::info!("[web_search] query={trimmed_query:?} profile={profile} max={n}");

    let dir = match app_data_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[web_search] {e}");
            return Ok(WebSearchResult { query: trimmed_query, ..Default::default() });
        }
    };

    let mut body = serde_json::json!({
        "query": trimmed_query,
        "profile": profile,
        "maxResults": n,
    });
    if let Some(s) = site.filter(|s| !s.trim().is_empty()) {
        body["site"] = serde_json::Value::String(s.trim().to_string());
    }
    if let Some(t) = time_range {
        if matches!(t.as_str(), "day" | "week" | "month" | "year") {
            body["timeRange"] = serde_json::Value::String(t);
        }
    }

    let response = match crate::cloud::client::search_web(&dir, body).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[web_search] Backend search failed (soft): {e}");
            return Ok(WebSearchResult { query: trimmed_query, ..Default::default() });
        }
    };

    let answer = str_field(&response, "answer");
    let gallery: Vec<String> = string_array(response.get("images"))
        .into_iter()
        .take(MAX_GALLERY_IMAGES)
        .collect();

    let mut results: Vec<SearchHit> = Vec::new();
    // (text, url, title) triples used for table extraction — includes full raw
    // content even though the context excerpt may be shorter.
    let mut table_sources: Vec<(String, String, String)> = Vec::new();

    if let Some(items) = response.get("results").and_then(|v| v.as_array()) {
        for item in items {
            let title = str_field(item, "title").unwrap_or_default();
            let url = str_field(item, "url").unwrap_or_default();
            if title.is_empty() || url.is_empty() {
                continue;
            }

            let snippet = str_field(item, "snippet").unwrap_or_default();
            let raw_content = str_field(item, "rawContent");
            let images = string_array(item.get("images"));

            // Research profile carries full markdown content: use it as the
            // excerpt (bounded); otherwise keep the reranked snippet chunks.
            let excerpt = match raw_content {
                Some(ref raw) => truncate_chars(raw, FULL_CONTENT_CHAR_LIMIT),
                None => truncate_chars(&snippet, SNIPPET_CHAR_LIMIT),
            };

            if let Some(ref raw) = raw_content {
                table_sources.push((raw.clone(), url.clone(), title.clone()));
            } else if !snippet.is_empty() {
                table_sources.push((snippet.clone(), url.clone(), title.clone()));
            }

            results.push(SearchHit {
                title,
                snippet: excerpt,
                url,
                image_url: images.first().cloned(),
                favicon: str_field(item, "favicon"),
                score: item.get("score").and_then(|v| v.as_f64()),
                published_date: str_field(item, "publishedDate"),
            });
        }
    }

    let row_limit = extract_row_limit(&trimmed_query);
    let candidate_tables = collect_tables(&table_sources);
    let extracted_tables: Vec<ExtractedWebTable> =
        match select_best_table(candidate_tables, &trimmed_query, row_limit) {
        Some(table) => vec![table],
        None => Vec::new(),
    };

    let mut formatted_context = format_context(&results, answer.as_deref());
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
        answer,
        images: gallery,
    })
}

/// Extract clean markdown content from specific URLs via the backend proxy.
///
/// * `urls` — up to 5 URLs to read.
/// * `query` — optional intent used to rerank extracted chunks.
/// * `depth` — `basic` (default) | `advanced` (tables/embedded content).
///
/// Never returns an Err that blocks chat: failures produce empty results.
#[tauri::command]
pub async fn web_extract(
    app: AppHandle,
    urls: Vec<String>,
    query: Option<String>,
    depth: Option<String>,
) -> Result<WebExtractResult, String> {
    let urls: Vec<String> = urls
        .into_iter()
        .map(|u| u.trim().to_string())
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .take(5)
        .collect();

    if urls.is_empty() {
        return Ok(WebExtractResult::default());
    }

    log::info!("[web_extract] urls={} depth={:?}", urls.len(), depth);

    let dir = match app_data_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[web_extract] {e}");
            return Ok(WebExtractResult::default());
        }
    };

    let mut body = serde_json::json!({
        "urls": urls,
        "depth": match depth.as_deref() {
            Some("advanced") => "advanced",
            _ => "basic",
        },
    });
    if let Some(q) = query.as_ref().filter(|q| !q.trim().is_empty()) {
        body["query"] = serde_json::Value::String(truncate_chars(q.trim(), 400));
    }

    let response = match crate::cloud::client::extract_web(&dir, body).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[web_extract] Backend extract failed (soft): {e}");
            return Ok(WebExtractResult::default());
        }
    };

    let mut results: Vec<ExtractedPage> = Vec::new();
    let mut table_sources: Vec<(String, String, String)> = Vec::new();

    if let Some(items) = response.get("results").and_then(|v| v.as_array()) {
        for item in items {
            let url = str_field(item, "url").unwrap_or_default();
            let content = str_field(item, "content").unwrap_or_default();
            if url.is_empty() || content.is_empty() {
                continue;
            }

            table_sources.push((content.clone(), url.clone(), host_from_url(&url)));
            results.push(ExtractedPage {
                url,
                content: truncate_chars(&content, FULL_CONTENT_CHAR_LIMIT * 2),
                images: string_array(item.get("images")),
            });
        }
    }

    let failed = string_array(response.get("failed"));

    let query_for_tables = query.as_deref().unwrap_or("");
    let row_limit = extract_row_limit(query_for_tables);
    let candidate_tables = collect_tables(&table_sources);
    let extracted_tables: Vec<ExtractedWebTable> =
        match select_best_table(candidate_tables, query_for_tables, row_limit) {
            Some(table) => vec![table],
            None => Vec::new(),
        };

    let mut formatted_context = String::new();
    if !results.is_empty() {
        formatted_context.push_str(
            "FULL PAGE CONTENT — extracted from the URLs below. Use ONLY facts stated here.\n\
             Cite the source URL when stating a fact.\n",
        );
        for (i, page) in results.iter().enumerate() {
            formatted_context.push_str(&format!(
                "\n[{}] {}\nContent:\n{}\n",
                i + 1,
                page.url,
                page.content.trim()
            ));
        }
        formatted_context.push_str("\n--- End of extracted pages ---\n");
    }
    if let Some(table) = extracted_tables.first() {
        let table_block = format!(
            "AUTHORITATIVE DATA TABLE — use these EXACT values in WRITE_DATA (do not invent, round, or modify):\n\n{}\n",
            table_to_markdown(table)
        );
        formatted_context = format!("{table_block}\n{formatted_context}");
    }

    Ok(WebExtractResult {
        results,
        formatted_context,
        extracted_tables,
        failed,
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
    fn host_parsing() {
        assert_eq!(
            host_from_url("https://www.wikipedia.org/wiki/Spain"),
            "wikipedia.org"
        );
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        assert_eq!(truncate_chars("héllo wörld", 5), "héllo");
    }

    #[test]
    fn string_array_filters_non_urls() {
        let v = serde_json::json!(["https://a.com/x.png", "not-a-url"]);
        assert_eq!(string_array(Some(&v)), vec!["https://a.com/x.png"]);
    }
}
