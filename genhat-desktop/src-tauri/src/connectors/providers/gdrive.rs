//! Google Drive connector — desktop talks to Drive API directly.

use crate::connectors::connections;
use crate::connectors::credentials::{self, StoredCredential};
use crate::connectors::error::ConnectorError;
use crate::connectors::mirror;
use crate::connectors::oauth_client;
use crate::connectors::types::{
    ConnectionId, EntryKind, RemoteEntry, RemoteId, SyncReport,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const DRIVE_API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveFile {
    id: String,
    name: String,
    mime_type: Option<String>,
    size: Option<String>,
    modified_time: Option<String>,
    md5_checksum: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListResponse {
    files: Option<Vec<DriveFile>>,
    next_page_token: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn http_client() -> Result<reqwest::Client, ConnectorError> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| ConnectorError::network(e.to_string()))
}

async fn access_token(app_data: &Path, conn: &ConnectionId) -> Result<String, ConnectorError> {
    let cred = credentials::get(app_data, &conn.0)
        .map_err(ConnectorError::io)?
        .ok_or_else(ConnectorError::needs_reauth)?;

    let fresh = match cred.expires_at_epoch_ms {
        Some(exp) if exp > now_ms() + 60_000 => cred.access_token.clone(),
        _ => None,
    };
    if let Some(token) = fresh {
        return Ok(token);
    }

    // Prefer on-device refresh (desktop PKCE client). Fall back to cloud broker
    // for connections created before Drive moved off the broker.
    let refreshed = match crate::connectors::desktop_pkce::refresh_access_token(&cred.refresh_token)
        .await
    {
        Ok(r) => oauth_client::RefreshResponse {
            access_token: r.access_token,
            expires_in: r.expires_in,
            refresh_token: r.refresh_token,
        },
        Err(_) => oauth_client::oauth_refresh(&cred.refresh_token)
            .await
            .map_err(|_| ConnectorError::needs_reauth())?,
    };

    let expires_at = refreshed
        .expires_in
        .map(|secs| now_ms() + (secs as i64) * 1000);

    if let Some(new_refresh) = refreshed.refresh_token.as_deref() {
        let mut updated = cred.clone();
        updated.refresh_token = new_refresh.to_string();
        updated.access_token = Some(refreshed.access_token.clone());
        updated.expires_at_epoch_ms = expires_at;
        credentials::save(app_data, &conn.0, updated).map_err(ConnectorError::io)?;
    } else {
        credentials::update_access_token(app_data, &conn.0, &refreshed.access_token, expires_at)
            .map_err(ConnectorError::io)?;
    }

    let _ = connections::set_status(
        app_data,
        conn,
        crate::connectors::types::ConnectionStatus::Connected,
    );

    Ok(refreshed.access_token)
}

fn mark_reauth(app_data: &Path, conn: &ConnectionId) {
    let _ = connections::set_status(
        app_data,
        conn,
        crate::connectors::types::ConnectionStatus::NeedsReauth,
    );
}

async fn drive_get_json(
    client: &reqwest::Client,
    token: &str,
    url: &str,
) -> Result<Value, ConnectorError> {
    let resp = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| ConnectorError::network(e.to_string()))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(ConnectorError::needs_reauth());
    }
    if !status.is_success() {
        log::warn!("Drive GET failed {status}: {body}");
        return Err(ConnectorError::network(
            "Google Drive request failed. Please try again.".to_string(),
        ));
    }
    serde_json::from_str(&body).map_err(|e| ConnectorError::network(e.to_string()))
}

fn export_spec(mime: &str) -> Option<(&'static str, &'static str)> {
    match mime {
        "application/vnd.google-apps.document" => Some((
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "docx",
        )),
        "application/vnd.google-apps.spreadsheet" => Some((
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "xlsx",
        )),
        "application/vnd.google-apps.presentation" => Some((
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "pptx",
        )),
        "application/vnd.google-apps.drawing" => Some(("application/pdf", "pdf")),
        _ => None,
    }
}

fn is_google_native(mime: &str) -> bool {
    mime.starts_with("application/vnd.google-apps.")
}

fn file_relative_name(file: &DriveFile) -> String {
    let mime = file.mime_type.as_deref().unwrap_or("");
    if let Some((_, ext)) = export_spec(mime) {
        let stem = file
            .name
            .trim_end_matches(|c| c == '.')
            .to_string();
        if stem.to_lowercase().ends_with(&format!(".{ext}")) {
            stem
        } else {
            format!("{stem}.{ext}")
        }
    } else {
        file.name.clone()
    }
}

