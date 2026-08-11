//! PDF parser — Pass 1 uses pdf-extract (fast, panic-classified);
//! Pass 2 uses per-page pdfium-render → lopdf dual-engine fallback.

use super::traits::{
    DocumentParser, ExtractionStats, ParsedContainer, ParsedContentBlock, ParsedDocument,
};
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

/// Pass 2 robust fallback: per-page pdfium → lopdf. Never calls pdf-extract.
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

    extract_pages_dual_engine(path)
}

/// Per-page dual-engine extraction: pdfium first, lopdf stream fallback per page.
fn extract_pages_dual_engine(path: &Path) -> Result<ParsedDocument, ParserError> {
    let page_count = pdf_page_count(path).unwrap_or(0).min(MAX_PDF_PAGES);
    if page_count == 0 {
        // Still try pdfium whole-doc path in case lopdf couldn't count pages.
        return extract_pages_via_pdfium_iter(path);
    }

    let mut containers = Vec::new();
    let mut pages_ok = 0u32;
    let mut pages_failed = 0u32;
    let mut total_bytes = 0usize;

    let pdfium_pages = load_pdfium_page_texts(path).ok();

    for page_idx in 0..page_count {
        if total_bytes >= MAX_PDF_TEXT_BYTES {
            break;
        }
        let page_num = (page_idx + 1) as u32;

        let mut page_text = String::new();
        let mut got = false;

        if let Some(ref pages) = pdfium_pages {
            if let Some(t) = pages.get(page_idx) {
                if !t.trim().is_empty() {
                    page_text = t.clone();
                    got = true;
                }
            }
        }

        if !got {
            match extract_lopdf_page(path, page_num) {
                Ok(t) if !t.trim().is_empty() => {
                    page_text = t;
                    got = true;
                }
                Ok(_) => {
                    // Empty page — blank page is OK (counts as ok with no blocks).
                    if page_looks_blank(path, page_num) {
                        pages_ok += 1;
                        continue;
                    }
                    pages_failed += 1;
                    log::warn!(
                        "PDF page {} failed to extract text ({})",
                        page_num,
                        path.display()
                    );
                    continue;
                }
                Err(e) => {
                    pages_failed += 1;
                    log::warn!(
                        "PDF page {} extraction error ({}): {e}",
                        page_num,
                        path.display()
                    );
                    continue;
                }
            }
        }

        if !got {
            pages_failed += 1;
            log::warn!(
                "PDF page {} failed to extract text ({})",
                page_num,
                path.display()
            );
            continue;
        }

        let trimmed = page_text.trim();
        if trimmed.is_empty() {
            pages_ok += 1;
            continue;
        }

        total_bytes = total_bytes.saturating_add(trimmed.len());
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
            pages_ok += 1;
            continue;
        }

        pages_ok += 1;
        containers.push(ParsedContainer {
            title: format!("Page {page_num}"),
            container_type: ContainerType::Page { number: page_num as usize },
            ordinal: page_idx,
            blocks,
        });
    }

    if pages_failed > 0 {
        log::warn!(
            "PDF {}: {} page(s) failed extraction (ok={}, total={})",
            path.display(),
            pages_failed,
            pages_ok,
            page_count
        );
    }

    if containers.is_empty() {
        return Err(classify_empty_text(path));
    }

    Ok(ParsedDocument {
        title: document_title(path),
        containers,
        extraction: ExtractionStats {
            pages_ok,
            pages_failed,
            pages_total: page_count as u32,
        },
    })
}

fn extract_pages_via_pdfium_iter(path: &Path) -> Result<ParsedDocument, ParserError> {
    let pages = match load_pdfium_page_texts(path) {
        Ok(p) if !p.is_empty() => p,
        _ => {
            // Last resort: whole-doc lopdf
            let text = extract_with_lopdf(path)?;
            return text_to_document(document_title(path), text);
        }
    };

    let mut containers = Vec::new();
    let mut pages_ok = 0u32;
    let mut pages_failed = 0u32;
    let total = pages.len().min(MAX_PDF_PAGES) as u32;

    for (page_idx, page_text) in pages.into_iter().enumerate().take(MAX_PDF_PAGES) {
        let page_num = page_idx + 1;
        let trimmed = page_text.trim();
        if trimmed.is_empty() {
            // Try lopdf for this page.
            match extract_lopdf_page(path, page_num as u32) {
                Ok(t) if !t.trim().is_empty() => {
                    let blocks = paragraphs_to_blocks(t.trim());
                    if blocks.is_empty() {
                        pages_ok += 1;
                        continue;
                    }
                    pages_ok += 1;
                    containers.push(ParsedContainer {
                        title: format!("Page {page_num}"),
                        container_type: ContainerType::Page { number: page_num },
                        ordinal: page_idx,
                        blocks,
                    });
                }
                _ => {
                    pages_failed += 1;
                    log::warn!(
                        "PDF page {} failed to extract text ({})",
                        page_num,
                        path.display()
                    );
                }
            }
            continue;
        }
        let blocks = paragraphs_to_blocks(trimmed);
        if blocks.is_empty() {
            pages_ok += 1;
            continue;
        }
        pages_ok += 1;
        containers.push(ParsedContainer {
            title: format!("Page {page_num}"),
            container_type: ContainerType::Page { number: page_num },
            ordinal: page_idx,
            blocks,
        });
    }

    if pages_failed > 0 {
        log::warn!(
            "PDF {}: {} page(s) failed extraction (ok={}, total={})",
            path.display(),
            pages_failed,
            pages_ok,
            total
        );
    }

    if containers.is_empty() {
        return Err(classify_empty_text(path));
    }

    Ok(ParsedDocument {
        title: document_title(path),
        containers,
        extraction: ExtractionStats {
            pages_ok,
            pages_failed,
            pages_total: total,
        },
    })
}

