use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct RemoteId(pub String);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct ConnectionId(pub String);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Folder,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub id: RemoteId,
    pub name: String,
    pub kind: EntryKind,
    pub mime_type: Option<String>,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub mirror_root: PathBuf,
    pub fetched: usize,
    pub updated: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStatus {
    Connected,
    NeedsReauth,
    Syncing,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: ConnectionId,
    pub provider_id: String,
    pub display_name: String,
    pub account_email: Option<String>,
    pub remote_folder_id: Option<String>,
    pub remote_folder_name: Option<String>,
    pub mirror_root: Option<String>,
    pub last_sync_at: Option<String>,
    pub status: ConnectionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub display_name: String,
    pub available: bool,
    pub coming_soon: bool,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub show_in_attach_menu: bool,
    #[serde(default)]
    pub auth_kind: String,
    #[serde(default)]
    pub connect_flow: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorIndexedRoot {
    pub connection_id: ConnectionId,
    pub provider_id: String,
    pub label: String,
    pub mirror_root: String,
    pub last_sync_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartResponse {
    pub session_id: String,
    pub auth_url: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "status")]
pub enum OAuthPollResult {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "expired")]
    Expired,
    #[serde(rename = "denied")]
    Denied,
    #[serde(rename = "approved")]
    Approved {
        connection: ConnectionInfo,
    },
}
