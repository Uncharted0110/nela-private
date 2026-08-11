//! NELA Cloud API contract types (duplicated from website shared contracts).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CloudPlan {
    Free,
    Starter,
    Pro,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DisplayPlan {
    Free,
    Premium,
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
    #[serde(default)]
    pub display_plan: Option<DisplayPlan>,
    #[serde(default)]
    pub is_premium: Option<bool>,
    pub entitlement_status: EntitlementStatus,
    pub updated_at: String,
    #[serde(default)]
    pub occupation: Option<String>,
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub onboarding_completed: Option<bool>,
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
pub struct EntitlementFastFree {
    pub limit: u32,
    pub used: u32,
    pub remaining: u32,
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
    #[serde(default)]
    pub display_plan: Option<DisplayPlan>,
    #[serde(default)]
    pub is_premium: Option<bool>,
    #[serde(default)]
    pub paid_cloud: bool,
    pub quota: EntitlementQuota,
    #[serde(default)]
    pub fast_free: Option<EntitlementFastFree>,
    pub limits: EntitlementLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResponse {
    pub checkout_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmCheckoutRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_link_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmCheckoutResponse {
    pub ok: bool,
    pub activated: bool,
    pub plan: CloudPlan,
    pub status: EntitlementStatus,
    #[serde(default)]
    pub paid_cloud: bool,
    #[serde(default)]
    pub is_premium: bool,
    #[serde(default)]
    pub display_plan: Option<DisplayPlan>,
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

/// OpenRouter quality tier (Fast / Smart / Deep / Auto).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CloudQualityMode {
    Fast,
    Smart,
    Deep,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: CloudToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudChatMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<CloudToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
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
    /// Sticky OpenRouter session id for prompt-cache routing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudToolFunctionDef {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudToolDefinition {
    #[serde(rename = "type")]
    pub kind: String,
    pub function: CloudToolFunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudResponseFormat {
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudChatRequest {
    pub mode: CloudQualityMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<CloudIntent>,
    pub messages: Vec<CloudChatMessage>,
    pub stream: bool,
    pub privacy: CloudChatPrivacy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<CloudChatGeneration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<CloudToolDefinition>>,
    #[serde(rename = "tool_choice", skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(rename = "response_format", skip_serializing_if = "Option::is_none")]
    pub response_format: Option<CloudResponseFormat>,
    /// When true, OpenRouter should include reasoning tokens in the SSE stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<CloudChatClientMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshTokenResponse {
    pub access_token: String,
    pub refresh_token: String,
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
