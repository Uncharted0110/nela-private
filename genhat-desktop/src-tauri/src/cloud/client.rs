//! HTTP client for NELA Cloud API.
//!
//! Attaches Bearer access tokens and auto-refreshes on HTTP 401.
//! User-facing errors stay non-technical; details stay in logs only.

use crate::cloud::profile_cache;
use crate::cloud::token_store;
use crate::cloud::types::{
    AuthTokenResponse, BillingManageResponse, CheckoutRequest, CheckoutResponse,
    ConfirmCheckoutRequest, ConfirmCheckoutResponse, CloudChatRequest, DevicePollRequest,
    DevicePollResponse, DeviceStartResponse, EntitlementResponse, LogoutRequest,
    RefreshRequest, RefreshTokenResponse, UserProfileDto,
};
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

/// Serialize refresh so parallel 401s don't rotate the same token twice.
static REFRESH_LOCK: std::sync::OnceLock<Arc<Mutex<()>>> = std::sync::OnceLock::new();

fn refresh_lock() -> Arc<Mutex<()>> {
    REFRESH_LOCK
        .get_or_init(|| Arc::new(Mutex::new(())))
        .clone()
}

fn api_url_for(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .tcp_nodelay(true)
        .pool_max_idle_per_host(2)
        .build()
        .map_err(|_| "Couldn't connect right now. Please try again.".to_string())
}

fn is_transport_error(err: &reqwest::Error) -> bool {
    err.is_connect() || err.is_timeout() || err.is_request()
}

fn friendly_transport_error() -> String {
    "We couldn't reach NELA Cloud. Check your internet connection and try again.".to_string()
}

fn friendly_http_error(status: StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "Please sign in again to continue.".to_string(),
        404 => "We couldn't find what you were looking for. Please try again.".to_string(),
        408 | 504 => "That took too long. Please try again.".to_string(),
        429 => "Too many requests. Please wait a moment and try again.".to_string(),
        400..=499 => "Something went wrong with that request. Please try again.".to_string(),
        500..=599 => "NELA Cloud is having trouble right now. Please try again in a moment.".to_string(),
        _ => "Something went wrong. Please try again.".to_string(),
    }
}

fn friendly_api_body_message(body: &str, status: StatusCode) -> String {
    let lower = body.to_lowercase();
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(code) = value.get("code").and_then(|v| v.as_str()) {
            match code {
                "INVALID_CREDENTIALS" | "AUTH_INVALID" => {
                    return "That email or password doesn't look right. Please try again.".to_string();
                }
                "EMAIL_ALREADY_EXISTS" | "USER_EXISTS" => {
                    return "An account with that email already exists. Try signing in instead."
                        .to_string();
                }
                "DEVICE_CODE_EXPIRED" | "DEVICE_CODE_INVALID" => {
                    return "That sign-in code expired. Please start again.".to_string();
                }
                "REFRESH_TOKEN_INVALID" | "REFRESH_TOKEN_REUSED" => {
                    return session_expired_message();
                }
                "QUOTA_EXCEEDED" | "ENTITLEMENT_REQUIRED" | "PLAN_REQUIRED" => {
                    return "Your plan doesn't cover this yet. Check your Cloud settings.".to_string();
                }
                "UPGRADE_REQUIRED" => {
                    return "Upgrade to Premium to use Smart and Deep in Cloud".to_string();
                }
                "FAST_QUOTA_EXHAUSTED" => {
                    return "Daily free Fast requests used up. Upgrade to Premium or wait for reset."
                        .to_string();
                }
                "QUOTA_EXHAUSTED" => {
                    return "Monthly cloud quota exhausted. Upgrade or wait for the next period."
                        .to_string();
                }
                _ => {}
            }
        }
        if let Some(message) = value.get("message").and_then(|v| v.as_str()) {
            let m = message.to_lowercase();
            if m.contains("password") || m.contains("credential") || m.contains("invalid email") {
                return "That email or password doesn't look right. Please try again.".to_string();
            }
            if m.contains("already") && m.contains("email") {
                return "An account with that email already exists. Try signing in instead."
                    .to_string();
            }
            if m.contains("expired") {
                return "That sign-in code expired. Please start again.".to_string();
            }
        }
    }
    if lower.contains("refresh") && (lower.contains("invalid") || lower.contains("reuse")) {
        return session_expired_message();
    }
    friendly_http_error(status)
}

