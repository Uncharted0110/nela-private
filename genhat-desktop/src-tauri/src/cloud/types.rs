//! NELA Cloud API contract types (duplicated from website shared contracts).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CloudPlan {
    Free,
    Starter,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileDto {
    pub id: String,
    pub name: String,
    pub email: String,
    pub avatar_url: Option<String>,
    pub auth_provider: String,
    pub plan: CloudPlan,
    pub entitlement_status: EntitlementStatus,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthTokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub profile: UserProfileDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStartResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollPendingResponse {
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollApprovedResponse {
    pub status: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub profile: UserProfileDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DevicePollResponse {
    Approved(DevicePollApprovedResponse),
    Pending(DevicePollPendingResponse),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementQuota {
    pub included_usd: f64,
    pub used_usd: f64,
    pub remaining_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementLimits {
    pub max_input_tokens: u32,
    pub max_output_tokens: u32,
    pub requests_per_minute: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementResponse {
    pub cloud_enabled: bool,
    pub plan: CloudPlan,
    pub status: EntitlementStatus,
    pub quota: EntitlementQuota,
    pub limits: EntitlementLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResponse {
    pub checkout_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingManageResponse {
    pub manage_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudIntent {
    QuickChat,
    Summarize,
    RagAnswer,
    ArtifactPlan,
    DeepReasoning,
    Vision,
    CheapBackground,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudChatPrivacy {
    pub contains_file_context: bool,
    pub user_confirmed_cloud_context: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudChatGeneration {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudChatClientMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudChatRequest {
    pub intent: CloudIntent,
    pub messages: Vec<CloudChatMessage>,
    pub stream: bool,
    pub privacy: CloudChatPrivacy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<CloudChatGeneration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<CloudChatClientMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshTokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutRequest {
    pub plan: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollRequest {
    pub device_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutRequest {
    pub refresh_token: Option<String>,
}
