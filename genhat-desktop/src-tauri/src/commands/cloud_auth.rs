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
        .map_err(|_| "Something went wrong on this device. Please try again.".to_string())
}

fn open_url(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "We couldn't open your browser. Please try again.".to_string())
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

async fn persist_email_auth(
    app: &AppHandle,
    response: crate::cloud::types::AuthTokenResponse,
) -> Result<UserProfile, String> {
    let dir = app_data_dir(app)?;
    token_store::save_tokens(&dir, &response.access_token, &response.refresh_token)?;
    profile_cache::cache_cloud_profile(&dir, &response.profile)
}

#[tauri::command]
pub async fn cloud_auth_email_login(
    app: AppHandle,
    email: String,
    password: String,
) -> Result<UserProfile, String> {
    let response = client::email_login(&email, &password, "NELA Desktop").await?;
    persist_email_auth(&app, response).await
}

#[tauri::command]
pub async fn cloud_auth_email_register(
    app: AppHandle,
    email: String,
    password: String,
    name: Option<String>,
) -> Result<UserProfile, String> {
    let response =
        client::email_register(&email, &password, name.as_deref(), "NELA Desktop").await?;
    persist_email_auth(&app, response).await
}

#[tauri::command]
pub async fn cloud_refresh_token(app: AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    let _ = client::refresh_access_token(&dir, false).await?;
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
            Err(err) => {
                // Stale refresh after DB reset / revoke — drop session so UI asks to sign in.
                if err.contains("session expired")
                    || err.contains("REFRESH_TOKEN")
                    || err.contains("Not signed in")
                {
                    let _ = token_store::clear_tokens(&dir);
                    let _ = profile_cache::clear_cached_profile(&dir);
                    return Ok(None);
                }
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
        return Err("That plan isn't available. Please choose Starter or Pro.".to_string());
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

/// Confirm latest paid Razorpay checkout and refresh Premium entitlement.
#[tauri::command]
pub async fn cloud_confirm_checkout(app: AppHandle) -> Result<crate::cloud::types::ConfirmCheckoutResponse, String> {
    let dir = app_data_dir(&app)?;
    client::confirm_checkout(&dir).await
}

/// Open the public pricing page so users can upgrade to Premium.
#[tauri::command]
pub async fn cloud_open_pricing(app: AppHandle) -> Result<(), String> {
    let base = crate::cloud::web_base_url();
    let url = format!("{}/pricing", base.trim_end_matches('/'));
    open_url(&app, &url)
}
