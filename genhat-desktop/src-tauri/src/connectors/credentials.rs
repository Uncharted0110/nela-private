//! Connector credential store (separate from NELA Cloud tokens).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const CREDENTIALS_FILE: &str = "credentials.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredential {
    pub refresh_token: String,
    pub access_token: Option<String>,
    pub expires_at_epoch_ms: Option<i64>,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CredentialsFile {
    /// connection_id → credential
    connections: HashMap<String, StoredCredential>,
}

fn credentials_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("connectors").join(CREDENTIALS_FILE)
}

fn read_file(app_data_dir: &Path) -> Result<CredentialsFile, String> {
    let path = credentials_path(app_data_dir);
    if !path.exists() {
        return Ok(CredentialsFile::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| "Couldn't read connector credentials.".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "Couldn't parse connector credentials.".to_string())
}

fn write_file(app_data_dir: &Path, store: &CredentialsFile) -> Result<(), String> {
    let dir = app_data_dir.join("connectors");
    std::fs::create_dir_all(&dir).map_err(|_| "Couldn't save connector credentials.".to_string())?;
    let path = credentials_path(app_data_dir);
    let raw = serde_json::to_string_pretty(store)
        .map_err(|_| "Couldn't save connector credentials.".to_string())?;
    std::fs::write(&path, raw).map_err(|_| "Couldn't save connector credentials.".to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn get(app_data_dir: &Path, connection_id: &str) -> Result<Option<StoredCredential>, String> {
    Ok(read_file(app_data_dir)?.connections.get(connection_id).cloned())
}

pub fn save(
    app_data_dir: &Path,
    connection_id: &str,
    credential: StoredCredential,
) -> Result<(), String> {
    let mut store = read_file(app_data_dir)?;
    store
        .connections
        .insert(connection_id.to_string(), credential);
    write_file(app_data_dir, &store)
}

pub fn remove(app_data_dir: &Path, connection_id: &str) -> Result<(), String> {
    let mut store = read_file(app_data_dir)?;
    store.connections.remove(connection_id);
    write_file(app_data_dir, &store)
}

pub fn update_access_token(
    app_data_dir: &Path,
    connection_id: &str,
    access_token: &str,
    expires_at_epoch_ms: Option<i64>,
) -> Result<(), String> {
    let mut store = read_file(app_data_dir)?;
    let entry = store
        .connections
        .get_mut(connection_id)
        .ok_or_else(|| "Connector credentials not found.".to_string())?;
    entry.access_token = Some(access_token.to_string());
    entry.expires_at_epoch_ms = expires_at_epoch_ms;
    write_file(app_data_dir, &store)
}
