//! Map NELA Cloud profile DTOs into the local non-sensitive profile cache.

use crate::auth::{
    self, AuthProvider, AvatarKind, AvatarSource, EntitlementStatus as LocalEntitlementStatus,
    UserPlan, UserProfile,
};
use crate::cloud::types::{
    CloudPlan, EntitlementStatus as CloudEntitlementStatus, UserProfileDto,
};
use std::path::Path;

fn map_plan(plan: &CloudPlan) -> UserPlan {
    match plan {
        CloudPlan::Free => UserPlan::Free,
        CloudPlan::Starter => UserPlan::Starter,
        CloudPlan::Pro => UserPlan::Pro,
    }
}

fn map_entitlement_status(status: &CloudEntitlementStatus) -> LocalEntitlementStatus {
    match status {
        CloudEntitlementStatus::Inactive => LocalEntitlementStatus::Inactive,
        CloudEntitlementStatus::Active => LocalEntitlementStatus::Active,
        CloudEntitlementStatus::PastDue => LocalEntitlementStatus::PastDue,
        CloudEntitlementStatus::Cancelled => LocalEntitlementStatus::Cancelled,
        CloudEntitlementStatus::QuotaExhausted => LocalEntitlementStatus::QuotaExhausted,
    }
}

fn map_auth_provider(provider: &str) -> AuthProvider {
    match provider.trim().to_lowercase().as_str() {
        "google" => AuthProvider::Google,
        _ => AuthProvider::Local,
    }
}

/// Convert a cloud profile DTO into the local cached profile shape.
pub fn dto_to_cached_profile(dto: &UserProfileDto) -> UserProfile {
    let avatar = dto.avatar_url.as_ref().map(|url| AvatarSource {
        kind: AvatarKind::Google,
        value: url.clone(),
    });

    UserProfile {
        id: dto.id.clone(),
        name: dto.name.clone(),
        email: dto.email.clone(),
        avatar,
        plan: map_plan(&dto.plan),
        entitlement_status: Some(map_entitlement_status(&dto.entitlement_status)),
        auth_provider: map_auth_provider(&dto.auth_provider),
        updated_at: dto.updated_at.clone(),
    }
}

/// Persist cloud profile into the local cache (no tokens).
pub fn cache_cloud_profile(app_data_dir: &Path, dto: &UserProfileDto) -> Result<UserProfile, String> {
    let profile = dto_to_cached_profile(dto);
    auth::replace_user_profile(app_data_dir, profile.clone())?;
    Ok(profile)
}

pub fn clear_cached_profile(app_data_dir: &Path) -> Result<(), String> {
    auth::sign_out_user(app_data_dir)
}
