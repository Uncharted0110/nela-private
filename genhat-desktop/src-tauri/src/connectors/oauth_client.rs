//! Talk to nela-backend connector OAuth broker (code exchange + refresh only).

use crate::connectors::types::OAuthStartResponse;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerTokenPayload {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub scope: Option<String>,
    pub account_email: Option<String>,
    pub account_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "status")]
pub enum BrokerPollResponse {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "expired")]
    Expired,
    #[serde(rename = "denied")]
    Denied,
    #[serde(rename = "approved")]
    Approved {
        #[serde(flatten)]
        tokens: BrokerTokenPayload,
    },
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "Couldn't connect right now. Please try again.".to_string())
}

fn api_url(path: &str) -> String {
    let base = crate::cloud::api_base_url();
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

async fn post_json(path: &str, body: Value) -> Result<reqwest::Response, String> {
    let _ = crate::cloud::resolve_api_base_url().await;
    let client = http_client()?;
    client
        .post(api_url(path))
        .json(&body)
        .send()
        .await
        .map_err(|_| {
            "We couldn't reach NELA Cloud. Check your internet connection and try again.".to_string()
        })
}

pub async fn oauth_start(provider: &str) -> Result<OAuthStartResponse, String> {
    let resp = post_json(
        "/v1/connectors/oauth/start",
        serde_json::json!({ "provider": provider }),
    )
    .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        log::warn!("connector oauth start failed: {status} {body}");
        if status.as_u16() == 404 {
            return Err(
                "Drive sign-in broker is not available on this API. Update NELA or use a build with desktop Drive connect."
                    .into(),
            );
        }
        if status.as_u16() == 503 || body.contains("not configured") {
            return Err(
                "Google Drive OAuth is not configured on the API. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (or GOOGLE_CONNECTOR_*)."
                    .into(),
            );
        }
        return Err(format!(
            "Couldn't start connector sign-in (HTTP {}). Check that NELA Cloud API is running.",
            status.as_u16()
        ));
    }
    resp.json::<OAuthStartResponse>()
        .await
        .map_err(|_| "Couldn't start connector sign-in. Please try again.".to_string())
}

pub async fn oauth_poll(session_id: &str) -> Result<BrokerPollResponse, String> {
    let resp = post_json(
        "/v1/connectors/oauth/poll",
        serde_json::json!({ "sessionId": session_id }),
    )
    .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        log::warn!("connector oauth poll failed: {status} {body}");
        return Err("Couldn't check connector sign-in. Please try again.".to_string());
    }
    resp.json::<BrokerPollResponse>()
        .await
        .map_err(|_| "Couldn't check connector sign-in. Please try again.".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResponse {
    pub access_token: String,
    pub expires_in: Option<u64>,
    pub refresh_token: Option<String>,
}

pub async fn oauth_refresh(refresh_token: &str) -> Result<RefreshResponse, String> {
    let resp = post_json(
        "/v1/connectors/oauth/refresh",
        serde_json::json!({ "refreshToken": refresh_token }),
    )
    .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        log::warn!("connector oauth refresh failed: {status} {body}");
        return Err("Connector session expired. Please connect again.".to_string());
    }
    resp.json::<RefreshResponse>()
        .await
        .map_err(|_| "Connector session expired. Please connect again.".to_string())
}
