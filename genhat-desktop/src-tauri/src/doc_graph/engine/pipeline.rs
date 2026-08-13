//! Multi-stage ingestion pipeline — Two-Pass architecture.
//!
//! Pass 1 (fast scan): bounded private Rayon pool (see [`IndexerBudget`]),
//! parse **on the worker** (no detached timeout threads), chunk + yield so the
//! UI stays scheduled. Large PDFs are deferred to Pass 2 via a cheap size
//! pre-filter. Tantivy index + petgraph assemble, then commit.
//!
//! Pass 2 (background): see `state.rs` — low-concurrency retry on the same
//! budget (`min(2, pass1_threads)`).

use crate::doc_graph::budget::{self, IndexerBudget};
use crate::doc_graph::engine::assembler::assemble_markdown;
use crate::doc_graph::errors::{EngineError, ParserError};
use crate::doc_graph::graph::builder::{
    assemble_graph_only, index_prepared_chunks, prepare_chunks, remove_document_by_path,
};
use crate::doc_graph::graph::schema::KnowledgeBase;
use crate::doc_graph::manifest::{plan_sync, FileFingerprint, IndexManifest};
use crate::doc_graph::parsers::{ParsedDocument, ParserRegistry};
use crate::doc_graph::search::embeddings::Embedder;
use crate::doc_graph::search::hybrid::hybrid_search;
use crate::doc_graph::search::indexer::TantivyIndex;
use ignore::WalkBuilder;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// Legacy flat cap (kept for callers); discovery uses [`max_file_bytes_for_ext`].
pub const MAX_FILE_BYTES: u64 = 3_000_000;
/// Soft cap for a single ContentBlock; oversize text is split, never truncated.
pub const MAX_BLOCK_CHARS: usize = 1_500;
/// Max content blocks retained per document (raised so split chunks are not dropped).
pub const MAX_BLOCKS_PER_DOC: usize = 2_000;

/// Extension-aware discovery size limits (bytes).
pub fn max_file_bytes_for_ext(ext: &str) -> u64 {
    match ext.to_ascii_lowercase().as_str() {
        "pdf" => 35 * 1024 * 1024,
        "docx" | "pptx" | "xlsx" | "xls" | "ods" => 20 * 1024 * 1024,
        "md" | "markdown" | "txt" | "html" | "htm" | "json" => 3 * 1024 * 1024,
        _ => 3 * 1024 * 1024,
    }
}
/// Legacy Pass 1 timeout constant (no longer used to abandon threads).
pub const PARSE_TIMEOUT_PASS1: Duration = Duration::from_millis(500);
/// Legacy Pass 2 timeout constant (no longer used to abandon threads).
pub const PARSE_TIMEOUT_PASS2: Duration = Duration::from_millis(5_000);
/// Files processed per Pass 1 chunk before yielding to the OS/UI.
const PASS1_CHUNK: usize = 48;
/// Sleep between Pass 1 chunks so the compositor / event loop can run.
const PASS1_YIELD: Duration = Duration::from_millis(30);
/// Cheap Pass 1 pre-filter: PDFs over this size go to Pass 2 (no spawn/timeout).
const PASS1_DEFER_PDF_BYTES: u64 = 8 * 1024 * 1024;
/// Cap errors retained in the report.
const MAX_ERRORS: usize = 50;

