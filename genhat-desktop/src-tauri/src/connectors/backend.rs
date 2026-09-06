//! Pluggable connector backends. Register one per `id` in `connectors.toml`.

use crate::connectors::error::ConnectorError;
use crate::connectors::types::{ConnectionId, ConnectionInfo, RemoteEntry, RemoteId, SyncReport};
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use tauri::AppHandle;

#[async_trait]
pub trait ConnectorBackend: Send + Sync {
    fn id(&self) -> &'static str;

    /// Account connect for `connect_flow = "desktop_pkce"` (and similar).
    /// Default: not supported (use cloud OAuth broker instead).
    async fn connect_account(
        &self,
        _app: &AppHandle,
    ) -> Result<ConnectionInfo, ConnectorError> {
        Err(ConnectorError::invalid(
            "This connector signs in through the cloud OAuth broker.",
        ))
    }

    /// Optional live account status (e.g. Gmail PKCE tokens on disk).
    fn account_status(
        &self,
        _app: &AppHandle,
    ) -> Result<Option<ConnectionInfo>, ConnectorError> {
        Ok(None)
    }

    /// Disconnect account credentials for this provider.
    async fn disconnect_account(
        &self,
        _app: &AppHandle,
    ) -> Result<(), ConnectorError> {
        Ok(())
    }

    async fn list_children(
        &self,
        app_data: &Path,
        conn: &ConnectionId,
        parent: Option<&RemoteId>,
    ) -> Result<Vec<RemoteEntry>, ConnectorError>;

    async fn sync_folder(
        &self,
        app_data: &Path,
        conn: &ConnectionId,
        remote_folder: Option<&RemoteId>,
    ) -> Result<SyncReport, ConnectorError>;

    async fn fetch_file(
        &self,
        app_data: &Path,
        conn: &ConnectionId,
        id: &RemoteId,
    ) -> Result<PathBuf, ConnectorError>;

    async fn create_file(
        &self,
        app_data: &Path,
        conn: &ConnectionId,
        parent: Option<&RemoteId>,
        name: &str,
        bytes: &[u8],
        mime: Option<&str>,
    ) -> Result<RemoteEntry, ConnectorError>;

    async fn update_file(
        &self,
        app_data: &Path,
        conn: &ConnectionId,
        id: &RemoteId,
        bytes: &[u8],
    ) -> Result<RemoteEntry, ConnectorError>;
}

static BACKENDS: OnceLock<RwLock<HashMap<&'static str, Arc<dyn ConnectorBackend>>>> =
    OnceLock::new();

fn map() -> &'static RwLock<HashMap<&'static str, Arc<dyn ConnectorBackend>>> {
    BACKENDS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Register a backend implementation. Call from `providers::register_all`.
pub fn register_backend(backend: Arc<dyn ConnectorBackend>) {
    let id = backend.id();
    if let Ok(mut guard) = map().write() {
        guard.insert(id, backend);
    }
}

pub fn get_backend(id: &str) -> Option<Arc<dyn ConnectorBackend>> {
    map().read().ok()?.get(id).cloned()
}

pub fn has_backend(id: &str) -> bool {
    map()
        .read()
        .ok()
        .map(|g| g.contains_key(id))
        .unwrap_or(false)
}

/// Stub backend used for registered-but-unimplemented ids (optional).
pub struct ComingSoonBackend {
    pub id: &'static str,
    pub label: &'static str,
}

#[async_trait]
impl ConnectorBackend for ComingSoonBackend {
    fn id(&self) -> &'static str {
        self.id
    }

    async fn list_children(
        &self,
        _app_data: &Path,
        _conn: &ConnectionId,
        _parent: Option<&RemoteId>,
    ) -> Result<Vec<RemoteEntry>, ConnectorError> {
        Err(ConnectorError::not_implemented(self.label))
    }

    async fn sync_folder(
        &self,
        _app_data: &Path,
        _conn: &ConnectionId,
        _remote_folder: Option<&RemoteId>,
    ) -> Result<SyncReport, ConnectorError> {
        Err(ConnectorError::not_implemented(self.label))
    }

    async fn fetch_file(
        &self,
        _app_data: &Path,
        _conn: &ConnectionId,
        _id: &RemoteId,
    ) -> Result<PathBuf, ConnectorError> {
        Err(ConnectorError::not_implemented(self.label))
    }

    async fn create_file(
        &self,
        _app_data: &Path,
        _conn: &ConnectionId,
        _parent: Option<&RemoteId>,
        _name: &str,
        _bytes: &[u8],
        _mime: Option<&str>,
    ) -> Result<RemoteEntry, ConnectorError> {
        Err(ConnectorError::not_implemented(self.label))
    }

    async fn update_file(
        &self,
        _app_data: &Path,
        _conn: &ConnectionId,
        _id: &RemoteId,
        _bytes: &[u8],
    ) -> Result<RemoteEntry, ConnectorError> {
        Err(ConnectorError::not_implemented(self.label))
    }
}
