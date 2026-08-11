//! Managed runtime state for the structural knowledge-graph engine.
//!
//! `KnowledgeBase` (DocGraph) is held behind `Arc`-shared `RwLock` so Pass 2
//! background retries can mutate structure while queries hold read locks.

use crate::doc_graph::engine::pipeline::{
    BackgroundIndexStatus, IndexingProgress, PARSE_TIMEOUT_PASS2,
};
use crate::doc_graph::errors::EngineError;
use crate::doc_graph::graph::schema::{KnowledgeBase, KnowledgeBaseStats};
use crate::doc_graph::manifest::{FileFingerprint, IndexManifest};
use crate::doc_graph::parsers::ParserRegistry;
use crate::doc_graph::search::embeddings::Embedder;
use crate::doc_graph::search::indexer::TantivyIndex;
use parking_lot::{Mutex, RwLock};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use tauri::Emitter;

/// How often Pass 2 commits Tantivy + flushes graph.bin.
const PASS2_COMMIT_EVERY: usize = 8;
/// Max Rayon workers for Pass 2 (keep UI/CPU responsive).
const PASS2_THREADS: usize = 2;

pub struct DocGraphEngine {
    pub data_dir: PathBuf,
    /// Thread-safe structural knowledge graph (Arc shared via DocGraphState).
    pub kb: RwLock<KnowledgeBase>,
    pub index: Arc<TantivyIndex>,
    embedder: Mutex<Option<Arc<Embedder>>>,
    /// Pass 1 (foreground) busy flag.
    indexing: AtomicBool,
    /// Pass 2 background status.
    bg_active: AtomicBool,
    bg_cancel: AtomicBool,
    bg_remaining: AtomicUsize,
    bg_completed: AtomicUsize,
    bg_failed: AtomicUsize,
    bg_total: AtomicUsize,
    bg_handle: Mutex<Option<JoinHandle<()>>>,
    /// Live FS watcher for the current index root (home or manually indexed dir).
    live_watch: Mutex<Option<crate::doc_graph::watcher::LiveWatchHandle>>,
}

impl DocGraphEngine {
    pub fn open(data_dir: PathBuf) -> Result<Self, EngineError> {
        std::fs::create_dir_all(&data_dir)?;
        let index_dir = data_dir.join("tantivy_index");
        let index = Arc::new(TantivyIndex::open(&index_dir)?);

        let mut kb = KnowledgeBase::load_graph(&data_dir.join("graph.bin"))?;
        kb.load_vectors(&data_dir.join("vectors.bin"))?;

        Ok(Self {
            data_dir,
            kb: RwLock::new(kb),
            index,
            embedder: Mutex::new(None),
            indexing: AtomicBool::new(false),
            bg_active: AtomicBool::new(false),
            bg_cancel: AtomicBool::new(false),
            bg_remaining: AtomicUsize::new(0),
            bg_completed: AtomicUsize::new(0),
            bg_failed: AtomicUsize::new(0),
            bg_total: AtomicUsize::new(0),
            bg_handle: Mutex::new(None),
            live_watch: Mutex::new(None),
        })
    }

    pub fn embedder(&self) -> Result<Arc<Embedder>, EngineError> {
        let mut guard = self.embedder.lock();
        if let Some(e) = guard.as_ref() {
            return Ok(e.clone());
        }
        let e = Arc::new(Embedder::new()?);
        *guard = Some(e.clone());
        Ok(e)
    }