const SUPPORTED_EXTS: &[&str] = &[
    "pdf", "docx", "pptx", "xlsx", "xls", "ods", "html", "htm", "txt", "md", "markdown",
    "json",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexingProgress {
    pub phase: String,
    pub files_discovered: usize,
    pub files_parsed: usize,
    pub files_failed: usize,
    pub chunks_indexed: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTiming {
    pub discovery_ms: u128,
    pub parse_ms: u128,
    pub assemble_ms: u128,
    pub embed_ms: u128,
    pub flush_ms: u128,
    pub total_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PipelineReport {
    pub root: String,
    pub files_discovered: usize,
    pub files_parsed: usize,
    pub files_failed: usize,
    pub files_deferred: usize,
    pub chunks_indexed: usize,
    pub nodes: usize,
    pub edges: usize,
    pub vectors: usize,
    pub timing: PipelineTiming,
    pub errors: Vec<String>,
    /// Absolute paths queued for Pass 2 background retry.
    pub deferred_files: Vec<String>,
    /// Successful Pass-1 fingerprints (with extraction quality) for manifest upsert.
    #[serde(skip)]
    pub fingerprints: HashMap<String, FileFingerprint>,
}

/// Status of the Pass 2 background retry worker.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundIndexStatus {
    pub active: bool,
    pub remaining: usize,
    pub completed: usize,
    pub failed: usize,
    pub total: usize,
}

pub type ProgressCallback = Arc<dyn Fn(IndexingProgress) + Send + Sync>;

/// Recursively split text exceeding `max_chars` on paragraph (`\n\n`) then
/// sentence (`. `) boundaries. Never drops content or appends ellipsis.
pub fn split_large_block(text: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(1);
    if text.chars().count() <= max_chars {
        return if text.is_empty() {
            Vec::new()
        } else {
            vec![text.to_string()]
        };
    }

    // Prefer paragraph boundaries.
    if text.contains("\n\n") {
        let mut out = Vec::new();
        for part in text.split("\n\n") {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            out.extend(split_large_block(trimmed, max_chars));
        }
        if !out.is_empty() {
            return out;
        }
    }

    // Fall back to sentence boundaries.
    if text.contains(". ") {
        let mut out = Vec::new();
        let mut buf = String::new();
        for sentence in text.split_inclusive(". ") {
            let candidate = if buf.is_empty() {
                sentence.to_string()
            } else {
                format!("{buf}{sentence}")
            };
            if !buf.is_empty() && candidate.chars().count() > max_chars {
                out.extend(split_large_block(&buf, max_chars));
                buf = sentence.to_string();
            } else {
                buf = candidate;
            }
        }
        if !buf.is_empty() {
            if buf.chars().count() > max_chars {
                out.extend(hard_split_chars(&buf, max_chars));
            } else {
                out.push(buf);
            }
        }
        if !out.is_empty() {
            return out;
        }
    }

    hard_split_chars(text, max_chars)
}

fn hard_split_chars(text: &str, max_chars: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut count = 0usize;
    for ch in text.chars() {
        if count >= max_chars && !buf.is_empty() {
            out.push(std::mem::take(&mut buf));
            count = 0;
        }
        buf.push(ch);
        count += 1;
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

fn cap_document(mut doc: ParsedDocument) -> ParsedDocument {
    // Expand oversize blocks into sequential siblings (same parent container).
    for c in &mut doc.containers {
        let mut expanded = Vec::new();
        for b in std::mem::take(&mut c.blocks) {
            let pieces = split_large_block(&b.content, MAX_BLOCK_CHARS);
            if pieces.is_empty() {
                continue;
            }
            for piece in pieces {
                expanded.push(crate::doc_graph::parsers::traits::ParsedContentBlock {
                    content: piece,
                    block_type: b.block_type.clone(),
                });
            }
        }
        c.blocks = expanded;
    }

    let mut kept = 0usize;
    for c in &mut doc.containers {
        if kept >= MAX_BLOCKS_PER_DOC {
            c.blocks.clear();
            continue;
        }
        let remain = MAX_BLOCKS_PER_DOC - kept;
        if c.blocks.len() > remain {
            c.blocks.truncate(remain);
        }
        kept += c.blocks.len();
    }
    doc.containers.retain(|c| !c.blocks.is_empty());
    doc
}

fn is_supported_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|e| SUPPORTED_EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// Discover files with `ignore::WalkBuilder`.
pub fn discover_files(root: &Path, max_files: Option<usize>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .follow_links(false)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                return !EXCLUDED_DIR_NAMES
                    .iter()
                    .any(|s| name.eq_ignore_ascii_case(s));
            }
            true
        })
        .build();

    for dent in walker.flatten() {
        let ft = match dent.file_type() {
            Some(t) => t,
            None => continue,
        };
        if !ft.is_file() {
            continue;
        }
        let path = dent.path();
        if !is_supported_ext(path) {
            continue;
        }
        let Ok(meta) = dent.metadata() else {
            continue;
        };
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if meta.len() > max_file_bytes_for_ext(ext) {
            continue;
        }
        files.push(path.to_path_buf());
        if let Some(max) = max_files {
            if files.len() >= max {
                break;
            }
        }
    }
    files
}

fn push_error(errors: &mut Vec<String>, msg: String) {
    if errors.len() < MAX_ERRORS {
        errors.push(msg);
    }
}

fn parse_one(registry: &ParserRegistry, path: &Path) -> Result<ParsedDocument, ParserError> {
    let Some(parser) = registry.get_parser(path) else {
        return Err(ParserError::Unsupported(format!(
            "{}: unsupported extension",
            path.display()
        )));
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| parser.parse(path))) {
        Ok(Ok(doc)) => Ok(cap_document(doc)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(ParserError::ParseFailure(format!(
            "{}: parser panicked",
            path.display()
        ))),
    }
}

/// Pass 2 parse: PDFs use pdfium/lopdf fallback (never pdf-extract); other formats
/// reuse the normal parser. Always wrapped in `catch_unwind` so one bad file
/// cannot abort the background batch.
fn parse_one_pass2(registry: &ParserRegistry, path: &Path) -> Result<ParsedDocument, ParserError> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "pdf" {
            crate::doc_graph::parsers::pdf::parse_pass2_fallback(path)
        } else {
            let Some(parser) = registry.get_parser(path) else {
                return Err(ParserError::Unsupported(format!(
                    "{}: unsupported extension",
                    path.display()
                )));
            };
            parser.parse(path)
        }
    }));

    match result {
        Ok(Ok(doc)) => Ok(cap_document(doc)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(ParserError::ParseFailure(format!(
            "{}: Pass 2 parser panicked",
            path.display()
        ))),
    }
}

