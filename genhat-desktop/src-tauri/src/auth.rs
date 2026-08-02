//! Local user profile cache (non-sensitive) and avatar upload.
//!
//! NELA Cloud auth/tokens live in `crate::cloud`. This module must not store
//! Google or NELA Cloud tokens in `profile.json`.

use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const PROFILE_FILE: &str = "profile.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UserPlan {
    Free,
    Starter,
    #[serde(alias = "premium")]
    Pro,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntitlementStatus {
    Inactive,
    Active,
    PastDue,
    Cancelled,
    QuotaExhausted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthProvider {
    Google,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AvatarKind {
    Google,
    Upload,
    Preset,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarSource {
    pub kind: AvatarKind,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DisplayPlan {
    Free,
    Premium,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub id: String,
    pub name: String,
    pub email: String,
    pub avatar: Option<AvatarSource>,
    pub plan: UserPlan,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_plan: Option<DisplayPlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_premium: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entitlement_status: Option<EntitlementStatus>,
    pub auth_provider: AuthProvider,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProfileStore {
    profile: Option<UserProfile>,
}

fn profile_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(PROFILE_FILE)
}

fn read_store(app_data_dir: &Path) -> Result<ProfileStore, String> {
    let path = profile_path(app_data_dir);
    if !path.exists() {
        return Ok(ProfileStore::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read profile: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse profile.json: {e}"))
}

fn write_store(app_data_dir: &Path, store: &ProfileStore) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;
    let path = profile_path(app_data_dir);
    // Persist profile only — never write tokens into profile.json.
    let out = serde_json::json!({
        "profile": store.profile,
    });
    let raw = serde_json::to_string_pretty(&out)
        .map_err(|e| format!("Failed to serialize profile: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("Failed to write profile: {e}"))
}

pub fn get_user_profile(app_data_dir: &Path) -> Result<Option<UserProfile>, String> {
    Ok(read_store(app_data_dir)?.profile)
}

/// Replace the entire cached profile (used after NELA Cloud sign-in).
pub fn replace_user_profile(
    app_data_dir: &Path,
    profile: UserProfile,
) -> Result<UserProfile, String> {
    let mut store = read_store(app_data_dir)?;
    store.profile = Some(profile.clone());
    write_store(app_data_dir, &store)?;
    Ok(profile)
}

/// Persist editable profile fields. Plan/entitlement come from NELA Cloud.
pub fn save_user_profile(
    app_data_dir: &Path,
    name: String,
    email: String,
    avatar: Option<AvatarSource>,
) -> Result<UserProfile, String> {
    let mut store = read_store(app_data_dir)?;
    let existing = store
        .profile
        .clone()
        .ok_or_else(|| "No profile to update. Sign in first.".to_string())?;

    let updated = UserProfile {
        id: existing.id,
        name: name.trim().to_string(),
        email: email.trim().to_string(),
        avatar,
        plan: existing.plan,
        display_plan: existing.display_plan,
        is_premium: existing.is_premium,
        entitlement_status: existing.entitlement_status,
        auth_provider: existing.auth_provider,
        updated_at: Utc::now().to_rfc3339(),
    };

    if updated.name.is_empty() {
        return Err("Name cannot be empty".into());
    }
    if updated.email.is_empty() {
        return Err("Email cannot be empty".into());
    }

    store.profile = Some(updated.clone());
    write_store(app_data_dir, &store)?;
    Ok(updated)
}

pub fn sign_out_user(app_data_dir: &Path) -> Result<(), String> {
    let path = profile_path(app_data_dir);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to remove profile: {e}"))?;
    }
    let avatars_dir = app_data_dir.join("avatars");
    if avatars_dir.is_dir() {
        let _ = std::fs::remove_dir_all(&avatars_dir);
    }
    Ok(())
}

/// Save an uploaded avatar image (base64) under app data and return avatar source.
pub fn save_uploaded_avatar(
    app_data_dir: &Path,
    image_base64: &str,
    mime: &str,
) -> Result<AvatarSource, String> {
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => return Err(format!("Unsupported image type: {mime}")),
    };

    let raw = image_base64
        .strip_prefix("data:")
        .and_then(|s| s.split(',').nth(1))
        .unwrap_or(image_base64);

    use base64::engine::general_purpose::STANDARD;
    let bytes = STANDARD
        .decode(raw.trim())
        .map_err(|e| format!("Invalid image data: {e}"))?;

    if bytes.len() > 5 * 1024 * 1024 {
        return Err("Image must be 5 MB or smaller".into());
    }

    let avatars_dir = app_data_dir.join("avatars");
    std::fs::create_dir_all(&avatars_dir)
        .map_err(|e| format!("Failed to create avatars dir: {e}"))?;

    let filename = format!("{}.{}", Uuid::new_v4(), ext);
    let path = avatars_dir.join(&filename);
    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to save avatar: {e}"))?;

    // Prefer data URL for reliable webview display; file is kept as a local copy.
    let data_url = format!("data:{mime};base64,{}", STANDARD.encode(&bytes));

    Ok(AvatarSource {
        kind: AvatarKind::Upload,
        value: data_url,
    })
}
