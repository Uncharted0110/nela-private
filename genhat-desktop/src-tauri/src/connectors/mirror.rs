//! Local mirror trees registered as File Indexer roots.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MirrorMeta {
    pub connection_id: String,
    pub provider_id: String,
    pub remote_folder_id: Option<String>,
    pub remote_folder_name: Option<String>,
    pub sync_cursor: Option<String>,
    pub last_sync_at: Option<String>,
}

pub fn mirrors_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("connectors").join("mirrors")
}

pub fn mirror_dir(app_data_dir: &Path, connection_id: &str) -> PathBuf {
    mirrors_root(app_data_dir).join(connection_id)
}

pub fn ensure_mirror(app_data_dir: &Path, connection_id: &str) -> Result<PathBuf, String> {
    let dir = mirror_dir(app_data_dir, connection_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create mirror folder: {e}"))?;
    Ok(dir)
}

fn meta_path(mirror: &Path) -> PathBuf {
    mirror.join(".nela-connector.json")
}

pub fn read_meta(mirror: &Path) -> Result<MirrorMeta, String> {
    let p = meta_path(mirror);
    if !p.exists() {
        return Ok(MirrorMeta::default());
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub fn write_meta(mirror: &Path, meta: &MirrorMeta) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(meta_path(mirror), raw).map_err(|e| e.to_string())
}

/// Sanitize a remote file id for use as a path segment.
pub fn safe_segment(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn wipe_mirror(app_data_dir: &Path, connection_id: &str) -> Result<(), String> {
    let dir = mirror_dir(app_data_dir, connection_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("Couldn't remove mirror: {e}"))?;
    }
    Ok(())
}

/// Write bytes under mirror_root/relative_path, creating parents.
pub fn write_file(mirror_root: &Path, relative: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let path = mirror_root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}
