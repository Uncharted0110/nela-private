//! PDF parser — Pass 1 uses pdf-extract (fast, panic-classified);
//! Pass 2 uses pdfium-render → lopdf (no pdf-extract) for robust recovery.

use super::traits::{DocumentParser, ParsedContainer, ParsedContentBlock, ParsedDocument};
use crate::doc_graph::errors::ParserError;
use crate::doc_graph::graph::schema::{BlockType, ContainerType};
use std::path::Path;

pub struct PdfParser;

/// Hard caps to keep PDF extraction bounded during bulk indexing.
const MAX_PDF_PAGES: usize = 100;
const MAX_PDF_TEXT_BYTES: usize = 5_000_000;

impl DocumentParser for PdfParser {
    fn can_parse(&self, extension: &str) -> bool {
        extension == "pdf"
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParserError> {
        // Pass 1: categorize failures; never swallow encrypted / scanned as retriable.
        parse_pass1(path)
    }
}

fn document_title(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document.pdf")
        .to_string()
}

/// Pass 1 fast path: encrypt/scanned checks + pdf-extract only.
fn parse_pass1(path: &Path) -> Result<ParsedDocument, ParserError> {
    classify_pdf_precheck(path)?;

    let text = extract_with_pdf_extract(path)?;
    if text.trim().is_empty() {
        return Err(classify_empty_text(path));
    }

    text_to_document(document_title(path), text)
}

/// Pass 2 robust fallback: pdfium-render, then lopdf — never calls pdf-extract.
/// Wrapped in `catch_unwind` so a panicking file cannot kill the Pass 2 batch.
pub fn parse_pass2_fallback(path: &Path) -> Result<ParsedDocument, ParserError> {
    let path_buf = path.to_path_buf();
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| parse_pass2_inner(&path_buf))) {
        Ok(result) => result,
        Err(_) => Err(ParserError::ParseFailure(format!(
            "{}: Pass 2 PDF fallback panicked",
            path.display()
        ))),
    }
}

fn parse_pass2_inner(path: &Path) -> Result<ParsedDocument, ParserError> {
    // Only treat definitive encryption as fatal; other precheck failures still try pdfium.
    if let Err(e @ ParserError::EncryptedPdf(_)) = classify_pdf_precheck(path) {
        return Err(e);
    }

    let text = match extract_with_pdfium(path) {
        Ok(t) if !t.trim().is_empty() => t,
        Ok(_) | Err(_) => {
            log::warn!(
                "Pass 2 pdfium empty/failed for {}; trying lopdf",
                path.display()
            );
            match extract_with_lopdf(path) {
                Ok(t) if !t.trim().is_empty() => t,
                Ok(_) => return Err(classify_empty_text(path)),
                Err(e @ ParserError::EncryptedPdf(_))
                | Err(e @ ParserError::ScannedImage(_)) => return Err(e),
                Err(e) => {
                    return Err(ParserError::ParseFailure(format!(
                        "{}: Pass 2 fallback failed: {e}",
                        path.display()
                    )));
                }
            }
        }
    };

    text_to_document(document_title(path), text)
}

/// Detect encrypted PDFs (and hard load failures that look encrypted) before extraction.
fn classify_pdf_precheck(path: &Path) -> Result<(), ParserError> {
    let load = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        lopdf::Document::load(path)
    }));

    match load {
        Ok(Ok(doc)) => {
            if doc.is_encrypted() {
                return Err(ParserError::EncryptedPdf(format!(
                    "{}: password-protected",
                    path.display()
                )));
            }
            Ok(())
        }
        Ok(Err(e)) => {
            let msg = e.to_string();
            let lower = msg.to_ascii_lowercase();
            if lower.contains("encrypt") || lower.contains("password") {
                Err(ParserError::EncryptedPdf(format!(
                    "{}: {msg}",
                    path.display()
                )))
            } else {
                // Load failed for other reasons — let extractors try / classify later.
                Ok(())
            }
        }
        Err(_) => {
            // lopdf panicked on load — treat as retriable so Pass 2 can try pdfium.
            Err(ParserError::RetriablePdfError(format!(
                "{}: lopdf panicked during precheck",
                path.display()
            )))
        }
    }
}

/// After empty extraction: confirm scanned (0 text operators) vs keep ScannedImage anyway.
fn classify_empty_text(path: &Path) -> ParserError {
    let zero_ops = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let doc = lopdf::Document::load(path).ok()?;
        Some(pdf_has_zero_text_objects(&doc))
    }))
    .ok()
    .flatten()
    .unwrap_or(true);

    if zero_ops {
        ParserError::ScannedImage(format!(
            "{}: 0 text objects / no extractable PDF text",
            path.display()
        ))
    } else {
        // Content streams claim text but extractors got nothing — still non-retriable image/font issue.
        ParserError::ScannedImage(format!(
            "{}: text operators present but no extractable glyphs",
            path.display()
        ))
    }
}