/// Parse on the **calling** thread (Rayon worker). No extra OS thread, no
/// abandon-on-timeout leak. `timeout` is ignored — kept for call-site compat.
pub fn parse_with_timeout(
    registry: Arc<ParserRegistry>,
    path: PathBuf,
    _timeout: Duration,
) -> Result<(PathBuf, ParsedDocument), (PathBuf, ParserError)> {
    parse_on_caller(&registry, path, false)
}

/// Pass 2 parse on the calling thread — PDFs go through the robust fallback path.
pub fn parse_pass2_with_timeout(
    registry: Arc<ParserRegistry>,
    path: PathBuf,
    _timeout: Duration,
) -> Result<(PathBuf, ParsedDocument), (PathBuf, ParserError)> {
    parse_on_caller(&registry, path, true)
}

fn parse_on_caller(
    registry: &ParserRegistry,
    path: PathBuf,
    pass2: bool,
) -> Result<(PathBuf, ParsedDocument), (PathBuf, ParserError)> {
    #[cfg(test)]
    {
        let n = PARSE_INFLIGHT.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        PARSE_PEAK.fetch_max(n, std::sync::atomic::Ordering::SeqCst);
    }
    let result = if pass2 {
        parse_one_pass2(registry, &path)
    } else {
        parse_one(registry, &path)
    };
    #[cfg(test)]
    PARSE_INFLIGHT.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    match result {
        Ok(doc) => Ok((path, doc)),
        Err(e) => Err((path, e)),
    }
}

#[cfg(test)]
static PARSE_INFLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
static PARSE_PEAK: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn should_defer_pass1(path: &Path) -> Option<String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "pdf" {
        return None;
    }
    let Ok(meta) = path.metadata() else {
        return None;
    };
    if meta.len() > PASS1_DEFER_PDF_BYTES {
        Some(format!(
            "{}: {} bytes exceeds Pass 1 PDF cap ({}); deferred",
            path.display(),
            meta.len(),
            PASS1_DEFER_PDF_BYTES
        ))
    } else {
        None
    }
}

struct MappedDoc {
    path: PathBuf,
    parsed: ParsedDocument,
    chunks_indexed: usize,
}

enum MapOutcome {
    Ok(MappedDoc),
    Deferred(PathBuf, String),
    Failed(PathBuf, String),
}

/// Pass 1 fast scan. Returns report + deferred paths for Pass 2.
pub fn run_pipeline(
    root: &Path,
    data_dir: &Path,
    kb: &RwLock<KnowledgeBase>,
    index: &TantivyIndex,
    embedder: &Embedder,
    max_files: Option<usize>,
    replace: bool,
    on_progress: Option<ProgressCallback>,
) -> Result<PipelineReport, EngineError> {
    let emit = |p: IndexingProgress| {
        if let Some(cb) = &on_progress {
            cb(p);
        }
    };

    if replace {
        {
            let mut kb = kb.write();
            *kb = KnowledgeBase::new();
            kb.vectors.clear();
            kb.vector_chunk_ids.clear();
        }
        index.clear()?;
        let mut empty = IndexManifest::default();
        empty.root = root.to_string_lossy().to_string();
        empty.save(data_dir)?;
    }

    emit(IndexingProgress {
        phase: "discovery".into(),
        message: format!("Scanning {}", root.display()),
        ..Default::default()
    });

    let t_disc = Instant::now();
    let files = discover_files(root, max_files);
    let discovery_ms = t_disc.elapsed().as_millis();

    let report = index_paths_batch(
        root,
        data_dir,
        kb,
        index,
        embedder,
        &files,
        discovery_ms,
        on_progress,
    )?;

    // Rewrite manifest for every non-deferred discovered file.
    let mut manifest = IndexManifest {
        root: root.to_string_lossy().to_string(),
        ..Default::default()
    };
    for path in &files {
        if report
            .deferred_files
            .iter()
            .any(|d| d.as_str() == path.to_string_lossy())
        {
            continue;
        }
        let key = IndexManifest::key(path);
        if let Some(fp) = report.fingerprints.get(&key).cloned() {
            manifest.upsert(path, fp);
        } else if let Some(fp) = FileFingerprint::from_path(path) {
            manifest.upsert(path, fp);
        }
    }
    manifest.save(data_dir)?;

    Ok(report)
}

