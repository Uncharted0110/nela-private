//! NELA Cloud API contract types (duplicated from website shared contracts).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CloudPlan {
    Free,
    #[serde(alias = "premium_small", alias = "premium_medium")]
    Starter,
    #[serde(alias = "premium_large")]
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
#[serde(rename_all = "lowercase")]
pub enum DevicePollPendingStatus {
    Pending,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollPendingResponse {
    pub status: DevicePollPendingStatus,
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
pub struct EntitlementCredits {
    pub balance: u32,
    #[serde(default)]
    pub pack_credits: u32,
    #[serde(default)]
    pub monthly_grant: u32,
    #[serde(default)]
    pub trial_credits: u32,
    #[serde(default)]
    pub trial_expires_at: Option<String>,
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
    #[serde(default)]
    pub window_hours: Option<u32>,
    #[serde(default)]
    pub resets_at: Option<String>,
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
    #[serde(default)]
    pub credits: Option<EntitlementCredits>,
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
pub struct CloudImageUrl {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudFilePayload {
    pub filename: String,
    pub file_data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CloudChatContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: CloudImageUrl },
    #[serde(rename = "file")]
    File { file: CloudFilePayload },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CloudChatContent {
    Text(String),
    Parts(Vec<CloudChatContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudFileAnnotationFile {
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub content: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudFileAnnotation {
    #[serde(rename = "type")]
    pub kind: String,
    pub file: CloudFileAnnotationFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPdfParserOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudFileParserPlugin {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf: Option<CloudPdfParserOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudChatMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<CloudChatContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<CloudToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Vec<CloudFileAnnotation>>,
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
    pub plugins: Option<Vec<CloudFileParserPlugin>>,
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

#[cfg(test)]
mod tests {
    use super::{CloudPlan, DevicePollResponse};

    #[test]
    fn approved_device_poll_accepts_legacy_premium_plan() {
        let json = r#"{
            "status": "approved",
            "accessToken": "access",
            "refreshToken": "refresh",
            "expiresIn": 900,
            "profile": {
                "id": "user-1",
                "name": "Test User",
                "email": "test@example.com",
                "avatarUrl": null,
                "authProvider": "google",
                "plan": "premium_medium",
                "displayPlan": "premium",
                "isPremium": true,
                "entitlementStatus": "active",
                "updatedAt": "2026-08-17T00:00:00.000Z",
                "occupation": null,
                "field": null,
                "onboardingCompleted": true
            }
        }"#;

        let response: DevicePollResponse =
            serde_json::from_str(json).expect("approved response should deserialize");
        match response {
            DevicePollResponse::Approved(approved) => {
                assert_eq!(approved.profile.plan, CloudPlan::Starter);
            }
            DevicePollResponse::Pending(_) => panic!("approved response became pending"),
        }
    }

    #[test]
    fn malformed_approved_poll_cannot_fall_back_to_pending() {
        let json = r#"{"status":"approved","profile":{"plan":"unknown"}}"#;
        assert!(serde_json::from_str::<DevicePollResponse>(json).is_err());
    }

    #[test]
    fn cloud_chat_content_accepts_string_or_parts() {
        let string_msg: super::CloudChatMessage = serde_json::from_str(
            r#"{"role":"user","content":"hello"}"#,
        )
        .unwrap();
        match string_msg.content {
            Some(super::CloudChatContent::Text(text)) => assert_eq!(text, "hello"),
            other => panic!("expected text, got {other:?}"),
        }

        let parts_msg: super::CloudChatMessage = serde_json::from_str(
            r#"{"role":"user","content":[{"type":"text","text":"see"},{"type":"image_url","image_url":{"url":"data:image/png;base64,aa"}}]}"#,
        )
        .unwrap();
        match parts_msg.content {
            Some(super::CloudChatContent::Parts(parts)) => assert_eq!(parts.len(), 2),
            other => panic!("expected parts, got {other:?}"),
        }
    }
}
