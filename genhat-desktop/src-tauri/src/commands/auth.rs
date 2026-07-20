//! User profile and Google OAuth Tauri commands.

use crate::auth::{
    self, AvatarSource, UserPlan, UserProfile,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

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
pub async fn start_google_oauth(app: AppHandle) -> Result<UserProfile, String> {
    let dir = app_data_dir(&app)?;
    let app_for_open = app.clone();
    auth::start_google_oauth(&dir, move |url| {
        app_for_open
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("Failed to open browser for Google sign-in: {e}"))
    })
    .await
}

#[tauri::command]
pub async fn sign_out_user(app: AppHandle) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    auth::sign_out_user(&dir)
}

#[tauri::command]
pub async fn set_user_plan(app: AppHandle, plan: String) -> Result<UserProfile, String> {
    let dir = app_data_dir(&app)?;
    let plan = match plan.to_lowercase().as_str() {
        "free" => UserPlan::Free,
        "premium" => UserPlan::Premium,
        other => return Err(format!("Unknown plan: {other}")),
    };
    auth::set_user_plan(&dir, plan)
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
