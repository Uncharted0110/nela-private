//! Shared Google Desktop / PKCE loopback for connectors.
//!
//! Used by Gmail and Google Drive so Connect works without nela-backend
//! OAuth broker (local API down / prod routes not deployed).

use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const OAUTH_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone)]
pub struct DesktopOAuthResult {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: Option<u64>,
    pub scope: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    scope: Option<String>,
    id_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UserInfo {
    email: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RefreshResponse {
    pub access_token: String,
    pub expires_in: Option<u64>,
    pub refresh_token: Option<String>,
}

fn pkce_pair() -> (String, String) {
    let raw = format!(
        "{}{}",
        uuid::Uuid::new_v4().as_simple(),
        uuid::Uuid::new_v4().as_simple()
    );
    let verifier = raw.chars().take(64).collect::<String>();
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

fn random_state() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Could not start a network client.".to_string())
}

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let val = parts.next().unwrap_or("");
        if key.is_empty() {
            continue;
        }
        let decoded_key = urlencoding::decode(key).unwrap_or(std::borrow::Cow::Borrowed(key));
        let decoded_val = urlencoding::decode(val).unwrap_or(std::borrow::Cow::Borrowed(val));
        out.insert(decoded_key.into_owned(), decoded_val.into_owned());
    }
    out
}

fn html_page(title: &str, message: &str) -> String {
    format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
<body style=\"font-family:system-ui,sans-serif;padding:2rem;max-width:36rem\">\
<h2>{title}</h2><p>{message}</p></body></html>"
    )
}

async fn write_http_ok(stream: &mut tokio::net::TcpStream, body: &str) -> std::io::Result<()> {
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes()).await
}

async fn wait_for_oauth_redirect(
    listener: tokio::net::TcpListener,
    expected_state: &str,
    label: &str,
) -> Result<String, String> {
    let outcome = tokio::time::timeout(OAUTH_TIMEOUT, async {
        loop {
            let (mut stream, _) = listener
                .accept()
                .await
                .map_err(|_| format!("{label} sign-in failed. Try Connect again."))?;

            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let first_line = req.lines().next().unwrap_or("");
            let path = first_line.split_whitespace().nth(1).unwrap_or("/");
            if path.starts_with("/favicon") {
                let _ = stream
                    .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                    .await;
                continue;
            }

            let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
            let params = parse_query(query);

            if let Some(err) = params.get("error") {
                let desc = params
                    .get("error_description")
                    .cloned()
                    .unwrap_or_else(|| err.clone());
                let body = html_page(
                    &format!("{label} not connected"),
                    "You can close this tab and return to NELA.",
                );
                let _ = write_http_ok(&mut stream, &body).await;
                return Err(format!("Google returned an error: {desc}"));
            }

            let Some(code) = params.get("code").cloned().filter(|c| !c.is_empty()) else {
                let _ = stream
                    .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
                    .await;
                continue;
            };
            let state = params.get("state").cloned().unwrap_or_default();
            if state != expected_state {
                let body = html_page(
                    &format!("{label} not connected"),
                    "Sign-in state did not match. Try again from NELA.",
                );
                let _ = write_http_ok(&mut stream, &body).await;
                return Err(format!(
                    "{label} sign-in could not be verified. Try Connect again."
                ));
            }

            let body = html_page(
                &format!("{label} connected"),
                "You can close this tab and return to NELA.",
            );
            let _ = write_http_ok(&mut stream, &body).await;
            return Ok(code);
        }
    })
    .await
    .map_err(|_| format!("{label} sign-in timed out. Try Connect again."))?;
    outcome
}

fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    json.get("email")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn fetch_profile(
    client: &reqwest::Client,
    access_token: &str,
    id_token: Option<&str>,
) -> (Option<String>, Option<String>) {
    if let Ok(resp) = client
        .get(USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
    {
        if let Ok(info) = resp.json::<UserInfo>().await {
            let email = info.email.filter(|e| !e.trim().is_empty());
            let name = info.name.filter(|n| !n.trim().is_empty());
            if email.is_some() || name.is_some() {
                return (email.or_else(|| id_token.and_then(email_from_id_token)), name);
            }
        }
    }
    (id_token.and_then(email_from_id_token), None)
}

/// Run Google Desktop PKCE for `scopes` (space-separated). Opens the browser via `open_url`.
pub async fn authorize(
    open_url: impl FnOnce(&str) -> Result<(), String>,
    scopes: &str,
    label: &str,
) -> Result<DesktopOAuthResult, String> {
    let client_id = crate::connectors::google_oauth::connector_client_id()?;
    let port = portpicker::pick_unused_port().ok_or_else(|| {
        format!("Could not reserve a local port for {label} sign-in.")
    })?;
    let redirect_uri = format!("http://localhost:{port}");
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|_| format!("Could not start the {label} sign-in listener."))?;
    let (verifier, challenge) = pkce_pair();
    let state = random_state();
    let auth = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent&state={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(scopes),
        urlencoding::encode(&challenge),
        urlencoding::encode(&state),
    );
    open_url(&auth)?;

    let code = wait_for_oauth_redirect(listener, &state, label).await?;
    let client = http_client()?;

    let mut form = vec![
        ("client_id", client_id.clone()),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect_uri),
    ];
    if let Some(secret) = crate::connectors::google_oauth::connector_client_secret() {
        form.push(("client_secret", secret));
    }

    let resp = client
        .post(TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|_| {
            format!("Could not finish {label} sign-in. Check your network and try again.")
        })?;

    let tokens: TokenResponse = resp.json().await.map_err(|_| {
        "Google returned an unexpected sign-in response.".to_string()
    })?;
    if let Some(err) = tokens.error {
        let desc = tokens.error_description.unwrap_or(err);
        if desc.to_lowercase().contains("client_secret") {
            return Err(
                "Google needs the Desktop client's secret. Add \
NELA_GOOGLE_CONNECTOR_CLIENT_SECRET to genhat-desktop/.env, then restart NELA."
                    .to_string(),
            );
        }
        return Err(format!("Google sign-in failed: {desc}"));
    }

    let access = tokens
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Google did not return an access token.".to_string())?;
    let refresh = tokens
        .refresh_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!(
                "Google did not return a refresh token. Disconnect any prior NELA {label} grant and try again."
            )
        })?;

    let (email, name) = fetch_profile(&client, &access, tokens.id_token.as_deref()).await;

    Ok(DesktopOAuthResult {
        access_token: access,
        refresh_token: refresh,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        email,
        name,
    })
}

/// Refresh an access token with the Desktop connector client (no cloud broker).
pub async fn refresh_access_token(refresh_token: &str) -> Result<RefreshResponse, String> {
    let client_id = crate::connectors::google_oauth::connector_client_id()?;
    let client = http_client()?;
    let mut form = vec![
        ("client_id", client_id),
        ("refresh_token", refresh_token.to_string()),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = crate::connectors::google_oauth::connector_client_secret() {
        form.push(("client_secret", secret));
    }
    let resp = client
        .post(TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|_| "Could not refresh connector session.".to_string())?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        log::warn!("desktop connector refresh failed: {status} {body}");
        return Err("Connector session expired. Please connect again.".to_string());
    }
    serde_json::from_str(&body)
        .map_err(|_| "Connector session expired. Please connect again.".to_string())
}