async fn read_error_body(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    log::warn!("Cloud API error ({status}): {body}");
    friendly_api_body_message(&body, status)
}

fn is_refresh_fatal(err: &str) -> bool {
    err.contains("sign in again")
        || err.contains("REFRESH_TOKEN_INVALID")
        || err.contains("REFRESH_TOKEN_REUSED")
        || err.contains("Invalid refresh token")
        || err.contains("Refresh token reuse")
}

fn clear_session(app_data_dir: &Path) {
    let _ = token_store::clear_tokens(app_data_dir);
    let _ = profile_cache::clear_cached_profile(app_data_dir);
}

fn session_expired_message() -> String {
    "Your NELA Cloud session expired. Please sign in again.".to_string()
}

/// POST/GET helper: resolve base URL, send, and retry once on localhost/production fallback.
async fn send_cloud(
    method: reqwest::Method,
    path: &str,
    build: impl Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let client = http_client()?;
    let primary = crate::cloud::resolve_api_base_url().await;
    let url = api_url_for(&primary, path);
    let req = build(client.request(method.clone(), &url));

    match req.send().await {
        Ok(resp) => Ok(resp),
        Err(e) if is_transport_error(&e) => {
            log::warn!("Cloud request to {primary} failed: {e}");
            if let Some(alt) = crate::cloud::fallback_api_base_url(&primary).await {
                log::info!("Retrying cloud request against {alt}");
                let alt_url = api_url_for(&alt, path);
                let client = http_client()?;
                build(client.request(method, &alt_url))
                    .send()
                    .await
                    .map_err(|_| friendly_transport_error())
            } else {
                Err(friendly_transport_error())
            }
        }
        Err(e) => {
            log::warn!("Cloud request failed: {e}");
            Err(friendly_transport_error())
        }
    }
}

/// Ensure we have a usable access token, refreshing from the stored refresh token if needed.
pub async fn ensure_access_token(app_data_dir: &Path) -> Result<String, String> {
    if let Some(token) = token_store::get_access_token() {
        if !token.is_empty() {
            return Ok(token);
        }
    }
    refresh_access_token(app_data_dir, false).await
}

/// Rotate tokens. When `force` is true (after HTTP 401), never reuse the in-memory access token.
pub async fn refresh_access_token(
    app_data_dir: &Path,
    force: bool,
) -> Result<String, String> {
    let lock = refresh_lock();
    let _guard = lock.lock().await;

    if !force {
        if let Some(token) = token_store::get_access_token() {
            if !token.is_empty() {
                return Ok(token);
            }
        }
    }

    let refresh = match token_store::get_refresh_token(app_data_dir)? {
        Some(r) if !r.is_empty() => r,
        _ => {
            clear_session(app_data_dir);
            return Err("You're not signed in to NELA Cloud yet.".to_string());
        }
    };

    let resp = send_cloud(reqwest::Method::POST, "/v1/auth/refresh", |req| {
        req.json(&RefreshRequest {
            refresh_token: refresh.clone(),
        })
    })
    .await?;

    if !resp.status().is_success() {
        let err = read_error_body(resp).await;
        if is_refresh_fatal(&err) {
            clear_session(app_data_dir);
            return Err(session_expired_message());
        }
        return Err(err);
    }

    let body: RefreshTokenResponse = resp
        .json()
        .await
        .map_err(|_| "Something went wrong while renewing your session. Please try again.".to_string())?;

    token_store::save_tokens(app_data_dir, &body.access_token, &body.refresh_token)?;
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

    let token = refresh_access_token(app_data_dir, true).await?;
    send(token).await
}