fn to_entry(file: &DriveFile) -> RemoteEntry {
    let mime = file.mime_type.clone();
    let kind = if mime.as_deref() == Some(FOLDER_MIME) {
        EntryKind::Folder
    } else {
        EntryKind::File
    };
    let size = file
        .size
        .as_ref()
        .and_then(|s| s.parse::<u64>().ok());
    RemoteEntry {
        id: RemoteId(file.id.clone()),
        name: file.name.clone(),
        kind,
        mime_type: mime,
        size,
        modified_at: file.modified_time.clone(),
    }
}

async fn list_page(
    client: &reqwest::Client,
    token: &str,
    parent_id: &str,
    page_token: Option<&str>,
) -> Result<(Vec<DriveFile>, Option<String>), ConnectorError> {
    let q = format!(
        "'{}' in parents and trashed = false",
        parent_id.replace('\'', "\\'")
    );
    let mut url = reqwest::Url::parse(&format!("{DRIVE_API}/files"))
        .map_err(|e| ConnectorError::network(e.to_string()))?;
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("q", &q);
        qp.append_pair(
            "fields",
            "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)",
        );
        qp.append_pair("pageSize", "100");
        qp.append_pair("supportsAllDrives", "true");
        qp.append_pair("includeItemsFromAllDrives", "true");
        if let Some(pt) = page_token {
            qp.append_pair("pageToken", pt);
        }
    }
    let value = drive_get_json(client, token, url.as_str()).await?;
    let parsed: ListResponse =
        serde_json::from_value(value).map_err(|e| ConnectorError::network(e.to_string()))?;
    Ok((parsed.files.unwrap_or_default(), parsed.next_page_token))
}

async fn list_all_children(
    client: &reqwest::Client,
    token: &str,
    parent_id: &str,
) -> Result<Vec<DriveFile>, ConnectorError> {
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let (files, next) = list_page(client, token, parent_id, page.as_deref()).await?;
        out.extend(files);
        if next.is_none() {
            break;
        }
        page = next;
    }
    Ok(out)
}

async fn download_bytes(
    client: &reqwest::Client,
    token: &str,
    file: &DriveFile,
) -> Result<Vec<u8>, ConnectorError> {
    let mime = file.mime_type.as_deref().unwrap_or("");
    let url = if let Some((export_mime, _)) = export_spec(mime) {
        format!(
            "{DRIVE_API}/files/{}/export?mimeType={}",
            file.id,
            urlencoding_lite(export_mime)
        )
    } else if is_google_native(mime) {
        return Err(ConnectorError::invalid(format!(
            "Unsupported Google file type: {mime}"
        )));
    } else {
        format!("{DRIVE_API}/files/{}?alt=media", file.id)
    };

    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| ConnectorError::network(e.to_string()))?;
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(ConnectorError::needs_reauth());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        log::warn!("Drive download failed {status}: {body}");
        return Err(ConnectorError::network(
            "Couldn't download that file from Google Drive.".to_string(),
        ));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| ConnectorError::network(e.to_string()))
}