fn paragraphs_to_blocks(trimmed: &str) -> Vec<ParsedContentBlock> {
    trimmed
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| ParsedContentBlock {
            content: p.to_string(),
            block_type: BlockType::Paragraph,
        })
        .collect()
}

fn pdf_page_count(path: &Path) -> Option<usize> {
    let load = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        lopdf::Document::load(path).ok().map(|d| d.get_pages().len())
    }));
    load.ok().flatten()
}

fn page_looks_blank(path: &Path, page_num: u32) -> bool {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let doc = lopdf::Document::load(path).ok()?;
        let pages = doc.get_pages();
        let &page_id = pages.get(&page_num)?;
        let content = doc.get_page_content(page_id).ok()?;
        Some(!content_has_text_operator(&content))
    }));
    result.ok().flatten().unwrap_or(true)
}

fn extract_lopdf_page(path: &Path, page_num: u32) -> Result<String, ParserError> {
    let doc = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        lopdf::Document::load(path)
    })) {
        Ok(Ok(doc)) => doc,
        Ok(Err(e)) => {
            return Err(ParserError::ParseFailure(format!("lopdf load: {e}")));
        }
        Err(_) => {
            return Err(ParserError::ParseFailure(
                "lopdf panicked while loading PDF".into(),
            ));
        }
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        doc.extract_text(&[page_num])
    })) {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(e)) => Err(ParserError::ParseFailure(format!(
            "lopdf page {page_num}: {e}"
        ))),
        Err(_) => Err(ParserError::ParseFailure(format!(
            "lopdf panicked on page {page_num}"
        ))),
    }
}

fn load_pdfium_page_texts(path: &Path) -> Result<Vec<String>, ParserError> {
    use pdfium_render::prelude::*;

    let bindings = resolve_pdfium_bindings().map_err(|e| {
        ParserError::ParseFailure(format!("pdfium unavailable: {e}"))
    })?;
    let pdfium = Pdfium::new(bindings);

    let doc = pdfium.load_pdf_from_file(path, None).map_err(|e| {
        let msg = e.to_string();
        let lower = msg.to_ascii_lowercase();
        if lower.contains("password") || lower.contains("encrypt") {
            ParserError::EncryptedPdf(format!("{}: {msg}", path.display()))
        } else {
            ParserError::ParseFailure(format!("{}: pdfium load: {msg}", path.display()))
        }
    })?;

    let mut pages = Vec::new();
    let mut total = 0usize;
    for (idx, page) in doc.pages().iter().enumerate() {
        if idx >= MAX_PDF_PAGES || total >= MAX_PDF_TEXT_BYTES {
            break;
        }
        match page.text() {
            Ok(text) => {
                let t = text.all();
                total = total.saturating_add(t.len());
                pages.push(t);
            }
            Err(e) => {
                log::debug!("pdfium page {} text failed: {e}", idx + 1);
                pages.push(String::new());
            }
        }
    }
    Ok(pages)
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
                Ok(())
            }
        }
        Err(_) => Err(ParserError::RetriablePdfError(format!(
            "{}: lopdf panicked during precheck",
            path.display()
        ))),
    }
}

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
        ParserError::ScannedImage(format!(
            "{}: text operators present but no extractable glyphs",
            path.display()
        ))
    }
}

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
    let mut pages_failed = 0usize;
    let mut page_nums: Vec<u32> = doc.get_pages().keys().copied().collect();
    page_nums.sort_unstable();
    for page_num in page_nums {
        if pages_done + pages_failed >= MAX_PDF_PAGES || out.len() >= MAX_PDF_TEXT_BYTES {
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
                pages_failed += 1;
                log::warn!(
                    "PDF page {} failed to extract text ({})",
                    page_num,
                    path.display()
                );
            }
        }
    }

    if pages_failed > 0 {
        log::warn!(
            "PDF {}: {} page(s) failed lopdf extraction",
            path.display(),
            pages_failed
        );
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
        let n = containers.len() as u32;
        return Ok(ParsedDocument {
            title,
            containers,
            extraction: ExtractionStats {
                pages_ok: n,
                pages_failed: 0,
                pages_total: n,
            },
        });
    };

    let mut containers = Vec::new();
    let mut pages_ok = 0u32;
    let mut pages_failed = 0u32;
    let listed = pages.len().min(MAX_PDF_PAGES) as u32;

    for (i, page) in pages.iter().enumerate().take(MAX_PDF_PAGES) {
        let trimmed = page.trim();
        if trimmed.is_empty() {
            // Blank form-feed page — count as ok empty page.
            pages_ok += 1;
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
            pages_failed += 1;
            continue;
        }
        pages_ok += 1;
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

    Ok(ParsedDocument {
        title,
        containers,
        extraction: ExtractionStats {
            pages_ok,
            pages_failed,
            pages_total: listed,
        },
    })
}