pub async fn device_start() -> Result<DeviceStartResponse, String> {
    let resp = send_cloud(reqwest::Method::POST, "/v1/auth/device/start", |req| {
        req.json(&serde_json::json!({}))
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|_| "We couldn't start sign-in. Please try again.".to_string())
}

pub async fn device_poll(device_code: &str) -> Result<DevicePollResponse, String> {
    let resp = send_cloud(reqwest::Method::POST, "/v1/auth/device/poll", |req| {
        req.json(&DevicePollRequest {
            device_code: device_code.to_string(),
        })
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|_| "We couldn't finish checking sign-in. Please try again.".to_string())
}

pub async fn email_login(
    email: &str,
    password: &str,
    device_name: &str,
) -> Result<AuthTokenResponse, String> {
    let resp = send_cloud(reqwest::Method::POST, "/v1/auth/email/login", |req| {
        req.json(&serde_json::json!({
            "email": email,
            "password": password,
            "deviceName": device_name,
        }))
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|_| "We couldn't sign you in. Please try again.".to_string())
}

pub async fn email_register(
    email: &str,
    password: &str,
    name: Option<&str>,
    device_name: &str,
) -> Result<AuthTokenResponse, String> {
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

    let resp = send_cloud(reqwest::Method::POST, "/v1/auth/email/register", |req| {
        req.json(&body)
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|_| "We couldn't create your account. Please try again.".to_string())
}

pub async fn logout(app_data_dir: &Path) -> Result<(), String> {
    let refresh = token_store::get_refresh_token(app_data_dir).ok().flatten();
    if refresh.is_some() || token_store::get_access_token().is_some() {
        let _ = send_cloud(reqwest::Method::POST, "/v1/auth/logout", |req| {
            req.json(&LogoutRequest {
                refresh_token: refresh.clone(),
            })
        })
        .await;
    }
    Ok(())
}

pub async fn get_me(app_data_dir: &Path) -> Result<UserProfileDto, String> {
    let resp = authorized_request(app_data_dir, |token| async move {
        send_cloud(reqwest::Method::GET, "/v1/me", move |req| {
            req.bearer_auth(token.clone())
        })
        .await
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|_| "We couldn't load your profile. Please try again.".to_string())
}

pub async fn get_entitlement(app_data_dir: &Path) -> Result<EntitlementResponse, String> {
    let resp = authorized_request(app_data_dir, |token| async move {
        send_cloud(reqwest::Method::GET, "/v1/me/entitlement", move |req| {
            req.bearer_auth(token.clone())
        })
        .await
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|_| "We couldn't load your plan details. Please try again.".to_string())
}

pub async fn create_checkout(
    app_data_dir: &Path,
    plan: &str,
) -> Result<CheckoutResponse, String> {
    let plan = plan.to_string();
    let resp = authorized_request(app_data_dir, |token| {
        let plan = plan.clone();
        async move {
            send_cloud(
                reqwest::Method::POST,
                "/v1/billing/razorpay/checkout",
                move |req| {
                    req.bearer_auth(token.clone())
                        .json(&CheckoutRequest { plan: plan.clone() })
                },
            )
            .await
        }
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|_| "We couldn't open checkout. Please try again.".to_string())
}

pub async fn create_billing_manage(
    app_data_dir: &Path,
) -> Result<BillingManageResponse, String> {
    let resp = authorized_request(app_data_dir, |token| async move {
        send_cloud(
            reqwest::Method::POST,
            "/v1/billing/razorpay/manage",
            move |req| {
                req.bearer_auth(token.clone())
                    .json(&serde_json::json!({}))
            },
        )
        .await
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|_| "We couldn't open billing settings. Please try again.".to_string())
}

/// Confirm a completed Razorpay payment-link checkout and activate Premium.
pub async fn confirm_checkout(
    app_data_dir: &Path,
) -> Result<ConfirmCheckoutResponse, String> {
    let resp = authorized_request(app_data_dir, |token| async move {
        send_cloud(
            reqwest::Method::POST,
            "/v1/billing/razorpay/confirm",
            move |req| {
                req.bearer_auth(token.clone())
                    .json(&ConfirmCheckoutRequest::default())
            },
        )
        .await
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|_| "We couldn't confirm your payment. Please try again.".to_string())
}

/// POST /v1/search — Tavily-backed web search proxy on the NELA backend.
/// Body: `{ query, profile?, site?, timeRange?, maxResults? }`.
pub async fn search_web(app_data_dir: &Path, body: Value) -> Result<Value, String> {
    let resp = authorized_request(app_data_dir, |token| {
        let body = body.clone();
        async move {
            send_cloud(reqwest::Method::POST, "/v1/search", move |req| {
                req.bearer_auth(token.clone()).json(&body)
            })
            .await
        }
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|_| "We got an unexpected reply from web search. Please try again.".to_string())
}

/// POST /v1/extract — Tavily-backed page extraction proxy on the NELA backend.
/// Body: `{ urls, query?, depth? }`.
pub async fn extract_web(app_data_dir: &Path, body: Value) -> Result<Value, String> {
    let resp = authorized_request(app_data_dir, |token| {
        let body = body.clone();
        async move {
            send_cloud(reqwest::Method::POST, "/v1/extract", move |req| {
                req.bearer_auth(token.clone()).json(&body)
            })
            .await
        }
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    resp.json()
        .await
        .map_err(|_| "We got an unexpected reply from web extract. Please try again.".to_string())
}

/// Non-streaming chat completion — returns raw OpenAI-style JSON string
/// (includes content and/or tool_calls under choices[0].message).
pub async fn chat_complete(
    app_data_dir: &Path,
    mut request: CloudChatRequest,
) -> Result<String, String> {
    request.stream = false;
    let body = serde_json::to_value(&request)
        .map_err(|_| "Something went wrong preparing your message. Please try again.".to_string())?;

    let resp = authorized_request(app_data_dir, |token| {
        let body = body.clone();
        async move {
            send_cloud(
                reqwest::Method::POST,
                "/v1/ai/chat/completions",
                move |req| req.bearer_auth(token.clone()).json(&body),
            )
            .await
        }
    })
    .await?;

    if !resp.status().is_success() {
        return Err(read_error_body(resp).await);
    }

    let value: Value = resp
        .json()
        .await
        .map_err(|_| "We got an unexpected reply from NELA Cloud. Please try again.".to_string())?;

    serde_json::to_string(&value)
        .map_err(|_| "We got an unexpected reply from NELA Cloud. Please try again.".to_string())
}

/// Streaming chat — emits `cloud-chat-stream` events:
/// `{ chunk, done, tool_calls?, error? }`.
/// When the model emits tool_calls, they are accumulated from SSE deltas and
/// included on the final `done: true` event.
pub async fn chat_stream(
    app: &AppHandle,
    app_data_dir: &Path,
    mut request: CloudChatRequest,
) -> Result<(), String> {
    request.stream = true;
    let body = serde_json::to_value(&request)
        .map_err(|_| "Something went wrong preparing your message. Please try again.".to_string())?;

    let resp = authorized_request(app_data_dir, |token| {
        let body = body.clone();
        async move {
            send_cloud(
                reqwest::Method::POST,
                "/v1/ai/chat/completions",
                move |req| {
                    req.bearer_auth(token.clone())
                        .header(reqwest::header::ACCEPT, "text/event-stream")
                        .header(reqwest::header::CACHE_CONTROL, "no-cache")
                        .json(&body)
                },
            )
            .await
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
        let mut tool_acc = ToolCallAccumulator::default();
        let mut emitted_done = false;

        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|_| {
                "The connection dropped while NELA was answering. Please try again.".to_string()
            })?;
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
                if data.is_empty() {
                    continue;
                }
                if data == "[DONE]" {
                    if !emitted_done {
                        emitted_done = true;
                        emit_stream_done(app, &tool_acc);
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
                    tool_acc.ingest_delta(&value);
                }
            }
        }

        if !emitted_done {
            emit_stream_done(app, &tool_acc);
        }
        return Ok(());
    }

    // Non-SSE JSON body fallback
    let value: Value = resp.json().await.map_err(|_| {
        "We got an unexpected reply from NELA Cloud. Please try again.".to_string()
    })?;
    if let Some(text) = extract_assistant_content(&value) {
        let _ = app.emit(
            "cloud-chat-stream",
            serde_json::json!({ "chunk": text, "done": false }),
        );
    }
    let tool_calls = extract_message_tool_calls(&value);
    let mut payload = serde_json::json!({ "chunk": "", "done": true });
    if let Some(calls) = tool_calls {
        payload["tool_calls"] = calls;
    }
    let _ = app.emit("cloud-chat-stream", payload);
    Ok(())
}

fn emit_stream_done(app: &AppHandle, tool_acc: &ToolCallAccumulator) {
    let mut payload = serde_json::json!({ "chunk": "", "done": true });
    if let Some(calls) = tool_acc.finish() {
        payload["tool_calls"] = calls;
    }
    let _ = app.emit("cloud-chat-stream", payload);
}

#[derive(Default)]
struct ToolCallAccumulator {
    /// index -> (id, name, arguments)
    slots: std::collections::BTreeMap<usize, (String, String, String)>,
}

impl ToolCallAccumulator {
    fn ingest_delta(&mut self, value: &Value) {
        let Some(arr) = value
            .pointer("/choices/0/delta/tool_calls")
            .and_then(|v| v.as_array())
        else {
            return;
        };
        for item in arr {
            let index = item.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let entry = self
                .slots
                .entry(index)
                .or_insert_with(|| (String::new(), String::new(), String::new()));
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                if !id.is_empty() {
                    entry.0 = id.to_string();
                }
            }
            if let Some(name) = item
                .pointer("/function/name")
                .and_then(|v| v.as_str())
            {
                if !name.is_empty() {
                    entry.1.push_str(name);
                }
            }
            if let Some(args) = item
                .pointer("/function/arguments")
                .and_then(|v| v.as_str())
            {
                entry.2.push_str(args);
            }
        }
    }

    fn finish(&self) -> Option<Value> {
        if self.slots.is_empty() {
            return None;
        }
        let calls: Vec<Value> = self
            .slots
            .values()
            .filter(|(_, name, _)| !name.is_empty())
            .map(|(id, name, arguments)| {
                serde_json::json!({
                    "id": if id.is_empty() { format!("call_{name}") } else { id.clone() },
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": arguments,
                    }
                })
            })
            .collect();
        if calls.is_empty() {
            None
        } else {
            Some(Value::Array(calls))
        }
    }
}

fn extract_assistant_content(value: &Value) -> Option<String> {
    if let Some(content) = value.get("content") {
        if let Some(text) = content_to_plain(content) {
            return Some(text);
        }
    }
    value
        .pointer("/choices/0/message/content")
        .and_then(content_to_plain)
}

fn extract_message_tool_calls(value: &Value) -> Option<Value> {
    value
        .pointer("/choices/0/message/tool_calls")
        .cloned()
        .filter(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false))
}

fn extract_stream_delta(value: &Value) -> Option<String> {
    if let Some(content) = value.get("content") {
        if let Some(text) = content_to_plain(content) {
            return Some(text);
        }
    }
    value
        .pointer("/choices/0/delta/content")
        .and_then(content_to_plain)
}

/// OpenRouter / OpenAI deltas may send `content` as a string or as text parts.
fn content_to_plain(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let arr = content.as_array()?;
    let mut out = String::new();
    for part in arr {
        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
            out.push_str(text);
        } else if let Some(text) = part.as_str() {
            out.push_str(text);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}
