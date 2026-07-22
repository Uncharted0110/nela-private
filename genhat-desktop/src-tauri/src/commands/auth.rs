//! Local profile cache commands (no Google OAuth / no plan mutation).

use crate::auth::{self, AvatarSource, UserProfile};
use tauri::{AppHandle, Manager};

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir error: {e}"))
}

#[tauri::command]
pub async fn get_user_profile(app: AppHandle) -> Result<Option<UserProfile>, String> {
    let dir = app_data_dir(&app)?;
    auth::get_user_profile(&dir)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveUserProfileInput {
    pub name: String,
    pub email: String,
    pub avatar: Option<AvatarSource>,
}

#[tauri::command]
pub async fn save_user_profile(
    app: AppHandle,
    input: SaveUserProfileInput,
) -> Result<UserProfile, String> {
    let dir = app_data_dir(&app)?;
    auth::save_user_profile(&dir, input.name, input.email, input.avatar)
}

#[tauri::command]
pub async fn sign_out_user(app: AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    // Clear local profile cache and NELA Cloud tokens.
    let _ = crate::cloud::client::logout(&dir).await;
    crate::cloud::token_store::clear_tokens(&dir)?;
    auth::sign_out_user(&dir)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveUploadedAvatarInput {
    pub image_base64: String,
    pub mime: String,
}

#[tauri::command]
pub async fn save_uploaded_avatar(
    app: AppHandle,
    input: SaveUploadedAvatarInput,
) -> Result<AvatarSource, String> {
    let dir = app_data_dir(&app)?;
    auth::save_uploaded_avatar(&dir, &input.image_base64, &input.mime)
}