/// Incremental sync: discover under `root`, remove deleted, re-index new/changed only.
pub fn run_incremental_sync(
    root: &Path,
    data_dir: &Path,
    kb: &RwLock<KnowledgeBase>,
    index: &TantivyIndex,
    embedder: &Embedder,
    max_files: Option<usize>,
    on_progress: Option<ProgressCallback>,
) -> Result<PipelineReport, EngineError> {
    let t0 = Instant::now();
    let emit = |p: IndexingProgress| {
        if let Some(cb) = &on_progress {
            cb(p);
        }
    };

    emit(IndexingProgress {
        phase: "discovery".into(),
        message: format!("Scanning {} (incremental)", root.display()),
        ..Default::default()
    });

    let t_disc = Instant::now();
    let discovered = discover_files(root, max_files);
    let discovery_ms = t_disc.elapsed().as_millis();
    let files_discovered = discovered.len();

    let mut manifest = IndexManifest::load(data_dir)?;
    // If root changed, treat as fresh scope (keep other fingerprints only under new root).
    if !manifest.root.is_empty() && manifest.root != root.to_string_lossy() {
        log::info!(
            "Index root changed ({} → {}); rebuilding fingerprints for new root",
            manifest.root,
            root.display()
        );
        manifest = IndexManifest {
            root: root.to_string_lossy().to_string(),
            ..Default::default()
        };
    }
    if manifest.root.is_empty() {
        manifest.root = root.to_string_lossy().to_string();
    }

    let plan = plan_sync(&discovered, &manifest);

    emit(IndexingProgress {
        phase: "diff".into(),
        files_discovered,
        message: format!(
            "Diff: {} changed/new, {} removed, {} unchanged",
            plan.to_index.len(),
            plan.to_remove.len(),
            plan.unchanged
        ),
        ..Default::default()
    });

    // Purge deleted files from graph + Tantivy (short write lock).
    for path in &plan.to_remove {
        let chunk_ids = {
            let mut kb = kb.write();
            remove_document_by_path(&mut kb, path)
        };
        let path_str = path.to_string_lossy().to_string();
        index.delete_by_file_path(&path_str)?;
        if !chunk_ids.is_empty() {
            index.delete_chunk_ids(&chunk_ids)?;
        }
        manifest.remove(path);
    }

    if plan.to_index.is_empty() && plan.to_remove.is_empty() {
        index.commit()?;
        {
            let kb = kb.read();
            kb.save_graph(&data_dir.join("graph.bin"))?;
            kb.save_vectors(&data_dir.join("vectors.bin"))?;
        }
        manifest.save(data_dir)?;
        let stats = kb.read().stats();
        let total_ms = t0.elapsed().as_millis();
        emit(IndexingProgress {
            phase: "done".into(),
            files_discovered,
                            message: format!(
                                "Incremental sync: nothing to do ({} up to date) in {total_ms}ms",
                                plan.unchanged
                            ),
            ..Default::default()
        });
        return Ok(PipelineReport {
            root: root.to_string_lossy().to_string(),
            files_discovered,
            files_parsed: 0,
            files_failed: 0,
            files_deferred: 0,
            chunks_indexed: 0,
            nodes: stats.nodes,
            edges: stats.edges,
            vectors: stats.vectors,
            timing: PipelineTiming {
                discovery_ms,
                parse_ms: 0,
                assemble_ms: 0,
                embed_ms: 0,
                flush_ms: 0,
                total_ms,
            },
            errors: Vec::new(),
            deferred_files: Vec::new(),
            fingerprints: HashMap::new(),
        });
    }

    // Remove old graph/index entries before re-indexing changed paths.
    for path in &plan.to_index {
        let chunk_ids = {
            let mut kb = kb.write();
            remove_document_by_path(&mut kb, path)
        };
        let path_str = path.to_string_lossy().to_string();
        index.delete_by_file_path(&path_str)?;
        if !chunk_ids.is_empty() {
            index.delete_chunk_ids(&chunk_ids)?;
        }
        manifest.remove(path);
    }

    let mut report = index_paths_batch(
        root,
        data_dir,
        kb,
        index,
        embedder,
        &plan.to_index,
        discovery_ms,
        on_progress.clone(),
    )?;
    // Override discovered count to full scan size for UI clarity.
    report.files_discovered = files_discovered;

    for path in &plan.to_index {
        if report
            .deferred_files
            .iter()
            .any(|d| d.as_str() == path.to_string_lossy())
        {
            continue;
        }
        let key = IndexManifest::key(path);
        if let Some(fp) = report.fingerprints.get(&key).cloned() {
            manifest.upsert(path, fp);
        } else if let Some(fp) = FileFingerprint::from_path(path) {
            manifest.upsert(path, fp);
        }
    }
    manifest.root = root.to_string_lossy().to_string();
    manifest.save(data_dir)?;

    // Annotate done message with diff stats.
    emit(IndexingProgress {
        phase: "done".into(),
        files_discovered,
        files_parsed: report.files_parsed,
        files_failed: report.files_failed,
        chunks_indexed: report.chunks_indexed,
        message: format!(
            "Incremental Pass 1: {} updated, {} removed, {} unchanged; {} deferred",
            report.files_parsed,
            plan.to_remove.len(),
            plan.unchanged,
            report.files_deferred
        ),
    });

    Ok(report)
}

