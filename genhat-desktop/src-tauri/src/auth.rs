//! Local user profile persistence and Google OAuth (PKCE + loopback).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

const PROFILE_FILE: &str = "profile.json";
const OAUTH_TIMEOUT_SECS: u64 = 300;
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v3/userinfo";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UserPlan {
    Free,
    Premium,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub id: String,
    pub name: String,
    pub email: String,
    pub avatar: Option<AvatarSource>,
    pub plan: UserPlan,
    pub auth_provider: AuthProvider,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredTokens {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProfileStore {
    profile: Option<UserProfile>,
    tokens: StoredTokens,
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    token_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleUserInfo {
    sub: String,
    name: Option<String>,
    email: Option<String>,
    picture: Option<String>,
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
    let raw = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize profile: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("Failed to write profile: {e}"))
}

pub fn get_user_profile(app_data_dir: &Path) -> Result<Option<UserProfile>, String> {
    Ok(read_store(app_data_dir)?.profile)
}

/// Persist editable profile fields. Plan cannot be upgraded via this path.
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

pub fn set_user_plan(app_data_dir: &Path, plan: UserPlan) -> Result<UserProfile, String> {
    let mut store = read_store(app_data_dir)?;
    let mut profile = store
        .profile
        .clone()
        .ok_or_else(|| "No profile to update. Sign in first.".to_string())?;
    profile.plan = plan;
    profile.updated_at = Utc::now().to_rfc3339();
    store.profile = Some(profile.clone());
    write_store(app_data_dir, &store)?;
    Ok(profile)
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

fn random_urlsafe(nbytes: usize) -> String {
    let mut bytes = Vec::with_capacity(nbytes);
    while bytes.len() < nbytes {
        bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    }
    bytes.truncate(nbytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

fn load_dotenv_files() {
    // Do not override vars already present in the process environment.
    for path in [
        std::path::PathBuf::from(".env"),
        std::path::PathBuf::from("../.env"),
    ] {
        if path.is_file() {
            let _ = dotenvy::from_path(&path);
        }
    }
    let _ = dotenvy::dotenv();
}

fn google_client_id() -> Result<String, String> {
    load_dotenv_files();
    std::env::var("NELA_GOOGLE_CLIENT_ID")
        .map(|s| s.trim().to_string())
        .map_err(|_| {
            "NELA_GOOGLE_CLIENT_ID is not set. Copy .env.example to .env, paste your Client ID, then restart the app."
                .to_string()
        })
        .and_then(|id| {
            if id.is_empty() {
                Err("NELA_GOOGLE_CLIENT_ID is empty in your environment or .env file".into())
            } else {
                Ok(id)
            }
        })
}

fn google_client_secret() -> Result<String, String> {
    load_dotenv_files();
    std::env::var("NELA_GOOGLE_CLIENT_SECRET")
        .map(|s| s.trim().to_string())
        .map_err(|_| {
            "NELA_GOOGLE_CLIENT_SECRET is not set. Add the Desktop client secret from Google Cloud Console to .env, then restart."
                .to_string()
        })
        .and_then(|secret| {
            if secret.is_empty() {
                Err("NELA_GOOGLE_CLIENT_SECRET is empty in your .env file".into())
            } else {
                Ok(secret)
            }
        })
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or("").to_string();
        let value = parts
            .next()
            .map(|v| urlencoding::decode(v).unwrap_or_else(|_| v.into()).into_owned())
            .unwrap_or_default();
        map.insert(key, value);
    }
    map
}

async fn wait_for_oauth_code_on_listener(
    listener: TcpListener,
    expected_state: &str,
) -> Result<String, String> {
    let accept = async {
        loop {
            let (mut stream, _) = listener
                .accept()
                .await
                .map_err(|e| format!("OAuth accept failed: {e}"))?;

            let mut buf = vec![0u8; 8192];
            let n = stream
                .read(&mut buf)
                .await
                .map_err(|e| format!("OAuth read failed: {e}"))?;
            let request = String::from_utf8_lossy(&buf[..n]);
            let first_line = request.lines().next().unwrap_or("");
            let path_query = first_line.split_whitespace().nth(1).unwrap_or("/");

            if !path_query.starts_with("/callback") {
                let body = b"Not found";
                let response = format!(
                    "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.write_all(body).await;
                continue;
            }

            let query = path_query.splitn(2, '?').nth(1).unwrap_or("");
            let params = parse_query(query);

            if let Some(err) = params.get("error") {
                let desc = params
                    .get("error_description")
                    .cloned()
                    .unwrap_or_else(|| err.clone());
                let html = format!(
                    "<html><body style=\"font-family:sans-serif;padding:2rem\"><h2>Sign-in failed</h2><p>{}</p><p>You can close this window.</p></body></html>",
                    html_escape(&desc)
                );
                write_html_response(&mut stream, 400, &html).await;
                return Err(format!("Google OAuth error: {desc}"));
            }

            let state = params.get("state").cloned().unwrap_or_default();
            if state != expected_state {
                let html = "<html><body style=\"font-family:sans-serif;padding:2rem\"><h2>Invalid state</h2><p>You can close this window.</p></body></html>";
                write_html_response(&mut stream, 400, html).await;
                return Err("OAuth state mismatch".into());
            }

            let code = params
                .get("code")
                .cloned()
                .ok_or_else(|| "OAuth callback missing code".to_string())?;

            let html = "<html><body style=\"font-family:sans-serif;padding:2rem\"><h2>Signed in to NELA</h2><p>You can close this window and return to the app.</p></body></html>";
            write_html_response(&mut stream, 200, html).await;
            return Ok(code);
        }
    };

    tokio::time::timeout(Duration::from_secs(OAUTH_TIMEOUT_SECS), accept)
        .await
        .map_err(|_| "Google sign-in timed out. Please try again.".to_string())?
}

async fn write_html_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    html: &str,
) {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<GoogleTokenResponse, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|e| format!("Token request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed ({status}): {body}"));
    }

    resp.json::<GoogleTokenResponse>()
        .await
        .map_err(|e| format!("Invalid token response: {e}"))
}

async fn fetch_userinfo(access_token: &str) -> Result<GoogleUserInfo, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(GOOGLE_USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Userinfo request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Userinfo failed ({status}): {body}"));
    }

    resp.json::<GoogleUserInfo>()
        .await
        .map_err(|e| format!("Invalid userinfo response: {e}"))
}

