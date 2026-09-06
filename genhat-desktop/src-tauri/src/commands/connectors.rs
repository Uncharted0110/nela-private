//! Tauri IPC for cloud storage connectors (File Indexer–backed mirrors).

use crate::connectors::connections;
use crate::connectors::credentials;
use crate::connectors::fileindexer_bridge;
use crate::connectors::mirror;
use crate::connectors::oauth_client::{self, BrokerPollResponse};
use crate::connectors::providers::gdrive;
use crate::connectors::registry::Registry;
use crate::connectors::types::{
    ConnectionId, ConnectionInfo, ConnectorIndexedRoot, OAuthPollResult, OAuthStartResponse,
    ProviderInfo, RemoteEntry, RemoteId, SyncReport,
};
use crate::doc_graph::state::DocGraphState;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
}

fn connection_provider(app_data: &std::path::Path, id: &ConnectionId) -> Result<String, String> {
    connections::get(app_data, id)?
        .map(|c| c.provider_id)
        .ok_or_else(|| "Connection not found.".to_string())
}

#[tauri::command]
pub fn connectors_list_providers() -> Vec<ProviderInfo> {
    Registry::list_providers()
}

#[tauri::command]
pub fn connectors_list_connections(app: AppHandle) -> Result<Vec<ConnectionInfo>, String> {
    let dir = app_data(&app)?;
    let mut out = connections::list(&dir)?;

    // Merge live account status from desktop_pkce (and similar) backends.
    Registry::ensure_initialized();
    for provider in Registry::list_providers() {
        if provider.connect_flow != "desktop_pkce" {
            continue;
        }
        if let Some(backend) = crate::connectors::backend::get_backend(&provider.id) {
            if let Ok(Some(info)) = backend.account_status(&app) {
                out.retain(|c| c.provider_id != provider.id);
                out.insert(0, info);
            }
        }
    }
    Ok(out)
}

