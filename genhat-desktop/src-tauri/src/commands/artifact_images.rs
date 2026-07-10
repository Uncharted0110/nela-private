//! Image assets for HTML / presentation artifacts (web URLs + document extraction).

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
use serde::Serialize;
use std::path::Path;

use crate::rag::parsers::{self, ElementKind};

#[derive(Debug, Clone, Serialize)]
pub struct ArtifactImageAsset {
    pub data_uri: String,
    pub caption: String,
    pub source: String,
}

fn browser_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ),
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("image/avif,image/webp,image/apng,image/*,*/*;q=0.8"),
    );
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers
}

fn mime_from_bytes(data: &[u8], url: &str) -> &'static str {
    if data.starts_with(&[0x89, b'P', b'N', b'G']) {
        return "image/png";
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg";
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return "image/gif";
    }
    if data.starts_with(b"RIFF") && data.len() > 12 && &data[8..12] == b"WEBP" {
        return "image/webp";
    }
    let lower = url.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    }
}

fn path_to_data_uri(path: &Path) -> Result<String, String> {
    let mime = match path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    };
    let data = std::fs::read(path).map_err(|e| format!("Failed to read image: {e}"))?;
    if data.len() > 4 * 1024 * 1024 {
        return Err("Image too large for artifact embedding (>4MB)".into());
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(&data)))
}

/// Download a remote image and return a base64 data URI for offline embedding.
#[tauri::command]
pub async fn download_image_data_uri(url: String) -> Result<String, String> {
    let url = url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("URL must be http(s)".into());
    }

    let client = reqwest::Client::builder()
        .default_headers(browser_headers())
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Image download failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Image download HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read image body: {e}"))?;

    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Downloaded image too large (>4MB)".into());
    }

    let mime = mime_from_bytes(&bytes, url);
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
}

/// Extract embedded images/tables from a local document as data URIs for artifacts.
#[tauri::command]
pub fn extract_document_images(path: String, max_images: Option<u32>) -> Result<Vec<ArtifactImageAsset>, String> {
    let max = max_images.unwrap_or(8).min(12) as usize;
    let doc_path = Path::new(&path);
    if !doc_path.exists() {
        return Err(format!("File not found: {path}"));
    }

    let ext = doc_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !matches!(ext.as_str(), "pdf" | "docx" | "pptx" | "doc" | "ppt") {
        return Ok(vec![]);
    }

    let media_dir = std::env::temp_dir().join(format!(
        "nela_artifact_images_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&media_dir).map_err(|e| format!("Temp dir: {e}"))?;

    let parsed = parsers::parse_document_with_media(doc_path, Some(&media_dir))?;
    let source_label = doc_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document")
        .to_string();

    let mut assets = Vec::new();
    for elem in parsed.media_elements() {
        if assets.len() >= max {
            break;
        }
        let Some(media_path) = elem.media_path.as_ref() else {
            continue;
        };
        let caption = if elem.text.trim().is_empty() {
            match elem.kind {
                ElementKind::Table => "Table from document".to_string(),
                _ => format!("Image from {source_label}"),
            }
        } else {
            elem.text.trim().chars().take(200).collect()
        };
        match path_to_data_uri(media_path) {
            Ok(data_uri) => assets.push(ArtifactImageAsset {
                data_uri,
                caption,
                source: source_label.clone(),
            }),
            Err(e) => log::debug!("Skipping document image {}: {e}", media_path.display()),
        }
    }

    let _ = std::fs::remove_dir_all(&media_dir);
    Ok(assets)
}
