//! On-device attachment inspection and just-in-time cloud encoding.
//!
//! Accepts only user-selected absolute paths. Never logs file bytes or data URLs.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;
const MAX_IMAGES: usize = 4;
const MAX_PDFS: usize = 3;
const MAX_EXTRACTED_CHARS: usize = 32_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSpec {
    pub path: String,
    #[serde(default)]
    pub pdf_engine: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedAttachment {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub size_bytes: u64,
    pub content_hash: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedCloudAttachment {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub size_bytes: u64,
    pub content_hash: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parser: Option<String>,
    pub destination: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extracted_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone)]
struct SniffedFile {
    path: PathBuf,
    name: String,
    mime: String,
    size_bytes: u64,
    content_hash: String,
    kind: AttachmentKind,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttachmentKind {
    Image,
    Pdf,
    ExtractedText,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string()
}

fn extension_lower(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

fn is_text_ext(ext: &str) -> bool {
    matches!(
        ext,
        "txt"
            | "md"
            | "json"
            | "toml"
            | "yaml"
            | "yml"
            | "rs"
            | "py"
            | "js"
            | "ts"
            | "jsx"
            | "tsx"
            | "c"
            | "cpp"
            | "h"
            | "java"
            | "go"
            | "rb"
            | "sh"
            | "bat"
            | "html"
            | "htm"
            | "css"
            | "scss"
            | "xml"
            | "log"
            | "sql"
            | "ini"
            | "cfg"
            | "csv"
            | "tsv"
    )
}

fn is_office_ext(ext: &str) -> bool {
    matches!(ext, "docx" | "pptx" | "xlsx" | "xls" | "ods")
}

fn sniff_mime(bytes: &[u8], path: &Path) -> Result<(String, AttachmentKind), String> {
    if bytes.starts_with(b"%PDF") {
        return Ok(("application/pdf".into(), AttachmentKind::Pdf));
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Ok(("image/png".into(), AttachmentKind::Image));
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Ok(("image/jpeg".into(), AttachmentKind::Image));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok(("image/gif".into(), AttachmentKind::Image));
    }
    if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        return Ok(("image/webp".into(), AttachmentKind::Image));
    }
    if bytes.starts_with(b"BM") {
        return Err(
            "BMP images are not supported. Convert the file to PNG, JPEG, WebP, or GIF.".into(),
        );
    }

    let ext = extension_lower(path);
    if bytes.starts_with(b"PK") && is_office_ext(&ext) {
        let mime = match ext.as_str() {
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "pptx" => {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ods" => "application/vnd.oasis.opendocument.spreadsheet",
            _ => "application/octet-stream",
        };
        return Ok((mime.into(), AttachmentKind::ExtractedText));
    }
    if ext == "xls" {
        return Ok(("application/vnd.ms-excel".into(), AttachmentKind::ExtractedText));
    }
    if is_text_ext(&ext) {
        let mime = match ext.as_str() {
            "json" => "application/json",
            "csv" => "text/csv",
            "html" | "htm" => "text/html",
            "xml" => "application/xml",
            _ => "text/plain",
        };
        return Ok((mime.into(), AttachmentKind::ExtractedText));
    }
    if ext == "pdf" {
        return Ok(("application/pdf".into(), AttachmentKind::Pdf));
    }
    Err(format!("Unsupported file type: .{ext}"))
}

fn validate_user_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("No file path was provided".into());
    }
    if trimmed.contains('\0') {
        return Err("Invalid file path".into());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("Attachments must be selected as absolute paths on this device".into());
    }
    if !path.is_file() {
        return Err(format!("File is missing or unreadable: {}", file_name(&path)));
    }
    Ok(path)
}

fn read_sniffed(path: PathBuf) -> Result<SniffedFile, String> {
    let meta = std::fs::metadata(&path).map_err(|_| {
        format!("Couldn't read {}", file_name(&path))
    })?;
    let size_bytes = meta.len();
    if size_bytes > MAX_FILE_BYTES {
        return Err(format!(
            "{} is larger than the 10 MB per-file limit",
            file_name(&path)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|_| {
        format!("Couldn't read {}", file_name(&path))
    })?;
    let (mime, kind) = sniff_mime(&bytes, &path)?;
    Ok(SniffedFile {
        name: file_name(&path),
        content_hash: sha256_hex(&bytes),
        path,
        mime,
        size_bytes,
        kind,
        bytes,
    })
}

fn extract_delimited_text(path: &Path, mime: &str) -> Result<String, String> {
    let parsed = crate::rag::parsers::parse_document(path)?;
    let combined = parsed
        .sections
        .iter()
        .filter_map(|section| {
            let text = section.text.trim();
            if text.is_empty() {
                return None;
            }
            if section.metadata.trim().is_empty() {
                Some(text.to_string())
            } else {
                Some(format!("[{}]\n{}", section.metadata.trim(), text))
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    if combined.trim().is_empty() {
        return Err(format!("No extractable text in {}", file_name(path)));
    }
    let mut snippet: String = combined.chars().take(MAX_EXTRACTED_CHARS).collect();
    if combined.chars().count() > MAX_EXTRACTED_CHARS {
        snippet.push_str("\n\n[truncated]");
    }
    let name = file_name(path);
    Ok(format!(
        "----- attached file: {name} ({mime}) -----\n{snippet}\n----- end attached file: {name} -----"
    ))
}

fn enforce_aggregate(files: &[SniffedFile]) -> Result<(), String> {
    let mut images = 0usize;
    let mut pdfs = 0usize;
    let mut total = 0u64;
    for file in files {
        total = total.saturating_add(file.size_bytes);
        match file.kind {
            AttachmentKind::Image => images += 1,
            AttachmentKind::Pdf => pdfs += 1,
            AttachmentKind::ExtractedText => {}
        }
    }
    if images > MAX_IMAGES {
        return Err(format!("At most {MAX_IMAGES} images can be attached per message"));
    }
    if pdfs > MAX_PDFS {
        return Err(format!("At most {MAX_PDFS} PDFs can be attached per message"));
    }
    if total > MAX_TOTAL_BYTES {
        return Err("Attached files exceed the 20 MB total limit".into());
    }
    Ok(())
}

fn unique_specs(specs: Vec<AttachmentSpec>) -> Result<Vec<AttachmentSpec>, String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for spec in specs {
        let path = validate_user_path(&spec.path)?;
        let key = path.to_string_lossy().to_string();
        if seen.insert(key.clone()) {
            out.push(AttachmentSpec {
                path: key,
                pdf_engine: spec.pdf_engine,
            });
        }
    }
    if out.is_empty() {
        return Err("No files were selected".into());
    }
    Ok(out)
}

/// Inspect user-selected files (MIME, hash, size) without encoding bytes for the API.
#[tauri::command]
pub async fn inspect_attachments(
    paths: Vec<String>,
) -> Result<Vec<InspectedAttachment>, String> {
    let specs = unique_specs(
        paths
            .into_iter()
            .map(|path| AttachmentSpec {
                path,
                pdf_engine: None,
            })
            .collect(),
    )?;
    tokio::task::spawn_blocking(move || {
        let mut sniffed = Vec::new();
        let mut results = Vec::new();
        for spec in specs {
            match read_sniffed(PathBuf::from(&spec.path)) {
                Ok(file) => {
                    results.push(InspectedAttachment {
                        path: file.path.to_string_lossy().to_string(),
                        name: file.name.clone(),
                        mime: file.mime.clone(),
                        size_bytes: file.size_bytes,
                        content_hash: file.content_hash.clone(),
                        kind: match file.kind {
                            AttachmentKind::Image => "image".into(),
                            AttachmentKind::Pdf => "pdf".into(),
                            AttachmentKind::ExtractedText => "extracted_text".into(),
                        },
                        error: None,
                    });
                    sniffed.push(file);
                }
                Err(err) => {
                    results.push(InspectedAttachment {
                        path: spec.path,
                        name: "attachment".into(),
                        mime: "application/octet-stream".into(),
                        size_bytes: 0,
                        content_hash: String::new(),
                        kind: "unsupported".into(),
                        error: Some(err),
                    });
                }
            }
        }
        if let Err(err) = enforce_aggregate(&sniffed) {
            return Err(err);
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("Attachment inspect failed: {e}"))?
}

/// Encode PDFs/images as data URLs or extract office/text content for a cloud turn.
/// Base64 is returned to the caller for the in-flight request only and must not be persisted.
#[tauri::command]
pub async fn prepare_cloud_attachments(
    files: Vec<AttachmentSpec>,
) -> Result<Vec<PreparedCloudAttachment>, String> {
    let specs = unique_specs(files)?;
    tokio::task::spawn_blocking(move || {
        let mut sniffed = Vec::new();
        let mut engines = Vec::new();
        for spec in specs {
            let file = read_sniffed(PathBuf::from(&spec.path))?;
            engines.push(spec.pdf_engine);
            sniffed.push(file);
        }
        enforce_aggregate(&sniffed)?;
        let mut out = Vec::new();
        for (file, engine) in sniffed.into_iter().zip(engines.into_iter()) {
            let prepared = match file.kind {
                AttachmentKind::Image => PreparedCloudAttachment {
                    path: file.path.to_string_lossy().to_string(),
                    name: file.name,
                    mime: file.mime.clone(),
                    size_bytes: file.size_bytes,
                    content_hash: file.content_hash,
                    kind: "image".into(),
                    parser: None,
                    destination: "cloud".into(),
                    data_url: Some(format!(
                        "data:{};base64,{}",
                        file.mime,
                        STANDARD.encode(&file.bytes)
                    )),
                    extracted_text: None,
                    warning: None,
                },
                AttachmentKind::Pdf => {
                    let parser = match engine.as_deref().map(|s| s.trim()) {
                        Some("mistral-ocr") => "mistral-ocr",
                        Some("native") => "native",
                        _ => "cloudflare-ai",
                    };
                    PreparedCloudAttachment {
                        path: file.path.to_string_lossy().to_string(),
                        name: file.name.clone(),
                        mime: file.mime.clone(),
                        size_bytes: file.size_bytes,
                        content_hash: file.content_hash,
                        kind: "pdf".into(),
                        parser: Some(parser.into()),
                        destination: "cloud".into(),
                        data_url: Some(format!(
                            "data:application/pdf;base64,{}",
                            STANDARD.encode(&file.bytes)
                        )),
                        extracted_text: None,
                        warning: None,
                    }
                }
                AttachmentKind::ExtractedText => {
                    let extracted = extract_delimited_text(&file.path, &file.mime)?;
                    PreparedCloudAttachment {
                        path: file.path.to_string_lossy().to_string(),
                        name: file.name,
                        mime: file.mime,
                        size_bytes: file.size_bytes,
                        content_hash: file.content_hash,
                        kind: "extracted_text".into(),
                        parser: Some("local-extract".into()),
                        destination: "cloud".into(),
                        data_url: None,
                        extracted_text: Some(extracted),
                        warning: None,
                    }
                }
            };
            out.push(prepared);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("Attachment prepare failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_png_and_rejects_bmp() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let (mime, kind) = sniff_mime(&png, Path::new("x.png")).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(kind, AttachmentKind::Image);

        let bmp = b"BM\x00\x00";
        let err = sniff_mime(bmp, Path::new("x.bmp")).unwrap_err();
        assert!(err.contains("BMP"));
    }

    #[test]
    fn sniffs_pdf_magic() {
        let (mime, kind) = sniff_mime(b"%PDF-1.7 rest", Path::new("notes.bin")).unwrap();
        assert_eq!(mime, "application/pdf");
        assert_eq!(kind, AttachmentKind::Pdf);
    }
}
