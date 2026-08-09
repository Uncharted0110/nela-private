//! Multi-stage ingestion pipeline — Two-Pass architecture.
//!
//! Pass 1 (fast scan): Rayon parallel parse with a strict 500ms timeout,
//! Tantivy index + petgraph assemble, single commit, return immediately.
//! Files that time out / hit retriable errors go into `deferred_files`.
//!
//! Pass 2 (background): see `state.rs` — low-concurrency retry with 5s timeout.

use crate::doc_graph::engine::assembler::assemble_markdown;
use crate::doc_graph::errors::{EngineError, ParserError};
use crate::doc_graph::graph::builder::{
    assemble_graph_only, index_prepared_chunks, prepare_chunks, remove_document_by_path,
};
use crate::doc_graph::graph::schema::KnowledgeBase;
use crate::doc_graph::graph::traversal::expand_context;
use crate::doc_graph::manifest::{plan_sync, FileFingerprint, IndexManifest};
use crate::doc_graph::parsers::{ParsedDocument, ParserRegistry};
use crate::doc_graph::search::embeddings::Embedder;
use crate::doc_graph::search::hybrid::hybrid_search;
use crate::doc_graph::search::indexer::TantivyIndex;
use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Max file size accepted during discovery (2 MB).
pub const MAX_FILE_BYTES: u64 = 2_000_000;
/// Truncate individual content blocks before graph storage.
pub const MAX_BLOCK_CHARS: usize = 1_500;
/// Max content blocks retained per document.
pub const MAX_BLOCKS_PER_DOC: usize = 40;
/// Pass 1 per-file parse timeout (fast scan).
pub const PARSE_TIMEOUT_PASS1: Duration = Duration::from_millis(500);
/// Pass 2 per-file parse timeout (background retry).
pub const PARSE_TIMEOUT_PASS2: Duration = Duration::from_millis(5_000);
/// Cap errors retained in the report.
const MAX_ERRORS: usize = 50;

const SUPPORTED_EXTS: &[&str] = &[
    "pdf", "docx", "pptx", "xlsx", "xls", "ods", "html", "htm", "txt", "md", "markdown",
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

fn truncate_block(s: &str) -> String {
    if s.chars().count() <= MAX_BLOCK_CHARS {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(MAX_BLOCK_CHARS).collect::<String>())
    }
}

