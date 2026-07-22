//! NELA Cloud token storage.
//!
//! Access tokens live in memory only.
//! Refresh tokens are written to `{app_data}/nela_cloud_tokens.json`.
//! Prefer OS secure storage (keyring) when available in a future iteration.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const TOKEN_FILE: &str = "nela_cloud_tokens.json";

static ACCESS_TOKEN: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredCloudTokens {
    /// NELA Cloud refresh token only — never Google / provider secrets.
    refresh_token: Option<String>,
}

fn token_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(TOKEN_FILE)
}

fn read_store(app_data_dir: &Path) -> Result<StoredCloudTokens, String> {
    let path = token_path(app_data_dir);
    if !path.exists() {
        return Ok(StoredCloudTokens::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read cloud tokens: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse cloud tokens: {e}"))
}

fn write_store(app_data_dir: &Path, store: &StoredCloudTokens) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;
    let path = token_path(app_data_dir);
    let raw = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize cloud tokens: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("Failed to write cloud tokens: {e}"))?;

    // Restrictive permissions on Unix; Windows ACLs are left to the OS user profile.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

pub fn get_access_token() -> Option<String> {
    ACCESS_TOKEN.lock().ok()?.clone()
}

pub fn set_access_token(token: Option<String>) {
    if let Ok(mut guard) = ACCESS_TOKEN.lock() {
        *guard = token;
    }
}

pub fn get_refresh_token(app_data_dir: &Path) -> Result<Option<String>, String> {
    Ok(read_store(app_data_dir)?.refresh_token)
}

pub fn save_tokens(
    app_data_dir: &Path,
    access_token: &str,
    refresh_token: &str,
) -> Result<(), String> {
    set_access_token(Some(access_token.to_string()));
    write_store(
        app_data_dir,
        &StoredCloudTokens {
            refresh_token: Some(refresh_token.to_string()),
        },
    )
}

pub fn update_refresh_token(app_data_dir: &Path, refresh_token: &str) -> Result<(), String> {
    let mut store = read_store(app_data_dir)?;
    store.refresh_token = Some(refresh_token.to_string());
    write_store(app_data_dir, &store)
}

pub fn clear_tokens(app_data_dir: &Path) -> Result<(), String> {
    set_access_token(None);
    let path = token_path(app_data_dir);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to remove cloud tokens: {e}"))?;
    }
    Ok(())
}