/// Live / targeted sync for a set of absolute paths (create/modify/delete).
///
/// - Missing paths (and directory prefixes) are purged from graph + Tantivy + manifest.
/// - Existing supported files are re-indexed when fingerprints differ (or are new).
pub fn sync_paths(
    paths: &[PathBuf],
    data_dir: &Path,
    kb: &RwLock<KnowledgeBase>,
    index: &TantivyIndex,
    embedder: &Embedder,
    on_progress: Option<ProgressCallback>,
) -> Result<PipelineReport, EngineError> {
    let t0 = Instant::now();
    let emit = |p: IndexingProgress| {
        if let Some(cb) = &on_progress {
            cb(p);
        }
    };

    if paths.is_empty() {
        return Ok(PipelineReport::default());
    }

    let mut manifest = IndexManifest::load(data_dir)?;
    let root = if !manifest.root.is_empty() {
        PathBuf::from(&manifest.root)
    } else {
        paths[0]
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| paths[0].clone())
    };

    let mut to_remove: Vec<PathBuf> = Vec::new();
    let mut to_index: Vec<PathBuf> = Vec::new();
    let mut seen_remove = std::collections::HashSet::new();
    let mut seen_index = std::collections::HashSet::new();

    let push_remove = |path: &Path,
                       to_remove: &mut Vec<PathBuf>,
                       seen: &mut std::collections::HashSet<String>| {
        let key = IndexManifest::key(path);
        if seen.insert(key) {
            to_remove.push(path.to_path_buf());
        }
    };

    for raw in paths {
        let path = raw.canonicalize().unwrap_or_else(|_| raw.clone());

        if path_is_under_excluded(&path) {
            continue;
        }

        // Directory gone (or remove event): purge every indexed descendant.
        if !path.exists() {
            let prefix = path.to_string_lossy().to_string();
            let prefix_slash = if prefix.ends_with(std::path::MAIN_SEPARATOR) {
                prefix.clone()
            } else {
                format!("{}{}", prefix, std::path::MAIN_SEPARATOR)
            };
            push_remove(&path, &mut to_remove, &mut seen_remove);
            for key in manifest.files.keys() {
                if key == &prefix || key.starts_with(&prefix_slash) {
                    push_remove(Path::new(key), &mut to_remove, &mut seen_remove);
                }
            }
            continue;
        }

        if path.is_dir() {
            // Directory still exists — only react to supported files under it when
            // they also appear in the event batch; no full re-walk here.
            continue;
        }

        if !is_supported_ext(&path) {
            continue;
        }

        match FileFingerprint::from_path(&path) {
            Some(fp)
                if manifest.matches(&path, &fp) && !manifest.needs_reparse(&path) => {}
            Some(_) | None => {
                let key = IndexManifest::key(&path);
                if seen_index.insert(key) {
                    to_index.push(path);
                }
            }
        }
    }

    emit(IndexingProgress {
        phase: "live-sync".into(),
        message: format!(
            "Live sync: {} to update, {} to remove",
            to_index.len(),
            to_remove.len()
        ),
        files_discovered: to_index.len() + to_remove.len(),
        ..Default::default()
    });

    for path in &to_remove {
        let chunk_ids = {
            let mut kb = kb.write();
            remove_document_by_path(&mut kb, path)
        };
        let path_str = path.to_string_lossy().to_string();
        index.delete_by_file_path(&path_str)?;
        if !chunk_ids.is_empty() {
            index.delete_chunk_ids(&chunk_ids)?;
        }
        manifest.remove(path);
    }

    for path in &to_index {
        let chunk_ids = {
            let mut kb = kb.write();
            remove_document_by_path(&mut kb, path)
        };
        let path_str = path.to_string_lossy().to_string();
        index.delete_by_file_path(&path_str)?;
        if !chunk_ids.is_empty() {
            index.delete_chunk_ids(&chunk_ids)?;
        }
        manifest.remove(path);
    }

    let report = if to_index.is_empty() {
        if !to_remove.is_empty() {
            index.commit()?;
            let kb = kb.read();
            kb.save_graph(&data_dir.join("graph.bin"))?;
            kb.save_vectors(&data_dir.join("vectors.bin"))?;
        }
        let stats = kb.read().stats();
        PipelineReport {
            root: root.to_string_lossy().to_string(),
            files_discovered: to_remove.len(),
            files_parsed: 0,
            files_failed: 0,
            files_deferred: 0,
            chunks_indexed: 0,
            nodes: stats.nodes,
            edges: stats.edges,
            vectors: stats.vectors,
            timing: PipelineTiming {
                total_ms: t0.elapsed().as_millis(),
                ..Default::default()
            },
            errors: Vec::new(),
            deferred_files: Vec::new(),
            fingerprints: HashMap::new(),
        }
    } else {
        let mut report = index_paths_batch(
            &root,
            data_dir,
            kb,
            index,
            embedder,
            &to_index,
            0,
            on_progress.clone(),
        )?;
        report.files_discovered = to_index.len() + to_remove.len();
        report
    };

    for path in &to_index {
        if report
            .deferred_files
            .iter()
            .any(|d| d.as_str() == path.to_string_lossy())
        {
            continue;
        }
        let key = IndexManifest::key(path);
        if let Some(fp) = report.fingerprints.get(&key).cloned() {
            manifest.upsert(path, fp);
        } else if let Some(fp) = FileFingerprint::from_path(path) {
            manifest.upsert(path, fp);
        }
    }
    if manifest.root.is_empty() {
        manifest.root = root.to_string_lossy().to_string();
    }
    manifest.save(data_dir)?;

    emit(IndexingProgress {
        phase: "done".into(),
        files_discovered: report.files_discovered,
        files_parsed: report.files_parsed,
        files_failed: report.files_failed,
        chunks_indexed: report.chunks_indexed,
        message: format!(
            "Live sync done: {} updated, {} removed in {}ms",
            report.files_parsed,
            to_remove.len(),
            t0.elapsed().as_millis()
        ),
    });

    Ok(report)
}

