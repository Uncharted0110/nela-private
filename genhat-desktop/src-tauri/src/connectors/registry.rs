use crate::connectors::backend::{get_backend, has_backend, register_backend, ComingSoonBackend};
use crate::connectors::catalog::{self, ConnectorStatus};
use crate::connectors::types::{
    ConnectionId, ProviderInfo, RemoteEntry, RemoteId, SyncReport,
};
use crate::connectors::ConnectorError;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Once};

static INIT: Once = Once::new();

pub struct Registry;

impl Registry {
    /// Ensure backends from `providers::register_all` are loaded once.
    pub fn ensure_initialized() {
        INIT.call_once(|| {
            crate::connectors::providers::register_all();
        });
    }

    /// Providers visible in the UI — driven by `connectors.toml`, gated by backends.
    pub fn list_providers() -> Vec<ProviderInfo> {
        Self::ensure_initialized();
        catalog::catalog_or_empty()
            .iter()
            .filter(|d| d.status != ConnectorStatus::Disabled)
            .map(|d| {
                let backend_ready = has_backend(&d.id);
                let available =
                    d.status == ConnectorStatus::Available && backend_ready;
                let coming_soon = !available;
                ProviderInfo {
                    id: d.id.clone(),
                    display_name: d.display_name.clone(),
                    available,
                    coming_soon,
                    category: d.category.clone(),
                    description: d.description.clone(),
                    capabilities: d.capabilities.clone(),
                    show_in_attach_menu: d.show_in_attach_menu,
                    auth_kind: d.auth_kind.clone(),
                    connect_flow: d.connect_flow.clone(),
                }
            })
            .collect()
    }

    async fn backend(provider_id: &str) -> Result<Arc<dyn crate::connectors::backend::ConnectorBackend>, ConnectorError> {
        Self::ensure_initialized();
        get_backend(provider_id).ok_or_else(|| {
            let label = catalog::find_definition(provider_id)
                .map(|d| d.display_name.as_str())
                .unwrap_or(provider_id);
            ConnectorError::not_implemented(label)
        })
    }

    pub async fn list_children(
        provider_id: &str,
        app_data: &Path,
        conn: &ConnectionId,
        parent: Option<&RemoteId>,
    ) -> Result<Vec<RemoteEntry>, ConnectorError> {
        Self::backend(provider_id)
            .await?
            .list_children(app_data, conn, parent)
            .await
    }

    pub async fn sync_folder(
        provider_id: &str,
        app_data: &Path,
        conn: &ConnectionId,
        remote_folder: Option<&RemoteId>,
    ) -> Result<SyncReport, ConnectorError> {
        Self::backend(provider_id)
            .await?
            .sync_folder(app_data, conn, remote_folder)
            .await
    }

    pub async fn fetch_file(
        provider_id: &str,
        app_data: &Path,
        conn: &ConnectionId,
        id: &RemoteId,
    ) -> Result<PathBuf, ConnectorError> {
        Self::backend(provider_id)
            .await?
            .fetch_file(app_data, conn, id)
            .await
    }

    pub async fn create_file(
        provider_id: &str,
        app_data: &Path,
        conn: &ConnectionId,
        parent: Option<&RemoteId>,
        name: &str,
        bytes: &[u8],
        mime: Option<&str>,
    ) -> Result<RemoteEntry, ConnectorError> {
        Self::backend(provider_id)
            .await?
            .create_file(app_data, conn, parent, name, bytes, mime)
            .await
    }

    pub async fn update_file(
        provider_id: &str,
        app_data: &Path,
        conn: &ConnectionId,
        id: &RemoteId,
        bytes: &[u8],
    ) -> Result<RemoteEntry, ConnectorError> {
        Self::backend(provider_id)
            .await?
            .update_file(app_data, conn, id, bytes)
            .await
    }
}

/// Helper for optional stub registration from catalog (unused by default).
#[allow(dead_code)]
pub fn register_coming_soon(id: &'static str, label: &'static str) {
    register_backend(Arc::new(ComingSoonBackend { id, label }));
}
