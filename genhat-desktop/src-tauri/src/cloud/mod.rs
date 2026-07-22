//! NELA Cloud client: auth, billing, entitlements, and inference API access.
//!
//! Desktop stores only the NELA Cloud refresh token (file) and access token (memory).
//! Google / Razorpay / OpenRouter secrets must never live here.

pub mod client;
pub mod profile_cache;
pub mod token_store;
pub mod types;

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

/// NELA Cloud API base URL (`NELA_CLOUD_API_BASE_URL`, default `http://localhost:3001`).
pub fn api_base_url() -> String {
    load_dotenv_files();
    std::env::var("NELA_CLOUD_API_BASE_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "http://localhost:3001".to_string())
}

/// NELA Cloud web base URL (`NELA_CLOUD_WEB_BASE_URL`, default `http://localhost:3000`).
/// Website login/account (Next.js), not the Tauri Vite UI on :5173.
pub fn web_base_url() -> String {
    load_dotenv_files();
    std::env::var("NELA_CLOUD_WEB_BASE_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "http://localhost:3000".to_string())
}