fn path_is_under_excluded(path: &Path) -> bool {
    path.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        EXCLUDED_DIR_NAMES
            .iter()
            .any(|ex| name.eq_ignore_ascii_case(ex))
    })
}

/// Shared Pass 1 parse → Tantivy → assemble → commit for an explicit file list.
///
/// Uses a **private** Rayon pool sized by [`IndexerBudget`]. Parses on the
/// worker (no detached timeout threads). Holds `kb.write()` only per chunk.
fn index_paths_batch(
    root: &Path,
    data_dir: &Path,
    kb: &RwLock<KnowledgeBase>,
    index: &TantivyIndex,
    _embedder: &Embedder,
    files: &[PathBuf],
    discovery_ms: u128,
    on_progress: Option<ProgressCallback>,
) -> Result<PipelineReport, EngineError> {
    let t0 = Instant::now();
    let emit = |p: IndexingProgress| {
        if let Some(cb) = &on_progress {
            cb(p);
        }
    };
    let files_discovered = files.len();
    let budget = IndexerBudget::detect();
    let pool = budget::build_pass1_pool(&budget).map_err(|e| {
        EngineError::Other(format!("doc-graph Pass 1 pool failed: {e}"))
    })?;

    emit(IndexingProgress {
        phase: "parsing".into(),
        files_discovered,
        message: format!(
            "Pass 1 fast scan: {files_discovered} files ({})",
            budget.progress_label()
        ),
        ..Default::default()
    });

    let registry = Arc::new(ParserRegistry::new());
    let t_parse = Instant::now();
    let mut t_asm_acc = Duration::ZERO;

    let mut fingerprints: HashMap<String, FileFingerprint> = HashMap::new();
    let mut deferred_files: Vec<PathBuf> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut files_failed = 0usize;
    let mut files_parsed = 0usize;
    let mut chunks_indexed = 0usize;

    for (chunk_idx, chunk) in files.chunks(PASS1_CHUNK).enumerate() {
        let map_results: Vec<MapOutcome> = budget::in_place_map(&pool, chunk, |path| {
            if let Some(msg) = should_defer_pass1(path) {
                return MapOutcome::Deferred(path.clone(), msg);
            }
            match parse_on_caller(&registry, path.clone(), false) {
                Ok((path, parsed)) => {
                    let prepared = prepare_chunks(&path, &parsed);
                    let n = prepared.len();
                    match index_prepared_chunks(index, &prepared) {
                        Ok(()) => MapOutcome::Ok(MappedDoc {
                            path,
                            parsed,
                            chunks_indexed: n,
                        }),
                        Err(e) => MapOutcome::Failed(path, e.to_string()),
                    }
                }
                Err((path, err)) => {
                    let msg = format!("{}: {err}", path.display());
                    if err.is_retriable() {
                        MapOutcome::Deferred(path, msg)
                    } else {
                        MapOutcome::Failed(path, msg)
                    }
                }
            }
        });

        let t_asm = Instant::now();
        {
            let mut kb = kb.write();
            for outcome in map_results {
                match outcome {
                    MapOutcome::Ok(doc) => {
                        chunks_indexed += doc.chunks_indexed;
                        files_parsed += 1;
                        if let Some(fp) = FileFingerprint::from_path_with_extraction(
                            &doc.path,
                            &doc.parsed.extraction,
                        ) {
                            fingerprints.insert(IndexManifest::key(&doc.path), fp);
                        }
                        if let Err(e) = assemble_graph_only(&mut kb, &doc.path, &doc.parsed) {
                            push_error(
                                &mut errors,
                                format!("assemble {}: {e}", doc.path.display()),
                            );
                        }
                    }
                    MapOutcome::Deferred(path, msg) => {
                        deferred_files.push(path);
                        push_error(&mut errors, format!("{msg} [deferred→pass2]"));
                    }
                    MapOutcome::Failed(_path, msg) => {
                        files_failed += 1;
                        push_error(&mut errors, msg);
                    }
                }
            }
        }
        t_asm_acc += t_asm.elapsed();

        emit(IndexingProgress {
            phase: "parsing".into(),
            files_discovered,
            files_parsed,
            files_failed,
            chunks_indexed,
            message: format!(
                "Pass 1 chunk {}/{} ({}) — {} ok, {} deferred, {} failed",
                chunk_idx + 1,
                files.len().div_ceil(PASS1_CHUNK).max(1),
                budget.progress_label(),
                files_parsed,
                deferred_files.len(),
                files_failed
            ),
        });

        thread::sleep(PASS1_YIELD);
    }

    let parse_ms = t_parse.elapsed().saturating_sub(t_asm_acc).as_millis();
    let assemble_ms = t_asm_acc.as_millis();
    let embed_ms = 0u128;
    let files_deferred = deferred_files.len();

    emit(IndexingProgress {
        phase: "flush".into(),
        files_discovered,
        files_parsed,
        files_failed,
        chunks_indexed,
        message: format!(
            "Committing Pass 1 Tantivy index ({})",
            budget.progress_label()
        ),
    });

    let t_flush = Instant::now();
    index.commit()?;
    {
        let kb = kb.read();
        kb.save_graph(&data_dir.join("graph.bin"))?;
        kb.save_vectors(&data_dir.join("vectors.bin"))?;
    }
    let flush_ms = t_flush.elapsed().as_millis();
    let total_ms = t0.elapsed().as_millis() + discovery_ms;

    let stats = kb.read().stats();
    emit(IndexingProgress {
        phase: "done".into(),
        files_discovered,
        files_parsed,
        files_failed,
        chunks_indexed,
        message: format!(
            "Pass 1 done: {files_parsed} files in {total_ms}ms; {files_deferred} queued for Pass 2 ({})",
            budget.progress_label()
        ),
    });

    Ok(PipelineReport {
        root: root.to_string_lossy().to_string(),
        files_discovered,
        files_parsed,
        files_failed,
        files_deferred,
        chunks_indexed,
        nodes: stats.nodes,
        edges: stats.edges,
        vectors: stats.vectors,
        timing: PipelineTiming {
            discovery_ms,
            parse_ms,
            assemble_ms,
            embed_ms,
            flush_ms,
            total_ms,
        },
        errors,
        deferred_files: deferred_files
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
        fingerprints,
    })
}

