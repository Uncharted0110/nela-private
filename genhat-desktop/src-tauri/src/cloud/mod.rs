//! NELA Cloud client: auth, billing, entitlements, and inference API access.
//!
//! Desktop stores only the NELA Cloud refresh token (file) and access token (memory).
//! Google / Razorpay / OpenRouter secrets must never live here.

pub mod client;
pub mod profile_cache;
pub mod token_store;
pub mod types;

use std::sync::RwLock;
use std::time::Duration;

/// Production API (Render). Used unless `NELA_CLOUD_API_BASE_URL` is set.
pub const DEFAULT_API_BASE_URL: &str = "https://nela-backend.onrender.com";
/// Production website (Vercel). Used unless `NELA_CLOUD_WEB_BASE_URL` is set.
pub const DEFAULT_WEB_BASE_URL: &str = "https://nela-webpage.vercel.app";
/// Local API fallback when production is unreachable.
pub const LOCAL_API_BASE_URL: &str = "http://localhost:3001";
/// Local website fallback when production is unreachable.
pub const LOCAL_WEB_BASE_URL: &str = "http://localhost:3000";

static RESOLVED_API: RwLock<Option<String>> = RwLock::new(None);
static RESOLVED_WEB: RwLock<Option<String>> = RwLock::new(None);

/// Load dotenv files without overriding already-set process env vars.
pub fn load_dotenv_files() {
    for path in [
        std::path::PathBuf::from(".env"),
        std::path::PathBuf::from("../.env"),
    ] {
        if path.is_file() {
            let _ = dotenvy::from_path(&path);
        }
    }
    let _ = dotenvy::dotenv();
}

fn trim_base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn env_api_override() -> Option<String> {
    load_dotenv_files();
    std::env::var("NELA_CLOUD_API_BASE_URL")
        .ok()
        .map(|s| trim_base(&s))
        .filter(|s| !s.is_empty())
}

fn env_web_override() -> Option<String> {
    load_dotenv_files();
    std::env::var("NELA_CLOUD_WEB_BASE_URL")
        .ok()
        .map(|s| trim_base(&s))
        .filter(|s| !s.is_empty())
}

/// Cached or preferred NELA Cloud API base URL (sync).
/// Prefer calling [`resolve_api_base_url`] before the first request so production
/// vs localhost has been probed when no env override is set.
pub fn api_base_url() -> String {
    if let Some(url) = env_api_override() {
        return url;
    }
    if let Ok(guard) = RESOLVED_API.read() {
        if let Some(url) = guard.as_ref() {
            return url.clone();
        }
    }
    DEFAULT_API_BASE_URL.to_string()
}

/// Cached or preferred NELA Cloud web base URL (sync).
pub fn web_base_url() -> String {
    if let Some(url) = env_web_override() {
        return url;
    }
    if let Ok(guard) = RESOLVED_WEB.read() {
        if let Some(url) = guard.as_ref() {
            return url.clone();
        }
    }
    DEFAULT_WEB_BASE_URL.to_string()
}

fn remember_endpoints(api: &str, web: &str) {
    if let Ok(mut guard) = RESOLVED_API.write() {
        *guard = Some(api.to_string());
    }
    if let Ok(mut guard) = RESOLVED_WEB.write() {
        *guard = Some(web.to_string());
    }
}

async fn probe_health(base: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
    else {
        return false;
    };
    let url = format!("{}/healthz", base.trim_end_matches('/'));
    match client.get(&url).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Resolve which API to use: env override → production → localhost fallback.
/// Result is cached for the process lifetime.
pub async fn resolve_api_base_url() -> String {
    if let Some(url) = env_api_override() {
        let web = env_web_override().unwrap_or_else(|| {
            if url.contains("localhost") || url.contains("127.0.0.1") {
                LOCAL_WEB_BASE_URL.to_string()
            } else {
                DEFAULT_WEB_BASE_URL.to_string()
            }
        });
        remember_endpoints(&url, &web);
        return url;
    }

    if let Ok(guard) = RESOLVED_API.read() {
        if let Some(url) = guard.as_ref() {
            return url.clone();
        }
    }

    if probe_health(DEFAULT_API_BASE_URL).await {
        remember_endpoints(DEFAULT_API_BASE_URL, DEFAULT_WEB_BASE_URL);
        return DEFAULT_API_BASE_URL.to_string();
    }

    if probe_health(LOCAL_API_BASE_URL).await {
        remember_endpoints(LOCAL_API_BASE_URL, LOCAL_WEB_BASE_URL);
        return LOCAL_API_BASE_URL.to_string();
    }

    // Neither answered — still prefer production for the actual request
    // (Render cold starts can miss the short probe window).
    remember_endpoints(DEFAULT_API_BASE_URL, DEFAULT_WEB_BASE_URL);
    DEFAULT_API_BASE_URL.to_string()
}

/// After a transport failure against the current base, try the other endpoint once.
pub async fn fallback_api_base_url(failed_base: &str) -> Option<String> {
    if env_api_override().is_some() {
        return None;
    }
    let failed = trim_base(failed_base);
    let alternate = if failed == LOCAL_API_BASE_URL || failed.contains("localhost") {
        DEFAULT_API_BASE_URL
    } else {
        LOCAL_API_BASE_URL
    };
    if !probe_health(alternate).await {
        return None;
    }
    let web = if alternate == LOCAL_API_BASE_URL {
        LOCAL_WEB_BASE_URL
    } else {
        DEFAULT_WEB_BASE_URL
    };
    remember_endpoints(alternate, web);
    Some(alternate.to_string())
}
