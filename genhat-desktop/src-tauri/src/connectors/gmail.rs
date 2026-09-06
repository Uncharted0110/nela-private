//! Gmail connector: desktop PKCE OAuth (`gmail.send`) + MIME send.
//!
//! Tokens live in `{app_data}/nela_gmail_tokens.json` (same pattern as Cloud).
//! The OS keychain stores a compact refresh+email copy when it can.
//! Distinct from NELA Cloud Google login.

use base64::Engine;
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const KEYRING_SERVICE: &str = "nela.connector.gmail";
const KEYRING_USER: &str = "oauth";
const TOKEN_FILE: &str = "nela_gmail_tokens.json";

static APP_DATA_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn set_app_data_dir(path: PathBuf) {
    if let Ok(mut guard) = APP_DATA_DIR.lock() {
        *guard = Some(path);
    }
}

fn app_data_dir() -> Option<PathBuf> {
    APP_DATA_DIR.lock().ok().and_then(|g| g.clone())
}
const GMAIL_SEND_SCOPE: &str = "https://www.googleapis.com/auth/gmail.send email";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const SEND_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const OAUTH_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_BODY_CHARS: usize = 100_000;
const MAX_RECIPIENTS: usize = 25;
const NELA_FOOTER_TEXT: &str = "This message was sent using nela";
const NELA_LOGO_CID: &str = "nela-logo";
const NELA_LOGO_PNG: &[u8] = include_bytes!("../../../public/logo-dark.png");

static ACCESS_CACHE: Mutex<Option<CachedAccess>> = Mutex::new(None);