/// Index a single deferred file (Pass 2). Caller holds whatever locks it needs.
/// Returns `(chunks_indexed, fingerprint)`.
pub fn index_one_deferred(
    path: &Path,
    kb: &mut KnowledgeBase,
    index: &TantivyIndex,
    registry: &Arc<ParserRegistry>,
) -> Result<(usize, FileFingerprint), ParserError> {
    let (path, parsed) = parse_on_caller(registry, path.to_path_buf(), true).map_err(|(_p, e)| e)?;
    let prepared = prepare_chunks(&path, &parsed);
    let n = prepared.len();
    index_prepared_chunks(index, &prepared).map_err(|e| ParserError::ParseFailure(e.to_string()))?;
    assemble_graph_only(kb, &path, &parsed)
        .map_err(|e| ParserError::ParseFailure(e.to_string()))?;
    let fp = FileFingerprint::from_path_with_extraction(&path, &parsed.extraction)
        .or_else(|| FileFingerprint::from_path(&path))
        .ok_or_else(|| {
            ParserError::ParseFailure(format!("{}: cannot fingerprint path", path.display()))
        })?;
    Ok((n, fp))
}

pub fn query_kb(
    query: &str,
    kb: &KnowledgeBase,
    index: &TantivyIndex,
    embedder: &Embedder,
    top_k: Option<usize>,
) -> Result<String, EngineError> {
    // Expand up to `top_k` RRF hits (default 25); hybrid already caps the pool at 50.
    let top_k = top_k.unwrap_or(25).clamp(1, 50);
    let hits = hybrid_search(query, kb, index, embedder, 50, 50)?;
    // Drop hits whose source file no longer exists (stale until live sync catches up).
    let hit_ids: Vec<String> = hits
        .into_iter()
        .filter(|h| chunk_source_exists(kb, &h.chunk_id))
        .take(top_k)
        .map(|h| h.chunk_id)
        .collect();
    Ok(assemble_markdown(kb, &hit_ids))
}