/// Heuristic: look for common PDF text-showing operators in page content.
fn pdf_has_zero_text_objects(doc: &lopdf::Document) -> bool {
    let pages = doc.get_pages();
    if pages.is_empty() {
        return true;
    }
    let mut page_nums: Vec<u32> = pages.keys().copied().collect();
    page_nums.sort_unstable();
    let mut saw_any_content = false;
    for page_num in page_nums.into_iter().take(MAX_PDF_PAGES) {
        let Some(&page_id) = pages.get(&page_num) else {
            continue;
        };
        let Ok(content_data) = doc.get_page_content(page_id) else {
            continue;
        };
        saw_any_content = true;
        if content_has_text_operator(&content_data) {
            return false;
        }
    }
    if !saw_any_content {
        return false;
    }
    true
}

fn content_has_text_operator(data: &[u8]) -> bool {
    let s = String::from_utf8_lossy(data);
    for token in s.split(|c: char| c.is_whitespace()) {
        match token {
            "Tj" | "TJ" | "'" | "\"" => return true,
            _ => {}
        }
    }
    false
}

fn extract_with_pdf_extract(path: &Path) -> Result<String, ParserError> {
    let path_buf = path.to_path_buf();
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pdf_extract::extract_text(&path_buf)
    })) {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(e)) => {
            let msg = e.to_string();
            let lower = msg.to_ascii_lowercase();
            if lower.contains("encrypt") || lower.contains("password") {
                Err(ParserError::EncryptedPdf(format!(
                    "{}: {msg}",
                    path.display()
                )))
            } else {
                Err(ParserError::RetriablePdfError(format!(
                    "{}: pdf-extract error: {msg}",
                    path.display()
                )))
            }
        }
        Err(_) => Err(ParserError::RetriablePdfError(format!(
            "{}: pdf-extract panicked during extraction",
            path.display()
        ))),
    }
}

fn extract_with_pdfium(path: &Path) -> Result<String, ParserError> {
    use pdfium_render::prelude::*;

    let bindings = resolve_pdfium_bindings().map_err(|e| {
        ParserError::ParseFailure(format!("pdfium unavailable: {e}"))
    })?;
    let pdfium = Pdfium::new(bindings);

    let doc = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| {
            let msg = e.to_string();
            let lower = msg.to_ascii_lowercase();
            if lower.contains("password") || lower.contains("encrypt") {
                ParserError::EncryptedPdf(format!("{}: {msg}", path.display()))
            } else {
                ParserError::ParseFailure(format!("{}: pdfium load: {msg}", path.display()))
            }
        })?;

    let mut out = String::new();
    for (idx, page) in doc.pages().iter().enumerate() {
        if idx >= MAX_PDF_PAGES || out.len() >= MAX_PDF_TEXT_BYTES {
            break;
        }
        match page.text() {
            Ok(text) => {
                out.push_str(&text.all());
                out.push('\u{0C}');
            }
            Err(e) => {
                log::debug!("pdfium page {} text failed: {e}", idx + 1);
            }
        }
    }

    if out.trim().is_empty() {
        Err(ParserError::ScannedImage(format!(
            "{}: pdfium found no text",
            path.display()
        )))
    } else {
        Ok(truncate_text(out))
    }
}

fn resolve_pdfium_bindings(
) -> Result<Box<dyn pdfium_render::prelude::PdfiumLibraryBindings>, String> {
    use pdfium_render::prelude::Pdfium;

    let os_folder = if cfg!(windows) {
        "pdfium-win"
    } else if cfg!(target_os = "macos") {
        "pdfium-mac"
    } else {
        "pdfium-lin"
    };
    let lib_name = if cfg!(windows) {
        "pdfium.dll"
    } else if cfg!(target_os = "macos") {
        "libpdfium.dylib"
    } else {
        "libpdfium.so"
    };

    match crate::paths::resolve_bundled_library(os_folder, lib_name) {
        Ok(candidate) => {
            let dir = candidate
                .parent()
                .ok_or_else(|| "pdfium path has no parent".to_string())?
                .to_str()
                .ok_or_else(|| "pdfium path is not utf-8".to_string())?;
            let lib_path = Pdfium::pdfium_platform_library_name_at_path(dir);
            Pdfium::bind_to_library(&lib_path).map_err(|e| e.to_string())
        }
        Err(bundled_err) => Pdfium::bind_to_system_library().map_err(|sys_err| {
            format!("libpdfium not available. Bundled: {bundled_err}. System: {sys_err}")
        }),
    }
}

