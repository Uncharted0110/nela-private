//! HTTP client for NELA Cloud API.
//!
//! Attaches Bearer access tokens and auto-refreshes on HTTP 401.

use crate::cloud::token_store;
use crate::cloud::types::{
    AuthTokenResponse, BillingManageResponse, CheckoutRequest, CheckoutResponse, CloudChatRequest,
    DevicePollRequest, DevicePollResponse, DeviceStartResponse, EntitlementResponse,
    LogoutRequest, RefreshRequest, RefreshTokenResponse, UserProfileDto,
};
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::Value;
use std::path::Path;
use tauri::{AppHandle, Emitter};

fn api_url(path: &str) -> String {
    let base = crate::cloud::api_base_url();
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

async fn read_error_body(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if body.is_empty() {
        format!("Cloud API error ({status})")
    } else {
        format!("Cloud API error ({status}): {body}")
    }
}

/// Ensure we have a usable access token, refreshing from the stored refresh token if needed.
pub async fn ensure_access_token(app_data_dir: &Path) -> Result<String, String> {
    if let Some(token) = token_store::get_access_token() {
        if !token.is_empty() {
            return Ok(token);
        }
    }
    refresh_access_token(app_data_dir).await
}

pub async fn refresh_access_token(app_data_dir: &Path) -> Result<String, String> {
    let refresh = token_store::get_refresh_token(app_data_dir)?
        .ok_or_else(|| "Not signed in to NELA Cloud".to_string())?;

    let client = http_client()?;
    let resp = client
        .post(api_url("/v1/auth/refresh"))
        .json(&RefreshRequest {
            refresh_token: refresh,
        })
        .send()
        .await
        .map_err(|e| format!("Token refresh failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    let body: RefreshTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid refresh response: {e}"))?;

    token_store::set_access_token(Some(body.access_token.clone()));
    if let Some(new_refresh) = body.refresh_token.as_deref() {
        token_store::update_refresh_token(app_data_dir, new_refresh)?;
    }

    Ok(body.access_token)
}

async fn authorized_request<F, Fut>(
    app_data_dir: &Path,
    mut send: F,
) -> Result<reqwest::Response, String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, String>>,
{
    let token = ensure_access_token(app_data_dir).await?;
    let resp = send(token).await?;
    if resp.status() != StatusCode::UNAUTHORIZED {
        return Ok(resp);
    }

    let token = refresh_access_token(app_data_dir).await?;
    send(token).await
}

pub async fn device_start() -> Result<DeviceStartResponse, String> {
    let client = http_client()?;
    let resp = client
        .post(api_url("/v1/auth/device/start"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("Device auth start failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid device start response: {e}"))
}

pub async fn device_poll(device_code: &str) -> Result<DevicePollResponse, String> {
    let client = http_client()?;
    let resp = client
        .post(api_url("/v1/auth/device/poll"))
        .json(&DevicePollRequest {
            device_code: device_code.to_string(),
        })
        .send()
        .await
        .map_err(|e| format!("Device auth poll failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid device poll response: {e}"))
}

pub async fn email_login(
    email: &str,
    password: &str,
    device_name: &str,
) -> Result<AuthTokenResponse, String> {
    let client = http_client()?;
    let resp = client
        .post(api_url("/v1/auth/email/login"))
        .json(&serde_json::json!({
            "email": email,
            "password": password,
            "deviceName": device_name,
        }))
        .send()
        .await
        .map_err(|e| format!("Email login failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid email login response: {e}"))
}

pub async fn email_register(
    email: &str,
    password: &str,
    name: Option<&str>,
    device_name: &str,
) -> Result<AuthTokenResponse, String> {
    let client = http_client()?;
    let mut body = serde_json::json!({
        "email": email,
        "password": password,
        "deviceName": device_name,
    });
    if let Some(name) = name {
        if !name.trim().is_empty() {
            body["name"] = serde_json::Value::String(name.trim().to_string());
        }
    }

    let resp = client
        .post(api_url("/v1/auth/email/register"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Email register failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid email register response: {e}"))
}

pub async fn logout(app_data_dir: &Path) -> Result<(), String> {
    let refresh = token_store::get_refresh_token(app_data_dir).ok().flatten();
    if refresh.is_some() || token_store::get_access_token().is_some() {
        let client = http_client()?;
        let _ = client
            .post(api_url("/v1/auth/logout"))
            .json(&LogoutRequest {
                refresh_token: refresh,
            })
            .send()
            .await;
    }
    Ok(())
}

pub async fn get_me(app_data_dir: &Path) -> Result<UserProfileDto, String> {
    let client = http_client()?;
    let resp = authorized_request(app_data_dir, |token| {
        let client = client.clone();
        async move {
            client
                .get(api_url("/v1/me"))
                .bearer_auth(token)
                .send()
                .await
                .map_err(|e| format!("Get profile failed: {e}"))
        }
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid profile response: {e}"))
}

pub async fn get_entitlement(app_data_dir: &Path) -> Result<EntitlementResponse, String> {
    let client = http_client()?;
    let resp = authorized_request(app_data_dir, |token| {
        let client = client.clone();
        async move {
            client
                .get(api_url("/v1/me/entitlement"))
                .bearer_auth(token)
                .send()
                .await
                .map_err(|e| format!("Get entitlement failed: {e}"))
        }
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid entitlement response: {e}"))
}

pub async fn create_checkout(
    app_data_dir: &Path,
    plan: &str,
) -> Result<CheckoutResponse, String> {
    let client = http_client()?;
    let plan = plan.to_string();
    let resp = authorized_request(app_data_dir, |token| {
        let client = client.clone();
        let plan = plan.clone();
        async move {
            client
                .post(api_url("/v1/billing/razorpay/checkout"))
                .bearer_auth(token)
                .json(&CheckoutRequest { plan })
                .send()
                .await
                .map_err(|e| format!("Checkout request failed: {e}"))
        }
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid checkout response: {e}"))
}

pub async fn create_billing_manage(
    app_data_dir: &Path,
) -> Result<BillingManageResponse, String> {
    let client = http_client()?;
    let resp = authorized_request(app_data_dir, |token| {
        let client = client.clone();
        async move {
            client
                .post(api_url("/v1/billing/razorpay/manage"))
                .bearer_auth(token)
                .json(&serde_json::json!({}))
                .send()
                .await
                .map_err(|e| format!("Billing manage request failed: {e}"))
        }
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid billing manage response: {e}"))
}

/// Non-streaming chat completion — returns assistant text content.
pub async fn chat_complete(
    app_data_dir: &Path,
    mut request: CloudChatRequest,
) -> Result<String, String> {
    request.stream = false;
    let client = http_client()?;
    let body = serde_json::to_value(&request)
        .map_err(|e| format!("Failed to serialize chat request: {e}"))?;

    let resp = authorized_request(app_data_dir, |token| {
        let client = client.clone();
        let body = body.clone();
        async move {
            client
                .post(api_url("/v1/ai/chat/completions"))
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Cloud chat request failed: {e}"))
        }
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid chat response: {e}"))?;

    extract_assistant_content(&value)
        .ok_or_else(|| "Cloud chat response missing assistant content".to_string())
}

/// Streaming chat — emits `cloud-chat-stream` events `{ chunk, done }`.
pub async fn chat_stream(
    app: &AppHandle,
    app_data_dir: &Path,
    mut request: CloudChatRequest,
) -> Result<(), String> {
    request.stream = true;
    let client = http_client()?;
    let body = serde_json::to_value(&request)
        .map_err(|e| format!("Failed to serialize chat request: {e}"))?;

    let resp = authorized_request(app_data_dir, |token| {
        let client = client.clone();
        let body = body.clone();
        async move {
            client
                .post(api_url("/v1/ai/chat/completions"))
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Cloud chat stream request failed: {e}"))
        }
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if content_type.contains("text/event-stream") || content_type.contains("stream") {
        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| format!("Cloud stream interrupted: {e}"))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim_end_matches('\r').to_string();
                buffer = buffer[pos + 1..].to_string();
                if line.is_empty() {
                    continue;
                }
                let data = if let Some(rest) = line.strip_prefix("data:") {
                    rest.trim()
                } else {
                    line.as_str()
                };
                if data.is_empty() || data == "[DONE]" {
                    if data == "[DONE]" {
                        let _ = app.emit(
                            "cloud-chat-stream",
                            serde_json::json!({ "chunk": "", "done": true }),
                        );
                    }
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(data) {
                    if let Some(text) = extract_stream_delta(&value) {
                        if !text.is_empty() {
                            let _ = app.emit(
                                "cloud-chat-stream",
                                serde_json::json!({ "chunk": text, "done": false }),
                            );
                        }
                    }
                }
            }
        }

        let _ = app.emit(
            "cloud-chat-stream",
            serde_json::json!({ "chunk": "", "done": true }),
        );
        return Ok(());
    }

    // Non-SSE JSON body fallback
    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid chat stream response: {e}"))?;
    if let Some(text) = extract_assistant_content(&value) {
        let _ = app.emit(
            "cloud-chat-stream",
            serde_json::json!({ "chunk": text, "done": false }),
        );
    }
    let _ = app.emit(
        "cloud-chat-stream",
        serde_json::json!({ "chunk": "", "done": true }),
    );
    Ok(())
}

fn extract_assistant_content(value: &Value) -> Option<String> {
    if let Some(content) = value.get("content").and_then(|v| v.as_str()) {
        return Some(content.to_string());
    }
    value
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn extract_stream_delta(value: &Value) -> Option<String> {
    if let Some(content) = value.get("content").and_then(|v| v.as_str()) {
        return Some(content.to_string());
    }
    value
        .pointer("/choices/0/delta/content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}
