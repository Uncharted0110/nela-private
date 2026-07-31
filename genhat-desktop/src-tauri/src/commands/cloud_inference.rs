//! NELA Cloud inference Tauri commands (OpenRouter proxied via website/API).

use crate::cloud::client;
use crate::cloud::types::CloudChatRequest;
use tauri::{AppHandle, Emitter, Manager};

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "Something went wrong on this device. Please try again.".to_string())
}

/// Start a cloud chat stream.
///
/// Returns immediately after spawning the stream task so Tauri can deliver
/// `cloud-chat-stream` events to the UI while tokens arrive (waiting for the
/// full response inside the command would buffer the UI until completion).
#[tauri::command]
pub async fn cloud_chat_stream(
    app: AppHandle,
    request: CloudChatRequest,
) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn(async move {
        if let Err(err) = client::chat_stream(&app, &dir, request).await {
            let _ = app.emit(
                "cloud-chat-stream",
                serde_json::json!({
                    "chunk": "",
                    "done": true,
                    "error": err,
                }),
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn cloud_chat_complete(
    app: AppHandle,
    request: CloudChatRequest,
) -> Result<String, String> {
    let dir = app_data_dir(&app)?;
    client::chat_complete(&dir, request).await
}
