//! Connector provider backends.
//!
//! Register implementations in [`register_all`]. Catalog entries in
//! `config/connectors.toml` control UI visibility; backends enable ops.
//!
//! ## Adding a connector
//! 1. Add `[[connector]]` in `src-tauri/src/config/connectors.toml`
//! 2. For `status = "available"`: add `providers/<id>.rs` + register below
//! 3. For `status = "coming_soon"`: TOML only — no Rust needed

pub mod dropbox;
pub mod gdrive;
pub mod gmail_backend;
pub mod local;
pub mod onedrive;

use crate::connectors::backend::{register_backend, ConnectorBackend};
use crate::connectors::error::ConnectorError;
use crate::connectors::types::{ConnectionId, RemoteEntry, RemoteId, SyncReport};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::sync::Arc;

struct GDriveBackend;

fn open_url(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "We couldn't open your browser. Please try again.".to_string())
}

const GDRIVE_SCOPES: &str = "openid email profile \
https://www.googleapis.com/auth/drive.readonly \
https://www.googleapis.com/auth/drive.file";

#[async_trait]
impl ConnectorBackend for GDriveBackend {
    fn id(&self) -> &'static str {
        "gdrive"
    }

    async fn connect_account(
        &self,
        app: &tauri::AppHandle,
    ) -> Result<crate::connectors::types::ConnectionInfo, ConnectorError> {
        use tauri::Manager;
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| ConnectorError::io(e.to_string()))?;
        std::fs::create_dir_all(&dir).map_err(|e| ConnectorError::io(e.to_string()))?;

        let app_clone = app.clone();
        let tokens = crate::connectors::desktop_pkce::authorize(
            move |url| open_url(&app_clone, url),
            GDRIVE_SCOPES,
            "Google Drive",
        )
        .await
        .map_err(ConnectorError::invalid)?;

        let connection_id = uuid::Uuid::new_v4().to_string();
        let display = tokens
            .name
            .clone()
            .or_else(|| tokens.email.clone())
            .unwrap_or_else(|| "Google Drive".into());
        let scopes = tokens
            .scope
            .map(|s| {
                s.split_whitespace()
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        gdrive::store_new_connection(
            &dir,
            &connection_id,
            tokens.email,
            display,
            tokens.access_token,
            tokens.refresh_token,
            tokens.expires_in,
            scopes,
        )
        .map_err(ConnectorError::io)
    }

    async fn list_children(
        &self,
        app_data: &Path,
        conn: &ConnectionId,
        parent: Option<&RemoteId>,
    ) -> Result<Vec<RemoteEntry>, ConnectorError> {
        gdrive::list_children(app_data, conn, parent).await
    }

    async fn sync_folder(
        &self,
        app_data: &Path,
        conn: &ConnectionId,
        remote_folder: Option<&RemoteId>,
    ) -> Result<SyncReport, ConnectorError> {
        gdrive::sync_folder(app_data, conn, remote_folder).await
    }

    async fn fetch_file(
        &self,
        app_data: &Path,
        conn: &ConnectionId,
        id: &RemoteId,
    ) -> Result<PathBuf, ConnectorError> {
        gdrive::fetch_file(app_data, conn, id).await
    }

    async fn create_file(
        &self,
        app_data: &Path,
        conn: &ConnectionId,
        parent: Option<&RemoteId>,
        name: &str,
        bytes: &[u8],
        mime: Option<&str>,
    ) -> Result<RemoteEntry, ConnectorError> {
        gdrive::create_file(app_data, conn, parent, name, bytes, mime).await
    }

    async fn update_file(
        &self,
        app_data: &Path,
        conn: &ConnectionId,
        id: &RemoteId,
        bytes: &[u8],
    ) -> Result<RemoteEntry, ConnectorError> {
        gdrive::update_file(app_data, conn, id, bytes).await
    }
}

/// Wire every implemented backend. Coming-soon catalog entries need no registration.
pub fn register_all() {
    register_backend(Arc::new(GDriveBackend));
    register_backend(Arc::new(gmail_backend::GmailBackend));
    let _ = (
        dropbox::PROVIDER_ID,
        onedrive::PROVIDER_ID,
        local::PROVIDER_ID,
    );
}