fn chunk_source_exists(kb: &KnowledgeBase, chunk_id: &str) -> bool {
    let Some(path) = crate::doc_graph::graph::traversal::file_path_for_chunk(kb, chunk_id) else {
        return true; // keep if we cannot resolve; better than dropping everything
    };
    Path::new(&path).is_file()
}

/// Directories skipped during discovery (coding projects, caches, VCS, etc.).
pub const EXCLUDED_DIR_NAMES: &[&str] = &[
    "node_modules",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".tox",
    ".eggs",
    "site-packages",
    "Pods",
    "DerivedData",
    ".gradle",
    ".idea",
    ".vscode",
    "dist",
    ".next",
    ".nuxt",
    "coverage",
    "AppData",
    "Library",
    "target",
    "build",
    "vendor",
    "venv",
    ".venv",
    ".cargo",
    ".rustup",
    ".cache",
    ".git",
    ".svn",
    ".hg",
    "knowledge_base",
    "knowledge_base_bench",
];

#[cfg(test)]
mod split_tests {
    use super::split_large_block;

    #[test]
    fn split_preserves_all_chars() {
        let long = "Hello world. ".repeat(200); // ~2600 chars
        let parts = split_large_block(&long, 1500);
        assert!(parts.len() >= 2);
        let joined: String = parts.concat();
        assert_eq!(joined, long);
        assert!(!joined.contains('…'));
    }

    #[test]
    fn split_on_paragraphs() {
        let a = "a".repeat(800);
        let b = "b".repeat(800);
        let text = format!("{a}\n\n{b}");
        let parts = split_large_block(&text, 1500);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], a);
        assert_eq!(parts[1], b);
    }
}

#[cfg(test)]
mod parse_ceiling_tests {
    use super::*;
    use crate::doc_graph::budget::{self, IndexerBudget};
    use std::sync::atomic::Ordering;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn parse_on_caller_never_spawns_orphan_threads() {
        let before = named_thread_count("doc-graph-parse");
        let registry = ParserRegistry::new();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("note.txt");
        std::fs::write(&path, "hello world from parse ceiling test").unwrap();
        let result = parse_on_caller(&registry, path, false);
        assert!(result.is_ok(), "parse failed: {:?}", result.err());
        thread::sleep(Duration::from_millis(50));
        let after = named_thread_count("doc-graph-parse");
        assert_eq!(
            after, before,
            "parse_on_caller must not leave doc-graph-parse threads"
        );
        assert_eq!(PARSE_INFLIGHT.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn bounded_pool_peak_does_not_exceed_budget() {
        PARSE_PEAK.store(0, Ordering::SeqCst);
        PARSE_INFLIGHT.store(0, Ordering::SeqCst);
        let budget = IndexerBudget::from_parts(8, 16, false, false, Some(2));
        assert_eq!(budget.pass1_threads, 2);
        let pool = budget::build_pass1_pool(&budget).expect("pool");
        let registry = Arc::new(ParserRegistry::new());
        let dir = tempfile::tempdir().expect("tempdir");
        let paths: Vec<PathBuf> = (0..8)
            .map(|i| {
                let p = dir.path().join(format!("f{i}.txt"));
                std::fs::write(&p, format!("file {i} body for parse ceiling")).unwrap();
                p
            })
            .collect();

        budget::in_place_map(&pool, &paths, |path| {
            let _ = parse_on_caller(&registry, path.clone(), false);
            thread::sleep(Duration::from_millis(40));
        });

        let peak = PARSE_PEAK.load(Ordering::SeqCst);
        assert!(
            peak <= budget.pass1_threads,
            "peak live parses {peak} exceeded budget {}",
            budget.pass1_threads
        );
        assert_eq!(PARSE_INFLIGHT.load(Ordering::SeqCst), 0);
        assert_eq!(named_thread_count("doc-graph-parse"), 0);
    }

    fn named_thread_count(prefix: &str) -> usize {
        let Ok(entries) = std::fs::read_dir("/proc/self/task") else {
            return 0;
        };
        entries
            .flatten()
            .filter(|e| {
                std::fs::read_to_string(e.path().join("comm"))
                    .map(|s| s.trim().starts_with(prefix))
                    .unwrap_or(false)
            })
            .count()
    }
}
