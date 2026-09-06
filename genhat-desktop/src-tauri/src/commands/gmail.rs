//! Gmail connector Tauri commands.

use crate::connectors::gmail::{
    self, GmailReadResult, GmailSendResult, GmailStatus,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

fn bind_app_data(app: &AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not open app data on this device.".to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|_| "Could not open app data on this device.".to_string())?;
    gmail::set_app_data_dir(dir);
    Ok(())
}

static OAUTH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct OauthGuard;

impl Drop for OauthGuard {
    fn drop(&mut self) {
        OAUTH_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

fn open_url(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "We couldn't open your browser. Please try again.".to_string())
}

#[tauri::command]
pub async fn gmail_oauth_start(app: AppHandle) -> Result<GmailStatus, String> {
    if OAUTH_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Err("A Gmail sign-in is already in progress.".to_string());
    }
    let _guard = OauthGuard;
    bind_app_data(&app)?;
    gmail::connect(|url| open_url(&app, url)).await
}

#[tauri::command]
pub fn gmail_status(app: AppHandle) -> Result<GmailStatus, String> {
    bind_app_data(&app)?;
    gmail::status()
}

#[tauri::command]
pub async fn gmail_disconnect(app: AppHandle) -> Result<GmailStatus, String> {
    bind_app_data(&app)?;
    gmail::disconnect().await
}

#[tauri::command]
pub async fn gmail_send(
    app: AppHandle,
    to: Vec<String>,
    subject: String,
    body: String,
    cc: Option<Vec<String>>,
    bcc: Option<Vec<String>>,
) -> Result<GmailSendResult, String> {
    bind_app_data(&app)?;
    gmail::send_message(
        &to,
        cc.as_deref().unwrap_or(&[]),
        bcc.as_deref().unwrap_or(&[]),
        &subject,
        &body,
    )
    .await
}

#[tauri::command]
pub async fn gmail_read(
    app: AppHandle,
    max_results: Option<u32>,
    query: Option<String>,
) -> Result<GmailReadResult, String> {
    bind_app_data(&app)?;
    gmail::read_messages(max_results, query).await
}