/// Run Google OAuth PKCE flow. `open_url` opens the auth page in the system browser.
pub async fn start_google_oauth<F>(
    app_data_dir: &Path,
    open_url: F,
) -> Result<UserProfile, String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let client_id = google_client_id()?;
    let client_secret = google_client_secret()?;
    let port = portpicker::pick_unused_port().ok_or_else(|| "No free port for OAuth callback".to_string())?;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let state = random_urlsafe(16);
    let code_verifier = random_urlsafe(32);
    let code_challenge = pkce_challenge(&code_verifier);

    let auth_url = format!(
        "{GOOGLE_AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode("openid email profile"),
        urlencoding::encode(&code_challenge),
        urlencoding::encode(&state),
    );

    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("Failed to bind OAuth callback listener: {e}"))?;
    open_url(&auth_url)?;
    let code = wait_for_oauth_code_on_listener(listener, &state).await?;

    let tokens =
        exchange_code(&client_id, &client_secret, &code, &redirect_uri, &code_verifier).await?;
    let userinfo = fetch_userinfo(&tokens.access_token).await?;

    let email = userinfo
        .email
        .clone()
        .ok_or_else(|| "Google account did not return an email".to_string())?;
    let name = userinfo
        .name
        .clone()
        .unwrap_or_else(|| email.split('@').next().unwrap_or("User").to_string());

    let existing = read_store(app_data_dir)?;
    // New users always start Free; returning same Google account keeps prior plan (e.g. Premium).
    let plan = existing
        .profile
        .as_ref()
        .filter(|p| p.id == userinfo.sub || p.email.eq_ignore_ascii_case(&email))
        .map(|p| p.plan.clone())
        .unwrap_or(UserPlan::Free);

    let avatar = userinfo.picture.map(|url| AvatarSource {
        kind: AvatarKind::Google,
        value: url,
    });

    let profile = UserProfile {
        id: userinfo.sub,
        name,
        email,
        avatar,
        plan,
        auth_provider: AuthProvider::Google,
        updated_at: Utc::now().to_rfc3339(),
    };

    let expires_at = tokens
        .expires_in
        .map(|secs| Utc::now().timestamp() + secs);

    let store = ProfileStore {
        profile: Some(profile.clone()),
        tokens: StoredTokens {
            access_token: Some(tokens.access_token),
            refresh_token: tokens.refresh_token.or(existing.tokens.refresh_token),
            expires_at,
        },
    };
    write_store(app_data_dir, &store)?;
    let _ = tokens.token_type;

    Ok(profile)
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
