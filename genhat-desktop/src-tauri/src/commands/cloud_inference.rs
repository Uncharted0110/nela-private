//! NELA Cloud inference Tauri commands (OpenRouter proxied via website/API).

use crate::cloud::client;
use crate::cloud::types::CloudChatRequest;
use tauri::{AppHandle, Manager};

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir error: {e}"))
}

#[tauri::command]
pub async fn cloud_chat_stream(
    app: AppHandle,
    request: CloudChatRequest,
) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    client::chat_stream(&app, &dir, request).await
}

#[tauri::command]
pub async fn cloud_chat_complete(
    app: AppHandle,
    request: CloudChatRequest,
) -> Result<String, String> {
    let dir = app_data_dir(&app)?;
    client::chat_complete(&dir, request).await
}