#[derive(Clone)]
struct CachedAccess {
    access_token: String,
    expires_at: u64,
    email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredGmailTokens {
    refresh_token: String,
    access_token: Option<String>,
    expires_at: Option<u64>,
    email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailStatus {
    pub connected: bool,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailSendResult {
    pub sent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    id_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UserInfo {
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GmailSendApiResponse {
    id: Option<String>,
    error: Option<GmailApiError>,
}

#[derive(Debug, Deserialize)]
struct GmailApiError {
    message: Option<String>,
}

pub fn client_id() -> Result<String, String> {
    crate::connectors::google_oauth::connector_client_id()
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "Could not open the OS keychain for Gmail.".to_string())
}

fn parse_store(raw: &str) -> Option<StoredGmailTokens> {
    let store: StoredGmailTokens = serde_json::from_str(raw).ok()?;
    if store.refresh_token.trim().is_empty() {
        return None;
    }
    Some(store)
}

fn read_file_store(app_data: &Path) -> Option<StoredGmailTokens> {
    let path = app_data.join(TOKEN_FILE);
    let raw = std::fs::read_to_string(path).ok()?;
    parse_store(&raw)
}

fn write_file_store(app_data: &Path, store: &StoredGmailTokens) -> Result<(), String> {
    std::fs::create_dir_all(app_data)
        .map_err(|_| "Could not save Gmail on this device.".to_string())?;
    let path = app_data.join(TOKEN_FILE);
    let raw = serde_json::to_string(store)
        .map_err(|_| "Could not save Gmail on this device.".to_string())?;
    std::fs::write(&path, raw)
        .map_err(|_| "Could not save Gmail on this device.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_keychain_store() -> Option<StoredGmailTokens> {
    let entry = keyring_entry().ok()?;
    match entry.get_password() {
        Ok(raw) => parse_store(&raw),
        Err(_) => None,
    }
}

fn write_keychain_store(store: &StoredGmailTokens) {
    // Windows Credential Manager caps the blob (~2.5KB). Persist refresh+email only.
    let compact = StoredGmailTokens {
        refresh_token: store.refresh_token.clone(),
        access_token: None,
        expires_at: store.expires_at,
        email: store.email.clone(),
    };
    if let (Ok(entry), Ok(raw)) = (keyring_entry(), serde_json::to_string(&compact)) {
        let _ = entry.set_password(&raw);
    }
}

fn read_store() -> Result<Option<StoredGmailTokens>, String> {
    if let Some(dir) = app_data_dir() {
        if let Some(store) = read_file_store(&dir) {
            return Ok(Some(store));
        }
    }
    if let Some(store) = read_keychain_store() {
        if let Some(dir) = app_data_dir() {
            let _ = write_file_store(&dir, &store);
        }
        return Ok(Some(store));
    }
    Ok(None)
}

fn write_store(store: &StoredGmailTokens) -> Result<(), String> {
    let dir = app_data_dir().ok_or_else(|| {
        "Could not save Gmail on this device. Try Connect again.".to_string()
    })?;
    write_file_store(&dir, store)?;
    write_keychain_store(store);
    Ok(())
}

fn delete_store() {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
    if let Some(dir) = app_data_dir() {
        let _ = std::fs::remove_file(dir.join(TOKEN_FILE));
    }
    if let Ok(mut guard) = ACCESS_CACHE.lock() {
        *guard = None;
    }
}

fn pkce_pair() -> (String, String) {
    let raw = format!("{}{}", uuid::Uuid::new_v4().as_simple(), uuid::Uuid::new_v4().as_simple());
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

async fn wait_for_oauth_redirect(
    listener: tokio::net::TcpListener,
    expected_state: &str,
) -> Result<String, String> {
    let outcome = tokio::time::timeout(OAUTH_TIMEOUT, async {
        loop {
            let (mut stream, _) = listener
                .accept()
                .await
                .map_err(|_| "Gmail sign-in failed. Try Connect again.".to_string())?;

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
                let body = html_page("Gmail not connected", "You can close this tab and return to NELA.");
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
                    "Gmail not connected",
                    "Sign-in state did not match. Try again from NELA.",
                );
                let _ = write_http_ok(&mut stream, &body).await;
                return Err("Gmail sign-in could not be verified. Try Connect again.".to_string());
            }

            let body = html_page("Gmail connected", "You can close this tab and return to NELA.");
            let _ = write_http_ok(&mut stream, &body).await;
            return Ok(code);
        }
    })
    .await
    .map_err(|_| "Gmail sign-in timed out. Try Connect again.".to_string())?;
    outcome
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

async fn fetch_email(client: &reqwest::Client, access_token: &str, id_token: Option<&str>) -> Option<String> {
    if let Ok(resp) = client
        .get(USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
    {
        if let Ok(info) = resp.json::<UserInfo>().await {
            if let Some(email) = info.email.filter(|e| !e.trim().is_empty()) {
                return Some(email);
            }
        }
    }
    id_token.and_then(email_from_id_token)
}

async fn exchange_code(
    client: &reqwest::Client,
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<StoredGmailTokens, String> {
    let mut form = vec![
        ("client_id", client_id.to_string()),
        ("code", code.to_string()),
        ("code_verifier", verifier.to_string()),
        ("grant_type", "authorization_code".to_string()),
        ("redirect_uri", redirect_uri.to_string()),
    ];
    if let Some(secret) = crate::connectors::google_oauth::connector_client_secret() {
        form.push(("client_secret", secret));
    }
    let resp = client
        .post(TOKEN_URL)
        .form(&form)
        .send()
        .await
        .map_err(|_| "Could not finish Gmail sign-in. Check your network and try again.".to_string())?;

    let tokens: TokenResponse = resp
        .json()
        .await
        .map_err(|_| "Google returned an unexpected sign-in response.".to_string())?;
    if let Some(err) = tokens.error {
        let desc = tokens.error_description.unwrap_or(err);
        if desc.to_lowercase().contains("client_secret") {
            return Err(
                "Google needs the Desktop client's secret. In Cloud Console open \
Clients → your Desktop app, copy Client secret, add \
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
            "Google did not return a refresh token. Disconnect any prior NELA Gmail grant and try again."
                .to_string()
        })?;
    let expires_at = tokens.expires_in.map(|secs| now_unix().saturating_add(secs));
    let email = fetch_email(client, &access, tokens.id_token.as_deref()).await;
    if let Some(exp) = expires_at {
        if let Ok(mut guard) = ACCESS_CACHE.lock() {
            *guard = Some(CachedAccess {
                access_token: access.clone(),
                expires_at: exp,
                email: email.clone(),
            });
        }
    }
    Ok(StoredGmailTokens {
        refresh_token: refresh,
        access_token: Some(access),
        expires_at,
        email,
    })
}

async fn refresh_access(store: &StoredGmailTokens) -> Result<(String, u64), String> {
    let client_id = client_id()?;
    let client = http_client()?;
    let mut form = vec![
        ("client_id", client_id),
        ("refresh_token", store.refresh_token.clone()),
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
        .map_err(|_| "Could not refresh the Gmail session. Try Connect again.".to_string())?;
    let tokens: TokenResponse = resp
        .json()
        .await
        .map_err(|_| "Google returned an unexpected refresh response.".to_string())?;
    if let Some(err) = tokens.error {
        delete_store();
        let desc = tokens.error_description.unwrap_or(err);
        return Err(format!("Gmail access expired ({desc}). Connect Gmail again."));
    }
    let access = tokens
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Google did not return an access token.".to_string())?;
    let expires_at = now_unix().saturating_add(tokens.expires_in.unwrap_or(3600));
    let mut next = store.clone();
    next.access_token = Some(access.clone());
    next.expires_at = Some(expires_at);
    let _ = write_store(&next);
    if let Ok(mut guard) = ACCESS_CACHE.lock() {
        *guard = Some(CachedAccess {
            access_token: access.clone(),
            expires_at,
            email: store.email.clone(),
        });
    }
    Ok((access, expires_at))
}

async fn access_token() -> Result<(String, Option<String>), String> {
    if let Ok(guard) = ACCESS_CACHE.lock() {
        if let Some(cache) = guard.as_ref() {
            if cache.expires_at > now_unix().saturating_add(60) {
                let email = cache
                    .email
                    .clone()
                    .or_else(|| read_store().ok().flatten().and_then(|s| s.email));
                return Ok((cache.access_token.clone(), email));
            }
        }
    }
    let store = read_store()?.ok_or_else(|| "Gmail is not connected.".to_string())?;
    if let (Some(access), Some(exp)) = (store.access_token.clone(), store.expires_at) {
        if exp > now_unix().saturating_add(60) {
            if let Ok(mut guard) = ACCESS_CACHE.lock() {
                *guard = Some(CachedAccess {
                    access_token: access.clone(),
                    expires_at: exp,
                    email: store.email.clone(),
                });
            }
            return Ok((access, store.email.clone()));
        }
    }
    let (access, _) = refresh_access(&store).await?;
    let email = read_store()?.and_then(|s| s.email).or(store.email);
    Ok((access, email))
}

pub fn status() -> Result<GmailStatus, String> {
    if let Some(store) = read_store()? {
        return Ok(GmailStatus {
            connected: true,
            email: store.email,
        });
    }
    if let Ok(guard) = ACCESS_CACHE.lock() {
        if let Some(cache) = guard.as_ref() {
            if cache.expires_at > now_unix() {
                return Ok(GmailStatus {
                    connected: true,
                    email: cache.email.clone(),
                });
            }
        }
    }
    Ok(GmailStatus {
        connected: false,
        email: None,
    })
}

pub async fn connect(open_url: impl FnOnce(&str) -> Result<(), String>) -> Result<GmailStatus, String> {
    let client_id = client_id()?;
    let port = portpicker::pick_unused_port().ok_or_else(|| {
        "Could not reserve a local port for Gmail sign-in.".to_string()
    })?;
    // Desktop client JSON registers http://localhost (any port).
    let redirect_uri = format!("http://localhost:{port}");
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|_| "Could not start the Gmail sign-in listener.".to_string())?;
    let (verifier, challenge) = pkce_pair();
    let state = random_state();
    let auth = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent&state={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(GMAIL_SEND_SCOPE),
        urlencoding::encode(&challenge),
        urlencoding::encode(&state),
    );
    open_url(&auth)?;

    let code = wait_for_oauth_redirect(listener, &state).await?;

    let client = http_client()?;
    let store = exchange_code(&client, &client_id, &code, &verifier, &redirect_uri).await?;
    write_store(&store)?;
    Ok(GmailStatus {
        connected: true,
        email: store.email,
    })
}

pub async fn disconnect() -> Result<GmailStatus, String> {
    let store = read_store()?;
    if let Some(store) = store {
        let client = http_client()?;
        let _ = client
            .post(REVOKE_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(format!("token={}", urlencoding::encode(&store.refresh_token)))
            .send()
            .await;
    }
    delete_store();
    Ok(GmailStatus {
        connected: false,
        email: None,
    })
}

fn extract_emails(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for token in raw.split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '"' | '\'')) {
        let email = token.trim().trim_matches(['<', '>']);
        if is_email(email) {
            out.push(email.to_string());
        }
    }
    out
}

pub fn is_email(value: &str) -> bool {
    let s = value.trim();
    if s.len() < 3 || s.len() > 254 || s.contains('<') || s.contains('>') || s.contains('\n') {
        return false;
    }
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !local.contains(' ')
        && domain.contains('.')
        && !domain.contains(' ')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
}

pub fn header_value(value: &str) -> String {
    value
        .split(['\r', '\n', ' '])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn encode_subject(subject: &str) -> String {
    let clean = header_value(subject);
    if clean.is_ascii() && !clean.bytes().any(|b| b < 32) {
        return clean;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(clean.as_bytes());
    format!("=?UTF-8?B?{b64}?=")
}

pub fn normalize_recipients(list: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for raw in list {
        let extracted = extract_emails(raw);
        let parts: Vec<String> = if extracted.is_empty() {
            raw.split([',', ';'])
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        } else {
            extracted
        };
        for email in parts {
            if !is_email(&email) {
                return Err(format!("“{email}” is not a valid email address."));
            }
            if !out.iter().any(|e: &String| e.eq_ignore_ascii_case(&email)) {
                out.push(email);
            }
        }
    }
    if out.len() > MAX_RECIPIENTS {
        return Err(format!("Too many recipients (max {MAX_RECIPIENTS})."));
    }
    Ok(out)
}

fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

fn wrap76(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + input.len() / 38);
    for (i, chunk) in input.as_bytes().chunks(76).enumerate() {
        if i > 0 {
            out.push_str("\r\n");
        }
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
    }
    out
}

fn crlf_text(body: &str) -> String {
    body.replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n")
}

fn body_already_has_footer(body: &str) -> bool {
    body.to_ascii_lowercase()
        .contains(&NELA_FOOTER_TEXT.to_ascii_lowercase())
}

fn plain_with_footer(body: &str) -> String {
    let text = crlf_text(body);
    if body_already_has_footer(body) {
        return text;
    }
    format!("{text}\r\n\r\n{NELA_FOOTER_TEXT}")
}

fn html_with_footer(body: &str) -> String {
    let escaped = html_escape(body)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "<br>\r\n");
    let footer = if body_already_has_footer(body) {
        String::new()
    } else {
        format!(
            "<div style=\"margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb\">\
<img src=\"cid:{NELA_LOGO_CID}\" alt=\"NELA\" width=\"40\" \
style=\"display:block;margin:0 0 8px 0;border:0\" />\
<em style=\"font-style:italic;color:#6b7280;font-size:13px\">{NELA_FOOTER_TEXT}</em></div>"
        )
    };
    format!(
        "<!DOCTYPE html><html><body style=\"font-family:system-ui,Segoe UI,sans-serif;\
font-size:15px;line-height:1.5;color:#111827;margin:0\">\
<div>{escaped}</div>{footer}</body></html>"
    )
}

pub fn build_rfc2822(
    from: &str,
    to: &[String],
    cc: &[String],
    bcc: &[String],
    subject: &str,
    body: &str,
) -> Result<String, String> {
    if to.is_empty() {
        return Err("Add at least one recipient.".to_string());
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err("The email body is too long.".to_string());
    }
    let from = header_value(from);
    if !is_email(&from) {
        return Err("The connected Gmail address is invalid. Disconnect and connect again.".to_string());
    }
    let subject = encode_subject(subject);
    if subject.is_empty() {
        return Err("Subject cannot be empty.".to_string());
    }
    let date = Utc
        .timestamp_opt(now_unix() as i64, 0)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc2822();
    let mut headers = vec![
        format!("From: {from}"),
        format!("To: {}", to.join(", ")),
    ];
    if !cc.is_empty() {
        headers.push(format!("Cc: {}", cc.join(", ")));
    }
    if !bcc.is_empty() {
        headers.push(format!("Bcc: {}", bcc.join(", ")));
    }
    headers.push(format!("Subject: {subject}"));
    headers.push(format!("Date: {date}"));
    headers.push(format!("Message-ID: <{}@nela.local>", uuid::Uuid::new_v4()));
    headers.push("MIME-Version: 1.0".to_string());
    let rel_boundary = format!("nela-rel-{}", uuid::Uuid::new_v4().as_simple());
    let alt_boundary = format!("nela-alt-{}", uuid::Uuid::new_v4().as_simple());
    headers.push(format!(
        "Content-Type: multipart/related; boundary=\"{rel_boundary}\"; type=\"multipart/alternative\""
    ));

    let plain = plain_with_footer(body);
    let html = html_with_footer(body);
    let logo_b64 = wrap76(&base64::engine::general_purpose::STANDARD.encode(NELA_LOGO_PNG));
    let mime_body = format!(
        "--{rel_boundary}\r\n\
Content-Type: multipart/alternative; boundary=\"{alt_boundary}\"\r\n\
\r\n\
--{alt_boundary}\r\n\
Content-Type: text/plain; charset=UTF-8\r\n\
Content-Transfer-Encoding: 8bit\r\n\
\r\n\
{plain}\r\n\
--{alt_boundary}\r\n\
Content-Type: text/html; charset=UTF-8\r\n\
Content-Transfer-Encoding: 8bit\r\n\
\r\n\
{html}\r\n\
--{alt_boundary}--\r\n\
--{rel_boundary}\r\n\
Content-Type: image/png\r\n\
Content-Transfer-Encoding: base64\r\n\
Content-ID: <{NELA_LOGO_CID}>\r\n\
Content-Disposition: inline; filename=\"nela.png\"\r\n\
\r\n\
{logo_b64}\r\n\
--{rel_boundary}--\r\n"
    );
    Ok(format!("{}\r\n\r\n{mime_body}", headers.join("\r\n")))
}

pub fn raw_urlsafe(message: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(message.as_bytes())
}

async fn send_with_token(
    client: &reqwest::Client,
    token: &str,
    raw: &str,
) -> Result<(reqwest::StatusCode, GmailSendApiResponse), String> {
    let resp = client
        .post(SEND_URL)
        .bearer_auth(token)
        .json(&serde_json::json!({ "raw": raw }))
        .send()
        .await
        .map_err(|_| "Could not reach Gmail. Check your network and try again.".to_string())?;
    let status = resp.status();
    let parsed = resp
        .json::<GmailSendApiResponse>()
        .await
        .unwrap_or(GmailSendApiResponse {
            id: None,
            error: None,
        });
    Ok((status, parsed))
}

pub async fn send_message(
    to: &[String],
    cc: &[String],
    bcc: &[String],
    subject: &str,
    body: &str,
) -> Result<GmailSendResult, String> {
    let to = normalize_recipients(to)?;
    let cc = normalize_recipients(cc)?;
    let bcc = normalize_recipients(bcc)?;
    let (token, email) = access_token().await?;
    let from = email.ok_or_else(|| {
        "Gmail is connected but the account email is missing. Disconnect and connect again.".to_string()
    })?;
    let mime = build_rfc2822(&from, &to, &cc, &bcc, subject, body)?;
    let raw = raw_urlsafe(&mime);
    let client = http_client()?;
    let (status, parsed) = send_with_token(&client, &token, &raw).await?;
    if status.as_u16() == 401 {
        let store = read_store()?.ok_or_else(|| "Gmail is not connected.".to_string())?;
        let (token, _) = refresh_access(&store).await?;
        let (status, parsed) = send_with_token(&client, &token, &raw).await?;
        return interpret_send(status, parsed);
    }
    interpret_send(status, parsed)
}

fn interpret_send(status: reqwest::StatusCode, parsed: GmailSendApiResponse) -> Result<GmailSendResult, String> {
    if status.is_success() {
        if let Some(id) = parsed.id.filter(|s| !s.is_empty()) {
            return Ok(GmailSendResult {
                sent: true,
                id: Some(id),
                reason: None,
            });
        }
        return Ok(GmailSendResult {
            sent: true,
            id: None,
            reason: None,
        });
    }
    let msg = parsed
        .error
        .and_then(|e| e.message)
        .unwrap_or_else(|| format!("Gmail returned HTTP {}", status.as_u16()));
    Err(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_emails() {
        assert!(is_email("priya@example.com"));
        assert!(!is_email("not-an-email"));
        assert!(!is_email("a@b"));
        assert!(!is_email("evil@x.com\nBcc: hidden@x.com"));
    }

    #[test]
    fn strips_header_injections() {
        assert_eq!(header_value("Hello\r\nBcc: hidden@x.com"), "Hello Bcc: hidden@x.com");
    }

    #[test]
    fn builds_mime_with_recipients() {
        let mime = build_rfc2822(
            "me@gmail.com",
            &["priya@example.com".into()],
            &["cc@example.com".into()],
            &[],
            "Running late",
            "I will be 10 minutes late.",
        )
        .unwrap();
        assert!(mime.contains("To: priya@example.com"));
        assert!(mime.contains("Cc: cc@example.com"));
        assert!(mime.contains("Subject: Running late"));
        assert!(mime.contains("I will be 10 minutes late."));
        assert!(mime.contains("This message was sent using nela"));
        assert!(mime.contains("cid:nela-logo"));
        assert!(mime.contains("image/png"));
        assert!(mime.contains("multipart/related"));
        let raw = raw_urlsafe(&mime);
        assert!(!raw.contains('+') && !raw.contains('/'));
    }

    #[test]
    fn does_not_duplicate_nela_footer() {
        let mime = build_rfc2822(
            "me@gmail.com",
            &["priya@example.com".into()],
            &[],
            &[],
            "Hi",
            "Hello\n\nThis message was sent using nela",
        )
        .unwrap();
        assert_eq!(mime.matches("This message was sent using nela").count(), 2);
    }

    #[test]
    fn rejects_empty_to() {
        assert!(build_rfc2822("me@gmail.com", &[], &[], &[], "Hi", "Body").is_err());
    }

    #[test]
    fn rejects_oversized_body() {
        let body = "x".repeat(MAX_BODY_CHARS + 1);
        assert!(build_rfc2822("me@gmail.com", &["a@b.com".into()], &[], &[], "Hi", &body).is_err());
    }

    #[test]
    fn splits_and_dedupes_recipients() {
        let got = normalize_recipients(&["a@b.com, c@d.com".into(), "A@b.com".into()]).unwrap();
        assert_eq!(got, vec!["a@b.com".to_string(), "c@d.com".to_string()]);
        let spoken = normalize_recipients(&["a@b.com and c@d.com".into()]).unwrap();
        assert_eq!(spoken, vec!["a@b.com".to_string(), "c@d.com".to_string()]);
    }

    #[test]
    fn parse_store_requires_refresh() {
        assert!(parse_store(r#"{"refresh_token":"","email":"a@b.com"}"#).is_none());
        let store = parse_store(r#"{"refresh_token":"rt","email":"a@b.com"}"#).unwrap();
        assert_eq!(store.refresh_token, "rt");
        assert_eq!(store.email.as_deref(), Some("a@b.com"));
    }
}