fn cap_document(mut doc: ParsedDocument) -> ParsedDocument {
    let mut kept = 0usize;
    for c in &mut doc.containers {
        for b in &mut c.blocks {
            b.content = truncate_block(&b.content);
        }
    }
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
            let skip = [
                "node_modules",
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
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                return !skip.iter().any(|s| name.eq_ignore_ascii_case(s));
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
        if meta.len() > MAX_FILE_BYTES {
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

/// Parse with a wall-clock timeout. On timeout returns `ParserError::Timeout`.
pub fn parse_with_timeout(
    registry: Arc<ParserRegistry>,
    path: PathBuf,
    timeout: Duration,
) -> Result<(PathBuf, ParsedDocument), (PathBuf, ParserError)> {
    parse_with_timeout_inner(registry, path, timeout, false)
}

/// Pass 2 timed parse — PDFs go through the robust fallback path.
pub fn parse_pass2_with_timeout(
    registry: Arc<ParserRegistry>,
    path: PathBuf,
    timeout: Duration,
) -> Result<(PathBuf, ParsedDocument), (PathBuf, ParserError)> {
    parse_with_timeout_inner(registry, path, timeout, true)
}

fn parse_with_timeout_inner(
    registry: Arc<ParserRegistry>,
    path: PathBuf,
    timeout: Duration,
    pass2: bool,
) -> Result<(PathBuf, ParsedDocument), (PathBuf, ParserError)> {
    let (tx, rx) = mpsc::sync_channel(1);
    let path_for_thread = path.clone();
    let thread_name = if pass2 {
        "doc-graph-pass2-parse"
    } else {
        "doc-graph-parse"
    };
    let spawn = std::thread::Builder::new()
        .name(thread_name.into())
        .spawn(move || {
            let result = if pass2 {
                parse_one_pass2(&registry, &path_for_thread)
            } else {
                parse_one(&registry, &path_for_thread)
            };
            let _ = tx.send(result);
        });

    if let Err(e) = spawn {
        return Err((
            path,
            ParserError::ParseFailure(format!("failed to spawn parse thread: {e}")),
        ));
    }

    match rx.recv_timeout(timeout) {
        Ok(Ok(doc)) => Ok((path, doc)),
        Ok(Err(e)) => Err((path, e)),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err((path, ParserError::Timeout(timeout.as_millis() as u64)))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err((
            path,
            ParserError::ParseFailure("parse worker disconnected".into()),
        )),
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
    kb: &mut KnowledgeBase,
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
        *kb = KnowledgeBase::new();
        kb.vectors.clear();
        kb.vector_chunk_ids.clear();
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
        files: HashMap::new(),
    };
    for path in &files {
        if report
            .deferred_files
            .iter()
            .any(|d| d.as_str() == path.to_string_lossy())
        {
            continue;
        }
        if let Some(fp) = FileFingerprint::from_path(path) {
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
    kb: &mut KnowledgeBase,
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
            files: HashMap::new(),
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

    // Purge deleted files from graph + Tantivy.
    for path in &plan.to_remove {
        let chunk_ids = remove_document_by_path(kb, path);
        let path_str = path.to_string_lossy().to_string();
        index.delete_by_file_path(&path_str)?;
        if !chunk_ids.is_empty() {
            index.delete_chunk_ids(&chunk_ids)?;
        }
        manifest.remove(path);
    }

    if plan.to_index.is_empty() && plan.to_remove.is_empty() {
        index.commit()?;
        kb.save_graph(&data_dir.join("graph.bin"))?;
        kb.save_vectors(&data_dir.join("vectors.bin"))?;
        manifest.save(data_dir)?;
        let stats = kb.stats();
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
        });
    }

    // Remove old graph/index entries before re-indexing changed paths.
    for path in &plan.to_index {
        let chunk_ids = remove_document_by_path(kb, path);
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
        if let Some(fp) = FileFingerprint::from_path(path) {
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

/// Shared Pass 1 parse → Tantivy → assemble → commit for an explicit file list.
fn index_paths_batch(
    root: &Path,
    data_dir: &Path,
    kb: &mut KnowledgeBase,
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

    emit(IndexingProgress {
        phase: "parsing".into(),
        files_discovered,
        message: format!(
            "Pass 1 fast scan: {files_discovered} files (≤{}ms timeout)",
            PARSE_TIMEOUT_PASS1.as_millis()
        ),
        ..Default::default()
    });

    let registry = Arc::new(ParserRegistry::new());
    let t_parse = Instant::now();

    let map_results: Vec<MapOutcome> = files
        .par_iter()
        .map(|path| match parse_with_timeout(
            registry.clone(),
            path.clone(),
            PARSE_TIMEOUT_PASS1,
        ) {
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
        })
        .collect();
    let parse_ms = t_parse.elapsed().as_millis();

    let mut mapped: Vec<MappedDoc> = Vec::new();
    let mut deferred_files: Vec<PathBuf> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut files_failed = 0usize;
    let mut chunks_indexed = 0usize;

    for outcome in map_results {
        match outcome {
            MapOutcome::Ok(doc) => {
                chunks_indexed += doc.chunks_indexed;
                mapped.push(doc);
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
    let files_parsed = mapped.len();
    let files_deferred = deferred_files.len();

    emit(IndexingProgress {
        phase: "assemble".into(),
        files_discovered,
        files_parsed,
        files_failed,
        chunks_indexed,
        message: format!(
            "Building graph ({files_parsed} ok, {files_deferred} deferred to Pass 2)"
        ),
    });

    let t_asm = Instant::now();
    for doc in &mapped {
        if let Err(e) = assemble_graph_only(kb, &doc.path, &doc.parsed) {
            push_error(&mut errors, format!("assemble {}: {e}", doc.path.display()));
        }
    }
    drop(mapped);
    let assemble_ms = t_asm.elapsed().as_millis();
    let embed_ms = 0u128;

    emit(IndexingProgress {
        phase: "flush".into(),
        files_discovered,
        files_parsed,
        files_failed,
        chunks_indexed,
        message: "Committing Pass 1 Tantivy index (search available now)".into(),
    });

    let t_flush = Instant::now();
    index.commit()?;
    kb.save_graph(&data_dir.join("graph.bin"))?;
    kb.save_vectors(&data_dir.join("vectors.bin"))?;
    let flush_ms = t_flush.elapsed().as_millis();
    let total_ms = t0.elapsed().as_millis() + discovery_ms;

    let stats = kb.stats();
    emit(IndexingProgress {
        phase: "done".into(),
        files_discovered,
        files_parsed,
        files_failed,
        chunks_indexed,
        message: format!(
            "Pass 1 done: {files_parsed} files in {total_ms}ms; {files_deferred} queued for Pass 2"
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
    })
}

/// Index a single deferred file (Pass 2). Caller holds whatever locks it needs.
pub fn index_one_deferred(
    path: &Path,
    kb: &mut KnowledgeBase,
    index: &TantivyIndex,
    registry: &Arc<ParserRegistry>,
) -> Result<usize, ParserError> {
    let (path, parsed) =
        parse_pass2_with_timeout(registry.clone(), path.to_path_buf(), PARSE_TIMEOUT_PASS2)
            .map_err(|(_p, e)| e)?;
    let prepared = prepare_chunks(&path, &parsed);
    let n = prepared.len();
    index_prepared_chunks(index, &prepared).map_err(|e| ParserError::ParseFailure(e.to_string()))?;
    assemble_graph_only(kb, &path, &parsed)
        .map_err(|e| ParserError::ParseFailure(e.to_string()))?;
    Ok(n)
}

pub fn query_kb(
    query: &str,
    kb: &KnowledgeBase,
    index: &TantivyIndex,
    embedder: &Embedder,
) -> Result<String, EngineError> {
    let hits = hybrid_search(query, kb, index, embedder, 100, 100)?;
    let top = hits.into_iter().take(5);
    let mut sources = Vec::new();
    for hit in top {
        if let Some(expanded) = expand_context(kb, &hit.chunk_id) {
            sources.push(expanded);
        }
    }
    Ok(assemble_markdown(&sources))
}

pub const EXCLUDED_DIR_NAMES: &[&str] = &[
    "node_modules",
    "AppData",
    "Library",
    "target",
    "build",
    "vendor",
    "venv",
    ".cargo",
];
