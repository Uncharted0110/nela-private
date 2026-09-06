//! Persisted connector connection metadata (no secrets).

use crate::connectors::types::{ConnectionId, ConnectionInfo, ConnectionStatus};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const CONNECTIONS_FILE: &str = "connections.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ConnectionsFile {
    connections: Vec<ConnectionInfo>,
}

fn path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("connectors").join(CONNECTIONS_FILE)
}

fn read(app_data_dir: &Path) -> Result<ConnectionsFile, String> {
    let p = path(app_data_dir);
    if !p.exists() {
        return Ok(ConnectionsFile::default());
    }
    let raw = std::fs::read_to_string(&p)
        .map_err(|_| "Couldn't read connector connections.".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "Couldn't parse connector connections.".to_string())
}

fn write(app_data_dir: &Path, store: &ConnectionsFile) -> Result<(), String> {
    let dir = app_data_dir.join("connectors");
    std::fs::create_dir_all(&dir).map_err(|_| "Couldn't save connector connections.".to_string())?;
    let raw = serde_json::to_string_pretty(store)
        .map_err(|_| "Couldn't save connector connections.".to_string())?;
    std::fs::write(path(app_data_dir), raw)
        .map_err(|_| "Couldn't save connector connections.".to_string())?;
    Ok(())
}

pub fn list(app_data_dir: &Path) -> Result<Vec<ConnectionInfo>, String> {
    Ok(read(app_data_dir)?.connections)
}

pub fn get(app_data_dir: &Path, id: &ConnectionId) -> Result<Option<ConnectionInfo>, String> {
    Ok(read(app_data_dir)?
        .connections
        .into_iter()
        .find(|c| c.id == *id))
}

pub fn upsert(app_data_dir: &Path, info: ConnectionInfo) -> Result<(), String> {
    let mut store = read(app_data_dir)?;
    if let Some(existing) = store.connections.iter_mut().find(|c| c.id == info.id) {
        *existing = info;
    } else {
        store.connections.push(info);
    }
    write(app_data_dir, &store)
}

pub fn remove(app_data_dir: &Path, id: &ConnectionId) -> Result<(), String> {
    let mut store = read(app_data_dir)?;
    store.connections.retain(|c| c.id != *id);
    write(app_data_dir, &store)
}

pub fn set_status(
    app_data_dir: &Path,
    id: &ConnectionId,
    status: ConnectionStatus,
) -> Result<(), String> {
    let mut store = read(app_data_dir)?;
    if let Some(c) = store.connections.iter_mut().find(|c| c.id == *id) {
        c.status = status;
    }
    write(app_data_dir, &store)
}
