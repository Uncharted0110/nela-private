//! NELA Cloud auth, entitlement, and billing Tauri commands.

use crate::auth::UserProfile;
use crate::cloud::client;
use crate::cloud::profile_cache;
use crate::cloud::token_store;
use crate::cloud::types::{
    BillingManageResponse, CheckoutResponse, DeviceStartResponse, EntitlementResponse,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir error: {e}"))
}

fn open_url(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Failed to open URL: {e}"))
}

/// Frontend-safe poll result — tokens never leave the Rust side.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CloudAuthPollResult {
    Pending,
    Approved { profile: UserProfile },
}

#[tauri::command]
pub async fn cloud_auth_start() -> Result<DeviceStartResponse, String> {
    client::device_start().await
}

#[tauri::command]
pub async fn cloud_auth_poll(
    app: AppHandle,
    device_code: String,
) -> Result<CloudAuthPollResult, String> {
    let dir = app_data_dir(&app)?;
    let response = client::device_poll(&device_code).await?;

    match response {
        crate::cloud::types::DevicePollResponse::Approved(approved) => {
            token_store::save_tokens(&dir, &approved.access_token, &approved.refresh_token)?;
            let profile = profile_cache::cache_cloud_profile(&dir, &approved.profile)?;
            Ok(CloudAuthPollResult::Approved { profile })
        }
        crate::cloud::types::DevicePollResponse::Pending(_) => Ok(CloudAuthPollResult::Pending),
    }
}

#[tauri::command]
pub async fn cloud_refresh_token(app: AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    let _ = client::refresh_access_token(&dir).await?;
    Ok(())
}

#[tauri::command]
pub async fn cloud_sign_out(app: AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    let _ = client::logout(&dir).await;
    token_store::clear_tokens(&dir)?;
    profile_cache::clear_cached_profile(&dir)?;
    Ok(())
}

#[tauri::command]
pub async fn cloud_get_profile(app: AppHandle) -> Result<Option<UserProfile>, String> {
    let dir = app_data_dir(&app)?;

    // Prefer live profile when signed in; fall back to local cache.
    if token_store::get_refresh_token(&dir)?.is_some() {
        match client::get_me(&dir).await {
            Ok(dto) => {
                let profile = profile_cache::cache_cloud_profile(&dir, &dto)?;
                return Ok(Some(profile));
            }
            Err(_) => {
                return crate::auth::get_user_profile(&dir);
            }
        }
    }

    crate::auth::get_user_profile(&dir)
}

#[tauri::command]
pub async fn cloud_get_entitlement(app: AppHandle) -> Result<EntitlementResponse, String> {
    let dir = app_data_dir(&app)?;
    client::get_entitlement(&dir).await
}

#[tauri::command]
pub async fn cloud_create_checkout(
    app: AppHandle,
    plan: String,
) -> Result<CheckoutResponse, String> {
    let dir = app_data_dir(&app)?;
    let plan = plan.trim().to_lowercase();
    if plan != "starter" && plan != "pro" {
        return Err(format!("Unsupported checkout plan: {plan}"));
    }
    let response = client::create_checkout(&dir, &plan).await?;
    open_url(&app, &response.checkout_url)?;
    Ok(response)
}

#[tauri::command]
pub async fn cloud_create_billing_manage(app: AppHandle) -> Result<BillingManageResponse, String> {
    let dir = app_data_dir(&app)?;
    let response = client::create_billing_manage(&dir).await?;
    open_url(&app, &response.manage_url)?;
    Ok(response)
}