/// Connect a `desktop_pkce` (or similar) catalog provider via its registered backend.
#[tauri::command]
pub async fn connectors_account_connect(
    app: AppHandle,
    provider: String,
) -> Result<ConnectionInfo, String> {
    Registry::ensure_initialized();
    let def = crate::connectors::catalog::find_definition(&provider)
        .ok_or_else(|| format!("Unknown connector: {provider}"))?;
    if def.connect_flow != "desktop_pkce" {
        return Err(
            "This connector signs in through the cloud OAuth broker. Use Connect from Settings."
                .into(),
        );
    }
    let backend = crate::connectors::backend::get_backend(&provider)
        .ok_or_else(|| format!("{provider} is not available in this build."))?;
    backend
        .connect_account(&app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn connectors_account_disconnect(
    app: AppHandle,
    provider: String,
) -> Result<(), String> {
    Registry::ensure_initialized();
    let backend = crate::connectors::backend::get_backend(&provider)
        .ok_or_else(|| format!("{provider} is not available in this build."))?;
    backend
        .disconnect_account(&app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn connectors_list_indexed_roots(app: AppHandle) -> Result<Vec<ConnectorIndexedRoot>, String> {
    let dir = app_data(&app)?;
    let mut out = Vec::new();
    for c in connections::list(&dir)? {
        if let Some(mirror) = c.mirror_root.clone() {
            let label = match (&c.account_email, &c.remote_folder_name) {
                (Some(email), Some(folder)) => format!("{} · {} ({})", c.display_name, folder, email),
                (Some(email), None) => format!("{} ({})", c.display_name, email),
                (None, Some(folder)) => format!("{} · {}", c.display_name, folder),
                _ => c.display_name.clone(),
            };
            out.push(ConnectorIndexedRoot {
                connection_id: c.id,
                provider_id: c.provider_id,
                label,
                mirror_root: mirror,
                last_sync_at: c.last_sync_at,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn connectors_oauth_start(provider: String) -> Result<OAuthStartResponse, String> {
    Registry::ensure_initialized();
    let def = crate::connectors::catalog::find_definition(&provider)
        .ok_or_else(|| format!("Unknown connector: {provider}"))?;
    if def.connect_flow != "cloud_broker" {
        return Err(format!(
            "{} uses on-device sign-in. Use Connect from Settings.",
            def.display_name
        ));
    }
    if !crate::connectors::backend::has_backend(&provider) {
        return Err(format!("{} is coming soon.", def.display_name));
    }
    oauth_client::oauth_start(&provider).await
}

#[tauri::command]
pub async fn connectors_oauth_poll(
    app: AppHandle,
    session_id: String,
    provider: String,
) -> Result<OAuthPollResult, String> {
    let dir = app_data(&app)?;
    match oauth_client::oauth_poll(&session_id).await? {
        BrokerPollResponse::Pending => Ok(OAuthPollResult::Pending),
        BrokerPollResponse::Expired => Ok(OAuthPollResult::Expired),
        BrokerPollResponse::Denied => Ok(OAuthPollResult::Denied),
        BrokerPollResponse::Approved { tokens } => {
            let refresh = tokens
                .refresh_token
                .ok_or_else(|| "Google did not return a refresh token. Please try again.".to_string())?;
            let connection_id = Uuid::new_v4().to_string();
            let display = tokens
                .account_name
                .clone()
                .or_else(|| tokens.account_email.clone())
                .unwrap_or_else(|| "Google Drive".into());
            let scopes = tokens
                .scope
                .map(|s| {
                    s.split_whitespace()
                        .map(|x| x.to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            let info = if provider == "gdrive" {
                gdrive::store_new_connection(
                    &dir,
                    &connection_id,
                    tokens.account_email,
                    display,
                    tokens.access_token,
                    refresh,
                    tokens.expires_in,
                    scopes,
                )?
            } else {
                return Err(format!("{provider} is coming soon."));
            };
            Ok(OAuthPollResult::Approved { connection: info })
        }
    }
}

#[tauri::command]
pub async fn connectors_disconnect(
    app: AppHandle,
    connection_id: String,
    wipe_mirror: Option<bool>,
) -> Result<(), String> {
    Registry::ensure_initialized();

    // Provider-id disconnect for account-lifecycle connectors (e.g. "gmail").
    if let Some(def) = crate::connectors::catalog::find_definition(&connection_id) {
        if def.connect_flow == "desktop_pkce" {
            if let Some(backend) = crate::connectors::backend::get_backend(&connection_id) {
                return backend
                    .disconnect_account(&app)
                    .await
                    .map_err(|e| e.to_string());
            }
        }
    }

    let dir = app_data(&app)?;
    let id = ConnectionId(connection_id.clone());
    if let Some(info) = connections::get(&dir, &id)? {
        if let Some(root) = info.mirror_root.as_deref() {
            fileindexer_bridge::remove_root(&app, root)?;
        }
    }
    credentials::remove(&dir, &connection_id)?;
    connections::remove(&dir, &id)?;
    if wipe_mirror.unwrap_or(true) {
        mirror::wipe_mirror(&dir, &connection_id)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn connectors_list_children(
    app: AppHandle,
    connection_id: String,
    parent_id: Option<String>,
) -> Result<Vec<RemoteEntry>, String> {
    let dir = app_data(&app)?;
    let id = ConnectionId(connection_id);
    let provider = connection_provider(&dir, &id)?;
    let parent = parent_id.map(RemoteId);
    Registry::list_children(&provider, &dir, &id, parent.as_ref())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn connectors_add_indexed_folder(
    app: AppHandle,
    state: State<'_, DocGraphState>,
    connection_id: String,
    remote_folder_id: Option<String>,
    remote_folder_name: Option<String>,
) -> Result<SyncReport, String> {
    let dir = app_data(&app)?;
    let id = ConnectionId(connection_id.clone());
    let provider = connection_provider(&dir, &id)?;
    let remote = remote_folder_id.clone().map(RemoteId);

    let report = Registry::sync_folder(&provider, &dir, &id, remote.as_ref())
        .await
        .map_err(|e| e.to_string())?;

    fileindexer_bridge::merge_root(&app, &report.mirror_root.display().to_string())?;

    if let Ok(Some(mut info)) = connections::get(&dir, &id) {
        info.remote_folder_id = remote_folder_id;
        info.remote_folder_name = remote_folder_name;
        info.mirror_root = Some(report.mirror_root.display().to_string());
        let _ = connections::upsert(&dir, info);
    }

    // Trigger File Indexer incremental sync for the mirror root.
    let path = report.mirror_root.display().to_string();
    let _ = crate::commands::doc_graph::start_indexing_directory(app.clone(), state, path).await;

    Ok(report)
}

#[tauri::command]
pub async fn connectors_sync_now(
    app: AppHandle,
    state: State<'_, DocGraphState>,
    connection_id: String,
) -> Result<SyncReport, String> {
    let dir = app_data(&app)?;
    let id = ConnectionId(connection_id);
    let info = connections::get(&dir, &id)?
        .ok_or_else(|| "Connection not found.".to_string())?;
    let remote = info.remote_folder_id.clone().map(RemoteId);
    let report = Registry::sync_folder(&info.provider_id, &dir, &id, remote.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    fileindexer_bridge::merge_root(&app, &report.mirror_root.display().to_string())?;
    let path = report.mirror_root.display().to_string();
    let _ = crate::commands::doc_graph::start_indexing_directory(app.clone(), state, path).await;
    Ok(report)
}

#[tauri::command]
pub async fn connectors_fetch_file(
    app: AppHandle,
    connection_id: String,
    remote_id: String,
) -> Result<String, String> {
    let dir = app_data(&app)?;
    let id = ConnectionId(connection_id);
    let provider = connection_provider(&dir, &id)?;
    let path = Registry::fetch_file(&provider, &dir, &id, &RemoteId(remote_id))
        .await
        .map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn connectors_create_file(
    app: AppHandle,
    state: State<'_, DocGraphState>,
    connection_id: String,
    parent_id: Option<String>,
    name: String,
    local_source_path: String,
) -> Result<RemoteEntry, String> {
    let dir = app_data(&app)?;
    let id = ConnectionId(connection_id);
    let provider = connection_provider(&dir, &id)?;
    let bytes = std::fs::read(&local_source_path)
        .map_err(|_| "Couldn't read the local file to upload.".to_string())?;
    let mime = mime_from_path(&local_source_path);
    let parent = parent_id.map(RemoteId);
    let entry = Registry::create_file(
        &provider,
        &dir,
        &id,
        parent.as_ref(),
        &name,
        &bytes,
        mime.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    if let Ok(Some(info)) = connections::get(&dir, &id) {
        if let Some(mirror) = info.mirror_root {
            let _ = crate::commands::doc_graph::start_indexing_directory(app, state, mirror).await;
        }
    }
    Ok(entry)
}

#[tauri::command]
pub async fn connectors_update_file(
    app: AppHandle,
    state: State<'_, DocGraphState>,
    connection_id: String,
    remote_id: String,
    local_source_path: String,
) -> Result<RemoteEntry, String> {
    let dir = app_data(&app)?;
    let id = ConnectionId(connection_id);
    let provider = connection_provider(&dir, &id)?;
    let bytes = std::fs::read(&local_source_path)
        .map_err(|_| "Couldn't read the local file to upload.".to_string())?;
    let entry = Registry::update_file(&provider, &dir, &id, &RemoteId(remote_id), &bytes)
        .await
        .map_err(|e| e.to_string())?;
    if let Ok(Some(info)) = connections::get(&dir, &id) {
        if let Some(mirror) = info.mirror_root {
            let _ = crate::commands::doc_graph::start_indexing_directory(app, state, mirror).await;
        }
    }
    Ok(entry)
}

fn mime_from_path(path: &str) -> Option<String> {
    let ext = PathBuf::from(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        "html" | "htm" => "text/html",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "json" => "application/json",
        _ => return None,
    };
    Some(mime.to_string())
}
