//! Gmail adapter for the connector registry.
//!
//! Auth uses desktop PKCE (`connectors::gmail`). File-mirror ops are N/A;
//! chat send still goes through `gmail_send`.

use crate::connectors::backend::ConnectorBackend;
use crate::connectors::error::ConnectorError;
use crate::connectors::gmail::{self, GmailStatus};
use crate::connectors::types::{
    ConnectionId, ConnectionInfo, ConnectionStatus, RemoteEntry, RemoteId, SyncReport,
};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

pub struct GmailBackend;

fn bind_app_data(app: &AppHandle) -> Result<(), ConnectorError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| ConnectorError::io(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| ConnectorError::io(e.to_string()))?;
    gmail::set_app_data_dir(dir);
    Ok(())
}

fn open_url(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "We couldn't open your browser. Please try again.".to_string())
}

fn status_to_connection(status: GmailStatus) -> Option<ConnectionInfo> {
    if !status.connected {
        return None;
    }
    Some(ConnectionInfo {
        id: ConnectionId("gmail".into()),
        provider_id: "gmail".into(),
        display_name: "Gmail".into(),
        account_email: status.email,
        remote_folder_id: None,
        remote_folder_name: None,
        mirror_root: None,
        last_sync_at: None,
        status: ConnectionStatus::Connected,
    })
}

#[async_trait]
impl ConnectorBackend for GmailBackend {
    fn id(&self) -> &'static str {
        "gmail"
    }

    async fn connect_account(&self, app: &AppHandle) -> Result<ConnectionInfo, ConnectorError> {
        bind_app_data(app)?;
        let app_clone = app.clone();
        let status = gmail::connect(move |url| open_url(&app_clone, url))
            .await
            .map_err(ConnectorError::invalid)?;
        status_to_connection(status).ok_or_else(|| {
            ConnectorError::invalid("Gmail sign-in did not complete.".to_string())
        })
    }

    fn account_status(&self, app: &AppHandle) -> Result<Option<ConnectionInfo>, ConnectorError> {
        bind_app_data(app)?;
        let status = gmail::status().map_err(ConnectorError::io)?;
        Ok(status_to_connection(status))
    }

    async fn disconnect_account(&self, app: &AppHandle) -> Result<(), ConnectorError> {
        bind_app_data(app)?;
        gmail::disconnect()
            .await
            .map_err(ConnectorError::io)?;
        Ok(())
    }

    async fn list_children(
        &self,
        _app_data: &Path,
        _conn: &ConnectionId,
        _parent: Option<&RemoteId>,
    ) -> Result<Vec<RemoteEntry>, ConnectorError> {
        Err(ConnectorError::invalid(
            "Gmail does not browse folders. Use Connect to authorize send.",
        ))
    }

    async fn sync_folder(
        &self,
        _app_data: &Path,
        _conn: &ConnectionId,
        _remote_folder: Option<&RemoteId>,
    ) -> Result<SyncReport, ConnectorError> {
        Err(ConnectorError::invalid(
            "Gmail does not sync folders into File Indexer.",
        ))
    }

    async fn fetch_file(
        &self,
        _app_data: &Path,
        _conn: &ConnectionId,
        _id: &RemoteId,
    ) -> Result<PathBuf, ConnectorError> {
        Err(ConnectorError::invalid("Gmail does not fetch files."))
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
        Err(ConnectorError::invalid(
            "Gmail creates mail via send, not file upload.",
        ))
    }

    async fn update_file(
        &self,
        _app_data: &Path,
        _conn: &ConnectionId,
        _id: &RemoteId,
        _bytes: &[u8],
    ) -> Result<RemoteEntry, ConnectorError> {
        Err(ConnectorError::invalid("Gmail does not update files."))
    }
}
