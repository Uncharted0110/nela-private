use crate::connectors::error::ConnectorError;
use crate::connectors::types::{ConnectionId, RemoteEntry, RemoteId, SyncReport};
use std::path::Path;

pub const PROVIDER_ID: &str = "dropbox";

pub async fn list_children(
    _app_data: &Path,
    _conn: &ConnectionId,
    _parent: Option<&RemoteId>,
) -> Result<Vec<RemoteEntry>, ConnectorError> {
    Err(ConnectorError::not_implemented("Dropbox"))
}

pub async fn sync_folder(
    _app_data: &Path,
    _conn: &ConnectionId,
    _remote_folder: Option<&RemoteId>,
) -> Result<SyncReport, ConnectorError> {
    Err(ConnectorError::not_implemented("Dropbox"))
}

pub async fn fetch_file(
    _app_data: &Path,
    _conn: &ConnectionId,
    _id: &RemoteId,
) -> Result<std::path::PathBuf, ConnectorError> {
    Err(ConnectorError::not_implemented("Dropbox"))
}

pub async fn create_file(
    _app_data: &Path,
    _conn: &ConnectionId,
    _parent: Option<&RemoteId>,
    _name: &str,
    _bytes: &[u8],
    _mime: Option<&str>,
) -> Result<RemoteEntry, ConnectorError> {
    Err(ConnectorError::not_implemented("Dropbox"))
}

pub async fn update_file(
    _app_data: &Path,
    _conn: &ConnectionId,
    _id: &RemoteId,
    _bytes: &[u8],
) -> Result<RemoteEntry, ConnectorError> {
    Err(ConnectorError::not_implemented("Dropbox"))
}