fn urlencoding_lite(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn sidecar_path(local_file: &Path) -> PathBuf {
    let mut name = local_file
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    name.push_str(".nela-meta.json");
    local_file
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(name)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSidecar {
    remote_id: String,
    md5: Option<String>,
    modified_at: Option<String>,
    mime_type: Option<String>,
}

use serde::Serialize;

fn read_sidecar(path: &Path) -> Option<FileSidecar> {
    let raw = std::fs::read_to_string(sidecar_path(path)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_sidecar(path: &Path, side: &FileSidecar) -> Result<(), ConnectorError> {
    let raw = serde_json::to_string_pretty(side).map_err(|e| ConnectorError::io(e.to_string()))?;
    std::fs::write(sidecar_path(path), raw).map_err(|e| ConnectorError::io(e.to_string()))
}

pub async fn list_children(
    app_data: &Path,
    conn: &ConnectionId,
    parent: Option<&RemoteId>,
) -> Result<Vec<RemoteEntry>, ConnectorError> {
    let token = match access_token(app_data, conn).await {
        Ok(t) => t,
        Err(e) => {
            if e.code == "NEEDS_REAUTH" {
                mark_reauth(app_data, conn);
            }
            return Err(e);
        }
    };
    let parent_id = parent.map(|p| p.0.as_str()).unwrap_or("root");
    let client = http_client()?;
    let files = list_all_children(&client, &token, parent_id).await?;
    let mut entries: Vec<_> = files.iter().map(to_entry).collect();
    entries.sort_by(|a, b| {
        match (&a.kind, &b.kind) {
            (EntryKind::Folder, EntryKind::File) => std::cmp::Ordering::Less,
            (EntryKind::File, EntryKind::Folder) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    Ok(entries)
}

pub async fn sync_folder(
    app_data: &Path,
    conn: &ConnectionId,
    remote_folder: Option<&RemoteId>,
) -> Result<SyncReport, ConnectorError> {
    let token = match access_token(app_data, conn).await {
        Ok(t) => t,
        Err(e) => {
            if e.code == "NEEDS_REAUTH" {
                mark_reauth(app_data, conn);
            }
            return Err(e);
        }
    };
    let client = http_client()?;
    let mirror_root = mirror::ensure_mirror(app_data, &conn.0).map_err(ConnectorError::io)?;
    let root_id = remote_folder
        .map(|r| r.0.clone())
        .unwrap_or_else(|| "root".to_string());

    let mut fetched = 0usize;
    let mut updated = 0usize;
    let removed = 0usize;

    // BFS: (remote_folder_id, relative_path_prefix)
    let mut queue: VecDeque<(String, String)> = VecDeque::new();
    queue.push_back((root_id.clone(), String::new()));

    while let Some((folder_id, prefix)) = queue.pop_front() {
        let children = list_all_children(&client, &token, &folder_id).await?;
        for child in children {
            let mime = child.mime_type.as_deref().unwrap_or("");
            if mime == FOLDER_MIME {
                let rel = if prefix.is_empty() {
                    child.name.clone()
                } else {
                    format!("{prefix}/{}", child.name)
                };
                let dir = mirror_root.join(&rel);
                std::fs::create_dir_all(&dir).map_err(|e| ConnectorError::io(e.to_string()))?;
                queue.push_back((child.id, rel));
                continue;
            }

            let name = file_relative_name(&child);
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let dest = mirror_root.join(&rel);
            let needs = match read_sidecar(&dest) {
                Some(side)
                    if side.remote_id == child.id
                        && side.md5 == child.md5_checksum
                        && side.modified_at == child.modified_time
                        && dest.exists() =>
                {
                    false
                }
                Some(_) if dest.exists() => {
                    updated += 1;
                    true
                }
                _ => {
                    fetched += 1;
                    true
                }
            };
            if !needs {
                continue;
            }
            let bytes = download_bytes(&client, &token, &child).await?;
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| ConnectorError::io(e.to_string()))?;
            }
            std::fs::write(&dest, &bytes).map_err(|e| ConnectorError::io(e.to_string()))?;
            write_sidecar(
                &dest,
                &FileSidecar {
                    remote_id: child.id.clone(),
                    md5: child.md5_checksum.clone(),
                    modified_at: child.modified_time.clone(),
                    mime_type: child.mime_type.clone(),
                },
            )?;
        }
    }

    let now = chrono_like_now();
    let mut meta = mirror::read_meta(&mirror_root).unwrap_or_default();
    meta.connection_id = conn.0.clone();
    meta.provider_id = "gdrive".into();
    meta.remote_folder_id = Some(root_id);
    meta.last_sync_at = Some(now.clone());
    mirror::write_meta(&mirror_root, &meta).map_err(ConnectorError::io)?;

    if let Ok(Some(mut info)) = connections::get(app_data, conn) {
        info.mirror_root = Some(mirror_root.display().to_string());
        info.remote_folder_id = meta.remote_folder_id.clone();
        info.last_sync_at = Some(now);
        info.status = crate::connectors::types::ConnectionStatus::Connected;
        let _ = connections::upsert(app_data, info);
    }

    Ok(SyncReport {
        mirror_root,
        fetched,
        updated,
        removed,
    })
}

fn chrono_like_now() -> String {
    // RFC3339-ish without chrono dependency if missing — use SystemTime
    let ms = now_ms();
    format!("{ms}")
}

pub async fn fetch_file(
    app_data: &Path,
    conn: &ConnectionId,
    id: &RemoteId,
) -> Result<PathBuf, ConnectorError> {
    let token = access_token(app_data, conn).await?;
    let client = http_client()?;
    let url = format!(
        "{DRIVE_API}/files/{}?fields=id,name,mimeType,size,modifiedTime,md5Checksum&supportsAllDrives=true",
        id.0
    );
    let value = drive_get_json(&client, &token, &url).await?;
    let file: DriveFile =
        serde_json::from_value(value).map_err(|e| ConnectorError::network(e.to_string()))?;
    let mirror_root = mirror::ensure_mirror(app_data, &conn.0).map_err(ConnectorError::io)?;
    let name = file_relative_name(&file);
    let dest = mirror_root.join("_fetched").join(&name);
    let bytes = download_bytes(&client, &token, &file).await?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ConnectorError::io(e.to_string()))?;
    }
    std::fs::write(&dest, &bytes).map_err(|e| ConnectorError::io(e.to_string()))?;
    write_sidecar(
        &dest,
        &FileSidecar {
            remote_id: file.id,
            md5: file.md5_checksum,
            modified_at: file.modified_time,
            mime_type: file.mime_type,
        },
    )?;
    Ok(dest)
}

pub async fn create_file(
    app_data: &Path,
    conn: &ConnectionId,
    parent: Option<&RemoteId>,
    name: &str,
    bytes: &[u8],
    mime: Option<&str>,
) -> Result<RemoteEntry, ConnectorError> {
    let token = access_token(app_data, conn).await?;
    let client = http_client()?;
    let parent_id = parent.map(|p| p.0.as_str()).unwrap_or("root");
    let mime_type = mime.unwrap_or("application/octet-stream");

    let metadata = serde_json::json!({
        "name": name,
        "parents": [parent_id],
    });

    let boundary = format!("nela_{}", now_ms());
    let mut body = Vec::new();
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(metadata.to_string().as_bytes());
    body.extend_from_slice(
        format!("\r\n--{boundary}\r\nContent-Type: {mime_type}\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let url = format!("{UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,md5Checksum&supportsAllDrives=true");
    let resp = client
        .post(&url)
        .bearer_auth(&token)
        .header(
            "Content-Type",
            format!("multipart/related; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| ConnectorError::network(e.to_string()))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        mark_reauth(app_data, conn);
        return Err(ConnectorError::needs_reauth());
    }
    if !status.is_success() {
        log::warn!("Drive create failed {status}: {text}");
        return Err(ConnectorError::network(
            "Couldn't save that file to Google Drive.".to_string(),
        ));
    }
    let file: DriveFile =
        serde_json::from_str(&text).map_err(|e| ConnectorError::network(e.to_string()))?;

    // Write-through to mirror
    let mirror_root = mirror::ensure_mirror(app_data, &conn.0).map_err(ConnectorError::io)?;
    let dest = mirror_root.join(name);
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&dest, bytes);
    let _ = write_sidecar(
        &dest,
        &FileSidecar {
            remote_id: file.id.clone(),
            md5: file.md5_checksum.clone(),
            modified_at: file.modified_time.clone(),
            mime_type: file.mime_type.clone(),
        },
    );

    Ok(to_entry(&file))
}

pub async fn update_file(
    app_data: &Path,
    conn: &ConnectionId,
    id: &RemoteId,
    bytes: &[u8],
) -> Result<RemoteEntry, ConnectorError> {
    let token = access_token(app_data, conn).await?;
    let client = http_client()?;
    let url = format!(
        "{UPLOAD_API}/files/{}?uploadType=media&fields=id,name,mimeType,size,modifiedTime,md5Checksum&supportsAllDrives=true",
        id.0
    );
    let resp = client
        .patch(&url)
        .bearer_auth(&token)
        .header("Content-Type", "application/octet-stream")
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|e| ConnectorError::network(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        mark_reauth(app_data, conn);
        return Err(ConnectorError::needs_reauth());
    }
    if !status.is_success() {
        log::warn!("Drive update failed {status}: {text}");
        return Err(ConnectorError::network(
            "Couldn't update that file on Google Drive.".to_string(),
        ));
    }
    let file: DriveFile =
        serde_json::from_str(&text).map_err(|e| ConnectorError::network(e.to_string()))?;
    Ok(to_entry(&file))
}

pub fn store_new_connection(
    app_data: &Path,
    connection_id: &str,
    email: Option<String>,
    display_name: String,
    access_token: String,
    refresh_token: String,
    expires_in: Option<u64>,
    scopes: Vec<String>,
) -> Result<crate::connectors::types::ConnectionInfo, String> {
    let expires_at = expires_in.map(|s| now_ms() + (s as i64) * 1000);
    credentials::save(
        app_data,
        connection_id,
        StoredCredential {
            refresh_token,
            access_token: Some(access_token),
            expires_at_epoch_ms: expires_at,
            scopes,
        },
    )?;
    let info = crate::connectors::types::ConnectionInfo {
        id: ConnectionId(connection_id.to_string()),
        provider_id: "gdrive".into(),
        display_name,
        account_email: email,
        remote_folder_id: None,
        remote_folder_name: None,
        mirror_root: None,
        last_sync_at: None,
        status: crate::connectors::types::ConnectionStatus::Connected,
    };
    connections::upsert(app_data, info.clone())?;
    Ok(info)
}