fn extract_with_lopdf(path: &Path) -> Result<String, ParserError> {
    let doc = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        lopdf::Document::load(path)
    })) {
        Ok(Ok(doc)) => doc,
        Ok(Err(e)) => {
            let msg = e.to_string();
            let lower = msg.to_ascii_lowercase();
            if lower.contains("encrypt") || lower.contains("password") {
                return Err(ParserError::EncryptedPdf(format!(
                    "{}: {msg}",
                    path.display()
                )));
            }
            return Err(ParserError::ParseFailure(format!(
                "lopdf load failed: {msg}"
            )));
        }
        Err(_) => {
            return Err(ParserError::ParseFailure(
                "lopdf panicked while loading PDF".into(),
            ));
        }
    };

    if doc.is_encrypted() {
        return Err(ParserError::EncryptedPdf(format!(
            "{}: password-protected",
            path.display()
        )));
    }

    let mut out = String::new();
    let mut pages_done = 0usize;
    let mut page_nums: Vec<u32> = doc.get_pages().keys().copied().collect();
    page_nums.sort_unstable();
    for page_num in page_nums {
        if pages_done >= MAX_PDF_PAGES || out.len() >= MAX_PDF_TEXT_BYTES {
            break;
        }
        let page_text = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            doc.extract_text(&[page_num])
        }));
        match page_text {
            Ok(Ok(text)) => {
                out.push_str(&text);
                out.push('\u{0C}');
                pages_done += 1;
            }
            Ok(Err(_)) | Err(_) => {
                pages_done += 1;
            }
        }
    }

    if out.trim().is_empty() {
        return Err(ParserError::ScannedImage(format!(
            "{}: no extractable PDF text",
            path.display()
        )));
    }
    Ok(truncate_text(out))
}

fn truncate_text(mut text: String) -> String {
    if text.len() > MAX_PDF_TEXT_BYTES {
        text.truncate(MAX_PDF_TEXT_BYTES);
        while !text.is_char_boundary(text.len()) {
            text.pop();
        }
    }
    text
}

fn text_to_document(title: String, text: String) -> Result<ParsedDocument, ParserError> {
    let text = truncate_text(text);

    let pages: Vec<&str> = if text.contains('\u{0C}') {
        text.split('\u{0C}').collect()
    } else {
        let paras: Vec<&str> = text
            .split("\n\n")
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .collect();
        if paras.is_empty() {
            return Err(ParserError::ScannedImage(
                "no extractable text blocks".into(),
            ));
        }
        let mut containers = Vec::new();
        for (page_idx, chunk) in paras.chunks(8).enumerate() {
            if page_idx >= MAX_PDF_PAGES {
                break;
            }
            let blocks: Vec<ParsedContentBlock> = chunk
                .iter()
                .map(|p| ParsedContentBlock {
                    content: p.to_string(),
                    block_type: if p.len() < 80 && !p.contains('\n') {
                        BlockType::Header
                    } else {
                        BlockType::Paragraph
                    },
                })
                .collect();
            let page_title = blocks
                .first()
                .map(|b| b.content.chars().take(60).collect::<String>())
                .unwrap_or_else(|| format!("Page {}", page_idx + 1));
            containers.push(ParsedContainer {
                title: page_title,
                container_type: ContainerType::Page {
                    number: page_idx + 1,
                },
                ordinal: page_idx,
                blocks,
            });
        }
        if containers.is_empty() {
            return Err(ParserError::ScannedImage("no extractable pages".into()));
        }
        return Ok(ParsedDocument { title, containers });
    };

    let mut containers = Vec::new();
    for (i, page) in pages.iter().enumerate().take(MAX_PDF_PAGES) {
        let trimmed = page.trim();
        if trimmed.is_empty() {
            continue;
        }
        let blocks: Vec<ParsedContentBlock> = trimmed
            .split("\n\n")
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(|p| ParsedContentBlock {
                content: p.to_string(),
                block_type: BlockType::Paragraph,
            })
            .collect();
        if blocks.is_empty() {
            continue;
        }
        containers.push(ParsedContainer {
            title: format!("Page {}", i + 1),
            container_type: ContainerType::Page { number: i + 1 },
            ordinal: i,
            blocks,
        });
    }

    if containers.is_empty() {
        return Err(ParserError::ScannedImage(
            "encrypted or zero-text PDF".into(),
        ));
    }

    Ok(ParsedDocument { title, containers })
}
