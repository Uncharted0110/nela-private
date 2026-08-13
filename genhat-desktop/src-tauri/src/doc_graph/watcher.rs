//! Live filesystem watching for the doc-graph knowledge base.
//!
//! Debounces create/modify/remove/rename events under the indexed root and
//! applies path-level `sync_paths` so search stops returning deleted or stale
//! file contents without waiting for the next full home scan.

use crate::doc_graph::engine::pipeline::{sync_paths, EXCLUDED_DIR_NAMES};
use crate::doc_graph::state::DocGraphEngine;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use notify::event::ModifyKind;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_millis(750);
const PERIODIC_RESYNC: Duration = Duration::from_secs(10 * 60);
const MAX_BATCH: usize = 64;

pub struct LiveWatchHandle {
    stop: Arc<AtomicBool>,
    _watcher_thread: JoinHandle<()>,
}

impl LiveWatchHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for LiveWatchHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

fn path_excluded(path: &Path) -> bool {
    path.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        EXCLUDED_DIR_NAMES
            .iter()
            .any(|ex| name.eq_ignore_ascii_case(ex))
    })
}

fn collect_event_paths(event: Event, out: &mut HashSet<PathBuf>) {
    // Create / modify (content or name) / remove — ignore access-only noise.
    let interesting = matches!(
        event.kind,
        EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Name(_))
            | EventKind::Modify(ModifyKind::Any)
            | EventKind::Any
    );
    if !interesting {
        return;
    }
    for p in event.paths {
        if !path_excluded(&p) {
            out.insert(p);
        }
    }
}

/// Start recursive live watching of `root`. Replaces any previous watch on `engine`.
pub fn start_live_watch(engine: Arc<DocGraphEngine>, root: PathBuf) -> Option<LiveWatchHandle> {
    if !root.is_dir() {
        log::warn!(
            "Doc-graph live watch skipped: {} is not a directory",
            root.display()
        );
        return None;
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);
    let engine_thread = Arc::clone(&engine);
    let root_thread = root.clone();

    let handle = std::thread::Builder::new()
        .name("doc-graph-watch".into())
        .spawn(move || {
            run_watch_loop(engine_thread, root_thread, stop_thread);
        })
        .ok()?;

    log::info!("Doc-graph live watch started on {}", root.display());
    Some(LiveWatchHandle {
        stop,
        _watcher_thread: handle,
    })
}

fn run_watch_loop(engine: Arc<DocGraphEngine>, root: PathBuf, stop: Arc<AtomicBool>) {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = match RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        notify::Config::default(),
    ) {
        Ok(w) => w,
        Err(e) => {
            log::error!("Doc-graph live watch: failed to create watcher: {e}");
            return;
        }
    };

    if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
        log::error!(
            "Doc-graph live watch: failed to watch {}: {e}",
            root.display()
        );
        return;
    }

    let mut pending: HashSet<PathBuf> = HashSet::new();
    let mut last_event = Instant::now();
    let mut last_full_sync = Instant::now();

    while !stop.load(Ordering::SeqCst) {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(event)) => {
                collect_event_paths(event, &mut pending);
                last_event = Instant::now();
            }
            Ok(Err(e)) => {
                log::warn!("Doc-graph live watch event error: {e}");
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        let debounce_ready =
            !pending.is_empty() && last_event.elapsed() >= DEBOUNCE;
        let periodic_due = last_full_sync.elapsed() >= PERIODIC_RESYNC;

        if debounce_ready {
            if engine.is_indexing() || engine.background_status().active {
                // Keep events queued; never start a second all-core job.
            } else {
                let batch: Vec<PathBuf> = pending.iter().take(MAX_BATCH).cloned().collect();
                for p in &batch {
                    pending.remove(p);
                }
                flush_paths(&engine, &batch);
            }
        }

        if periodic_due {
            last_full_sync = Instant::now();
            // Lightweight safety net: re-diff the whole root when idle.
            if !engine.is_indexing() && !engine.background_status().active {
                flush_full_resync(&engine, &root);
            }
        }
    }

    let _ = watcher.unwatch(&root);
    log::info!("Doc-graph live watch stopped for {}", root.display());
}

fn flush_paths(engine: &Arc<DocGraphEngine>, paths: &[PathBuf]) {
    if paths.is_empty() {
        return;
    }
    if engine.background_status().active {
        log::debug!(
            "Doc-graph live sync deferred (pass2 active): {} path(s)",
            paths.len()
        );
        return;
    }
    if !engine.try_begin_live_sync() {
        log::debug!(
            "Doc-graph live sync deferred (busy): {} path(s)",
            paths.len()
        );
        return;
    }

    let result = (|| -> Result<(), crate::doc_graph::errors::EngineError> {
        let embedder = engine.embedder()?;
        let report = sync_paths(
            paths,
            &engine.data_dir,
            &engine.kb,
            &engine.index,
            &embedder,
            None,
        )?;
        log::info!(
            "Doc-graph live sync: parsed={} removed_hint={} deferred={}",
            report.files_parsed,
            report.files_discovered.saturating_sub(report.files_parsed),
            report.files_deferred
        );
        if !report.deferred_files.is_empty() {
            let deferred: Vec<PathBuf> = report
                .deferred_files
                .iter()
                .map(PathBuf::from)
                .collect();
            engine.end_indexing();
            engine.spawn_pass2(deferred, None);
            return Ok(());
        }
        Ok(())
    })();

    engine.end_indexing();
    if let Err(e) = result {
        log::warn!("Doc-graph live sync failed: {e}");
    }
}

fn flush_full_resync(engine: &Arc<DocGraphEngine>, root: &Path) {
    if !engine.try_begin_live_sync() {
        return;
    }
    let result = (|| -> Result<(), crate::doc_graph::errors::EngineError> {
        let embedder = engine.embedder()?;
        let report = crate::doc_graph::engine::run_incremental_sync(
            root,
            &engine.data_dir,
            &engine.kb,
            &engine.index,
            &embedder,
            None,
            None,
        )?;
        log::info!(
            "Doc-graph periodic resync: discovered={} parsed={} deferred={}",
            report.files_discovered,
            report.files_parsed,
            report.files_deferred
        );
        if !report.deferred_files.is_empty() {
            let deferred: Vec<PathBuf> = report
                .deferred_files
                .iter()
                .map(PathBuf::from)
                .collect();
            engine.end_indexing();
            engine.spawn_pass2(deferred, None);
            return Ok(());
        }
        Ok(())
    })();
    engine.end_indexing();
    if let Err(e) = result {
        log::warn!("Doc-graph periodic resync failed: {e}");
    }
}

/// Shared slot on the engine so watches can be replaced.
pub type LiveWatchSlot = Mutex<Option<LiveWatchHandle>>;