    pub fn try_begin_indexing(&self) -> bool {
        // Cancel any in-flight Pass 2 before starting a fresh Pass 1.
        self.request_cancel_pass2();
        self.indexing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Acquire the indexing lock for small live updates without cancelling Pass 2.
    pub fn try_begin_live_sync(&self) -> bool {
        self.indexing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn end_indexing(&self) {
        self.indexing.store(false, Ordering::SeqCst);
    }

    pub fn is_indexing(&self) -> bool {
        self.indexing.load(Ordering::SeqCst)
    }

    pub fn stats(&self) -> KnowledgeBaseStats {
        self.kb.read().stats()
    }

    pub fn background_status(&self) -> BackgroundIndexStatus {
        BackgroundIndexStatus {
            active: self.bg_active.load(Ordering::SeqCst),
            remaining: self.bg_remaining.load(Ordering::SeqCst),
            completed: self.bg_completed.load(Ordering::SeqCst),
            failed: self.bg_failed.load(Ordering::SeqCst),
            total: self.bg_total.load(Ordering::SeqCst),
        }
    }

    pub fn request_cancel_pass2(&self) {
        self.bg_cancel.store(true, Ordering::SeqCst);
        // Best-effort join of previous worker (don't block forever).
        if let Some(handle) = self.bg_handle.lock().take() {
            let _ = handle.join();
        }
        self.bg_active.store(false, Ordering::SeqCst);
        self.bg_remaining.store(0, Ordering::SeqCst);
        self.bg_cancel.store(false, Ordering::SeqCst);
    }

    pub fn clear(&self) -> Result<(), EngineError> {
        self.request_cancel_pass2();
        {
            let mut kb = self.kb.write();
            *kb = KnowledgeBase::new();
            kb.save_graph(&self.data_dir.join("graph.bin"))?;
            kb.save_vectors(&self.data_dir.join("vectors.bin"))?;
        }
        self.index.clear()?;
        let _ = self.index.commit();
        let empty = crate::doc_graph::manifest::IndexManifest::default();
        empty.save(&self.data_dir)?;
        Ok(())
    }

    /// Background: incremental sync of `$HOME` (or `USERPROFILE`) so the KB is
    /// queryable soon after launch. First run indexes everything discovered;
    /// later restarts only re-index new/changed files and drop deleted ones.
    pub fn spawn_home_autostart(
        self: &Arc<Self>,
        app: Option<tauri::AppHandle>,
    ) {
        if !self.try_begin_indexing() {
            log::info!("Doc-graph autostart skipped (indexing already in progress)");
            return;
        }

        let engine = Arc::clone(self);
        let handle = std::thread::Builder::new()
            .name("doc-graph-autostart".into())
            .spawn(move || {
                let home = std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(PathBuf::from);
                let Some(home) = home else {
                    log::warn!("Doc-graph autostart: HOME unavailable");
                    engine.end_indexing();
                    return;
                };
                if !home.is_dir() {
                    log::warn!("Doc-graph autostart: {} is not a directory", home.display());
                    engine.end_indexing();
                    return;
                }

                let on_progress: crate::doc_graph::engine::ProgressCallback = Arc::new({
                    let app = app.clone();
                    move |progress: IndexingProgress| {
                        if let Some(app) = &app {
                            let _ = app.emit("indexing-progress", &progress);
                        }
                        log::info!(
                            "[doc-graph] [{}] {}",
                            progress.phase,
                            progress.message
                        );
                    }
                });

                let result = (|| -> Result<_, EngineError> {
                    let embedder = engine.embedder()?;
                    let report = {
                        let mut kb = engine.kb.write();
                        crate::doc_graph::engine::run_incremental_sync(
                            &home,
                            &engine.data_dir,
                            &mut kb,
                            &engine.index,
                            &embedder,
                            None,
                            Some(on_progress.clone()),
                        )?
                    };
                    Ok(report)
                })();

                engine.end_indexing();

                match result {
                    Ok(report) => {
                        log::info!(
                            "Doc-graph home sync done: discovered={} parsed={} deferred={} failed={}",
                            report.files_discovered,
                            report.files_parsed,
                            report.files_deferred,
                            report.files_failed
                        );
                        engine.start_live_watch(home.clone());
                        let deferred: Vec<PathBuf> = report
                            .deferred_files
                            .iter()
                            .map(PathBuf::from)
                            .collect();
                        if !deferred.is_empty() {
                            let on_bg = Some(on_progress);
                            engine.spawn_pass2(deferred, on_bg);
                        }
                    }
                    Err(e) => log::error!("Doc-graph home autostart failed: {e}"),
                }
            });

        match handle {
            Ok(h) => {
                // Detach: do not block app exit on a long home crawl.
                std::mem::forget(h);
            }
            Err(e) => {
                log::error!("Failed to spawn doc-graph autostart: {e}");
                self.end_indexing();
            }
        }
    }

    /// Launch Pass 2 background retry for files deferred from Pass 1.
    pub fn spawn_pass2(
        self: &Arc<Self>,
        deferred: Vec<PathBuf>,
        on_progress: Option<crate::doc_graph::engine::ProgressCallback>,
    ) {
        if deferred.is_empty() {
            return;
        }

        // Replace any previous Pass 2 worker.
        self.request_cancel_pass2();

        let total = deferred.len();
        self.bg_total.store(total, Ordering::SeqCst);
        self.bg_remaining.store(total, Ordering::SeqCst);
        self.bg_completed.store(0, Ordering::SeqCst);
        self.bg_failed.store(0, Ordering::SeqCst);
        self.bg_cancel.store(false, Ordering::SeqCst);
        self.bg_active.store(true, Ordering::SeqCst);

        let engine = Arc::clone(self);
        let handle = std::thread::Builder::new()
            .name("doc-graph-pass2".into())
            .spawn(move || {
                engine.run_pass2(deferred, on_progress);
            })
            .expect("spawn Pass 2 worker");

        *self.bg_handle.lock() = Some(handle);
    }

    /// Block until the Pass 2 worker finishes (no-op if none is running).
    pub fn join_pass2(&self) {
        if let Some(handle) = self.bg_handle.lock().take() {
            let _ = handle.join();
        }
    }

    fn run_pass2(
        self: &Arc<Self>,
        deferred: Vec<PathBuf>,
        on_progress: Option<crate::doc_graph::engine::ProgressCallback>,
    ) {
        let emit = |p: IndexingProgress| {
            if let Some(cb) = &on_progress {
                cb(p);
            }
        };

        emit(IndexingProgress {
            phase: "pass2".into(),
            message: format!(
                "Pass 2: retrying {} deferred files (≤{}ms, {} threads)",
                deferred.len(),
                PARSE_TIMEOUT_PASS2.as_millis(),
                PASS2_THREADS
            ),
            ..Default::default()
        });

        let registry = Arc::new(ParserRegistry::new());
        let pool = match rayon::ThreadPoolBuilder::new()
            .num_threads(PASS2_THREADS)
            .build()
        {
            Ok(p) => p,
            Err(e) => {
                log::error!("Pass 2 pool failed: {e}");
                self.bg_active.store(false, Ordering::SeqCst);
                return;
            }
        };

        // Process in small batches so we can commit periodically without
        // holding the KB write lock across the whole queue.
        for (batch_idx, batch) in deferred.chunks(PASS2_COMMIT_EVERY).enumerate() {
            if self.bg_cancel.load(Ordering::SeqCst) {
                break;
            }

            let results: Vec<(PathBuf, Result<(usize, Option<FileFingerprint>), String>)> =
                pool.install(|| {
                use rayon::prelude::*;
                batch
                    .par_iter()
                    .map(|path| {
                        if self.bg_cancel.load(Ordering::SeqCst) {
                            return (path.clone(), Err("cancelled".into()));
                        }
                        // Pass 2: PDF uses pdfium/lopdf fallback; catch_unwind inside parse_one_pass2.
                        let parse_reg = registry.clone();
                        let parsed = crate::doc_graph::engine::pipeline::parse_pass2_with_timeout(
                            parse_reg,
                            path.clone(),
                            PARSE_TIMEOUT_PASS2,
                        );
                        match parsed {
                            Ok((path, doc)) => {
                                let prepared =
                                    crate::doc_graph::graph::builder::prepare_chunks(&path, &doc);
                                let n = prepared.len();
                                if let Err(e) =
                                    crate::doc_graph::graph::builder::index_prepared_chunks(
                                        &self.index,
                                        &prepared,
                                    )
                                {
                                    return (path, Err(e.to_string()));
                                }
                                let fp = FileFingerprint::from_path_with_extraction(
                                    &path,
                                    &doc.extraction,
                                )
                                .or_else(|| FileFingerprint::from_path(&path));
                                // Short write lock for structural graph update.
                                {
                                    let mut kb = self.kb.write();
                                    if let Err(e) =
                                        crate::doc_graph::graph::builder::assemble_graph_only(
                                            &mut kb, &path, &doc,
                                        )
                                    {
                                        return (path, Err(e.to_string()));
                                    }
                                }
                                (path, Ok((n, fp)))
                            }
                            Err((path, e)) => (path, Err(e.to_string())),
                        }
                    })
                    .collect()
            });

            let mut batch_ok = 0usize;
            let mut recovered: Vec<(PathBuf, Option<FileFingerprint>)> = Vec::new();
            for (path, result) in results {
                self.bg_remaining.fetch_sub(1, Ordering::SeqCst);
                match result {
                    Ok((_n, fp)) => {
                        batch_ok += 1;
                        recovered.push((path, fp));
                        self.bg_completed.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(e) => {
                        self.bg_failed.fetch_add(1, Ordering::SeqCst);
                        log::warn!("Pass 2 failed: {e}");
                    }
                }
            }

            // Periodic commit so newly retried docs become searchable.
            if batch_ok > 0 {
                if let Err(e) = self.index.commit() {
                    log::warn!("Pass 2 commit failed: {e}");
                }
                if let Err(e) = self.persist_graph() {
                    log::warn!("Pass 2 graph persist failed: {e}");
                }
                // Record fingerprints so the next restart won't re-queue them.
                if let Ok(mut manifest) = IndexManifest::load(&self.data_dir) {
                    for (path, fp) in &recovered {
                        if let Some(fp) = fp.clone().or_else(|| FileFingerprint::from_path(path)) {
                            manifest.upsert(path, fp);
                        }
                    }
                    let _ = manifest.save(&self.data_dir);
                }
            }

            let status = self.background_status();
            emit(IndexingProgress {
                phase: "pass2".into(),
                files_parsed: status.completed,
                files_failed: status.failed,
                chunks_indexed: 0,
                files_discovered: status.total,
                message: format!(
                    "Pass 2 batch {}: {} done, {} failed, {} remaining",
                    batch_idx + 1,
                    status.completed,
                    status.failed,
                    status.remaining
                ),
            });
        }

        // Final commit + persist.
        let _ = self.index.commit();
        let _ = self.persist_graph();

        self.bg_active.store(false, Ordering::SeqCst);
        self.bg_remaining.store(0, Ordering::SeqCst);

        let status = self.background_status();
        emit(IndexingProgress {
            phase: "pass2-done".into(),
            files_discovered: status.total,
            files_parsed: status.completed,
            files_failed: status.failed,
            message: format!(
                "Pass 2 complete: {} recovered, {} failed (timeout was {}ms)",
                status.completed,
                status.failed,
                PARSE_TIMEOUT_PASS2.as_millis()
            ),
            ..Default::default()
        });
    }

    fn persist_graph(&self) -> Result<(), EngineError> {
        let kb = self.kb.read();
        kb.save_graph(&self.data_dir.join("graph.bin"))?;
        kb.save_vectors(&self.data_dir.join("vectors.bin"))?;
        Ok(())
    }

    /// Replace the live FS watcher for `root` (home or a manually indexed directory).
    pub fn start_live_watch(self: &Arc<Self>, root: PathBuf) {
        let mut slot = self.live_watch.lock();
        if let Some(prev) = slot.take() {
            prev.stop();
        }
        *slot = crate::doc_graph::watcher::start_live_watch(Arc::clone(self), root);
    }
}

pub struct DocGraphState(pub Arc<DocGraphEngine>);

impl DocGraphState {
    pub fn open(data_dir: PathBuf) -> Result<Self, EngineError> {
        Ok(Self(Arc::new(DocGraphEngine::open(data_dir)?)))
    }
}
