//! Long-lived FileIndexer sidecar for NELA.
//! Speaks NDJSON on stdout (events) and accepts NDJSON commands on stdin.
//!
//! The embedding model stays loaded while active; after idle timeout it is
//! dropped ("sleep") and reloaded on the next search/reindex ("wake").
//! Folder changes use `{"cmd":"reindex"}` so the process (and warm model)
//! are not restarted.

use clap::Parser;
use file_indexer::{Embedder, FilenameIndex, MatchField};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Drop the embedding model after this much silence (search / reindex / embed).
const IDLE_SLEEP_AFTER: Duration = Duration::from_secs(15 * 60);
const IDLE_POLL: Duration = Duration::from_secs(30);

#[derive(Parser, Debug)]
#[command(name = "fileindexer_sidecar")]
struct Args {
    /// Directory for index.bin, roots.txt, and status snapshots.
    #[arg(long)]
    data_dir: PathBuf,

    /// fastembed cache directory (parent of models--Qdrant--all-MiniLM-L6-v2-onnx).
    #[arg(long)]
    cache_dir: PathBuf,

    /// Optional roots file (one path per line). Defaults to `{data_dir}/roots.txt`.
    #[arg(long)]
    roots_file: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
struct StatusEvent {
    event: &'static str,
    phase: String,
    files_total: usize,
    files_embedded: usize,
    embed_done: usize,
    embed_total: usize,
    message: String,
}

#[derive(Debug, Deserialize)]
struct InCommand {
    cmd: String,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    id: Option<u64>,
}

#[derive(Debug, Serialize)]
struct SearchHit {
    path: String,
    score: f64,
    fields: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
struct SearchResultEvent {
    event: &'static str,
    id: Option<u64>,
    results: Vec<SearchHit>,
}

fn emit(value: &impl Serialize) {
    let mut out = io::stdout();
    if let Ok(line) = serde_json::to_string(value) {
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

fn emit_status(
    phase: &str,
    files_total: usize,
    files_embedded: usize,
    embed_done: usize,
    embed_total: usize,
    message: impl Into<String>,
) {
    emit(&StatusEvent {
        event: "status",
        phase: phase.to_string(),
        files_total,
        files_embedded,
        embed_done,
        embed_total,
        message: message.into(),
    });
}

fn load_roots(path: &Path) -> Vec<PathBuf> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|l| PathBuf::from(l.trim()))
        .filter(|p| !p.as_os_str().is_empty())
        .collect()
}

fn batch_size_path(data_dir: &Path) -> PathBuf {
    data_dir.join("embed_batch_size.txt")
}

fn load_batch_size(data_dir: &Path) -> Option<usize> {
    let raw = std::fs::read_to_string(batch_size_path(data_dir)).ok()?;
    let n: usize = raw.trim().parse().ok()?;
    (n >= 8 && n <= 256).then_some(n)
}

fn save_batch_size(data_dir: &Path, batch_size: usize) {
    let _ = std::fs::write(batch_size_path(data_dir), batch_size.to_string());
}

const BATCH_BENCHMARK_FILE_THRESHOLD: usize = 1000;
const DEFAULT_BATCH: usize = 32;

fn resolve_batch_size(
    data_dir: &Path,
    index: &FilenameIndex,
    embedder: &mut Embedder,
    files_total: usize,
    pending_embed: usize,
) -> usize {
    let cached = load_batch_size(data_dir);
    if pending_embed == 0 {
        return cached.unwrap_or(DEFAULT_BATCH);
    }
    if files_total < BATCH_BENCHMARK_FILE_THRESHOLD {
        let batch = cached.unwrap_or(DEFAULT_BATCH);
        eprintln!(
            "fileindexer_sidecar: {files_total} files (< {BATCH_BENCHMARK_FILE_THRESHOLD}) — using batch size {batch}"
        );
        if cached.is_none() {
            save_batch_size(data_dir, batch);
        }
        return batch;
    }

    emit_status(
        "embedding",
        files_total,
        files_total.saturating_sub(pending_embed),
        0,
        pending_embed,
        "Finding optimal embedding batch size…",
    );
    let best = index.benchmark_batch_size(embedder, &[8, 16, 32, 64], 32);
    save_batch_size(data_dir, best);
    best
}

fn field_name(f: &MatchField) -> &'static str {
    match f {
        MatchField::Title => "title",
        MatchField::Body => "body",
        MatchField::Semantic => "semantic",
    }
}

fn touch(last_used: &Mutex<Instant>) {
    if let Ok(mut t) = last_used.lock() {
        *t = Instant::now();
    }
}

fn load_embedder(cache_dir: &Path) -> Result<Embedder, String> {
    Embedder::with_cache_dir(cache_dir).map_err(|e| e.to_string())
}

fn ensure_awake(
    slot: &Mutex<Option<Embedder>>,
    cache_dir: &Path,
    last_used: &Mutex<Instant>,
    files_total: usize,
) -> Result<(), String> {
    touch(last_used);
    let mut g = slot.lock().map_err(|e| e.to_string())?;
    if g.is_some() {
        return Ok(());
    }
    emit_status(
        "loading_model",
        files_total,
        0,
        0,
        0,
        "Waking embedding model…",
    );
    eprintln!("fileindexer_sidecar: waking embedding model");
    *g = Some(load_embedder(cache_dir)?);
    Ok(())
}

fn put_to_sleep(slot: &Mutex<Option<Embedder>>, files_total: usize, embedded: usize) {
    let mut g = match slot.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if g.is_none() {
        return;
    }
    *g = None;
    eprintln!("fileindexer_sidecar: embedding model sleeping (idle)");
    emit_status(
        "sleeping",
        files_total,
        embedded,
        embedded,
        embedded,
        "Embedding model sleeping — will wake on next search",
    );
}

fn scan_progress(phase: &str, done: usize, total: usize) {
    let msg = if total > 0 {
        format!("Extracting content {done}/{total}")
    } else {
        format!("Scanning… {done} files found")
    };
    emit_status(
        "scanning",
        if total > 0 { total } else { done },
        0,
        done,
        total,
        format!("{phase}: {msg}"),
    );
}

fn build_or_load_index(index_path: &Path, roots: &[PathBuf]) -> (FilenameIndex, bool) {
    if index_path.exists() {
        match FilenameIndex::load(index_path) {
            Ok(idx) => return (idx, false),
            Err(e) => {
                eprintln!("fileindexer_sidecar: load failed ({e}); rebuilding");
                let _ = std::fs::remove_file(index_path);
            }
        }
    }
    let idx = FilenameIndex::build_from_roots_with_progress(roots, scan_progress);
    (idx, true)
}

fn refresh_index(index: &mut FilenameIndex, roots: &[PathBuf], rebuilt: bool) {
    if rebuilt {
        return;
    }
    index.retain_under_roots(roots);
    for root in roots {
        let root_label = root.display().to_string();
        index.add_root_with_progress(root, |seen, changed| {
            emit_status(
                "scanning",
                seen,
                0,
                changed,
                seen,
                format!("Refreshing {root_label}: {changed} changed / {seen} seen"),
            );
        });
    }
}

fn embed_pending(
    index: &mut FilenameIndex,
    embedder: &mut Embedder,
    data_dir: &Path,
    index_path: &Path,
) -> usize {
    let files_total = index.len();
    let pending_embed = index.iter().filter(|e| !e.has_embedding()).count();
    if pending_embed == 0 {
        return index.iter().filter(|e| e.has_embedding()).count();
    }

    emit_status(
        "embedding",
        files_total,
        files_total.saturating_sub(pending_embed),
        0,
        pending_embed,
        format!("Embedding {pending_embed} of {files_total} files…"),
    );

    let batch_size = resolve_batch_size(data_dir, index, embedder, files_total, pending_embed);
    match index.build_embeddings_with_progress(embedder, index_path, batch_size, |done, total| {
        emit_status(
            "embedding",
            files_total,
            done,
            done,
            total,
            format!("Embedding {done}/{total}"),
        );
    }) {
        Ok(n) => n,
        Err(e) => {
            emit_status(
                "error",
                files_total,
                index.iter().filter(|e| e.has_embedding()).count(),
                0,
                0,
                format!("Embedding stopped early: {e}"),
            );
            index.iter().filter(|e| e.has_embedding()).count()
        }
    }
}

fn set_watches(watcher: &mut RecommendedWatcher, old: &[PathBuf], new_roots: &[PathBuf]) {
    for r in old {
        let _ = watcher.unwatch(r);
    }
    for r in new_roots {
        if let Err(e) = watcher.watch(r, RecursiveMode::Recursive) {
            eprintln!("fileindexer_sidecar: watch {}: {e}", r.display());
        }
    }
}

fn main() {
    let args = Args::parse();
    let _ = std::fs::create_dir_all(&args.data_dir);
    let roots_path = args
        .roots_file
        .unwrap_or_else(|| args.data_dir.join("roots.txt"));
    let index_path = args.data_dir.join("file_indexer_index.bin");

    let mut roots = load_roots(&roots_path);
    if roots.is_empty() {
        emit_status("error", 0, 0, 0, 0, "No roots configured");
        eprintln!("fileindexer_sidecar: no roots in {}", roots_path.display());
        std::process::exit(2);
    }

    // Keep the model warm for the process lifetime (until idle sleep).
    emit_status(
        "loading_model",
        0,
        0,
        0,
        0,
        format!("Loading embedding model from {}", args.cache_dir.display()),
    );
    let embedder_slot: Arc<Mutex<Option<Embedder>>> = Arc::new(Mutex::new(Some(
        match load_embedder(&args.cache_dir) {
            Ok(e) => e,
            Err(e) => {
                emit_status("error", 0, 0, 0, 0, format!("Failed to load embedding model: {e}"));
                eprintln!("fileindexer_sidecar: embedder init failed: {e}");
                std::process::exit(3);
            }
        },
    )));
    let last_used = Arc::new(Mutex::new(Instant::now()));

    emit_status("scanning", 0, 0, 0, 0, "Building / loading file index…");
    let (mut index, rebuilt) = build_or_load_index(&index_path, &roots);
    refresh_index(&mut index, &roots, rebuilt);
    if let Err(e) = index.save(&index_path) {
        eprintln!("fileindexer_sidecar: save failed: {e}");
    }

    let embedded_count = {
        let mut g = embedder_slot.lock().expect("embedder lock");
        let emb = g.as_mut().expect("model just loaded");
        touch(&last_used);
        embed_pending(&mut index, emb, &args.data_dir, &index_path)
    };

    let mut files_total = index.len();
    emit_status(
        "ready",
        files_total,
        embedded_count,
        embedded_count,
        embedded_count,
        format!("Indexed {files_total} files ({embedded_count} with embeddings)"),
    );

    let index = Arc::new(RwLock::new(index));
    let stop_idle = Arc::new(AtomicBool::new(false));

    // Idle sleeper: unload model after IDLE_SLEEP_AFTER with no activity.
    {
        let slot = Arc::clone(&embedder_slot);
        let last = Arc::clone(&last_used);
        let idx = Arc::clone(&index);
        let stop = Arc::clone(&stop_idle);
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                std::thread::sleep(IDLE_POLL);
                let idle_for = last.lock().map(|t| t.elapsed()).unwrap_or(Duration::ZERO);
                if idle_for < IDLE_SLEEP_AFTER {
                    continue;
                }
                let (total, embedded) = idx
                    .read()
                    .map(|i| {
                        (
                            i.len(),
                            i.iter().filter(|e| e.has_embedding()).count(),
                        )
                    })
                    .unwrap_or((0, 0));
                put_to_sleep(&slot, total, embedded);
            }
        });
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .expect("failed to create watcher");
    set_watches(&mut watcher, &[], &roots);

    let watched_index = Arc::clone(&index);
    std::thread::spawn(move || {
        for res in rx {
            let Ok(event) = res else { continue };
            let Ok(mut idx) = watched_index.write() else { continue };
            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {
                    for path in &event.paths {
                        idx.upsert_path(path);
                    }
                }
                EventKind::Remove(_) => {
                    for path in &event.paths {
                        idx.remove_path(path);
                    }
                }
                _ => {}
            }
        }
    });

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(cmd) = serde_json::from_str::<InCommand>(line) else {
            continue;
        };
        match cmd.cmd.as_str() {
            "shutdown" | "quit" => {
                stop_idle.store(true, Ordering::Relaxed);
                if let Ok(idx) = index.read() {
                    let _ = idx.save(&index_path);
                }
                emit_status("ready", files_total, 0, 0, 0, "Shutting down");
                break;
            }
            "status" => {
                let sleeping = embedder_slot
                    .lock()
                    .map(|g| g.is_none())
                    .unwrap_or(true);
                let (total, embedded) = index
                    .read()
                    .map(|idx| {
                        (
                            idx.len(),
                            idx.iter().filter(|e| e.has_embedding()).count(),
                        )
                    })
                    .unwrap_or((files_total, 0));
                files_total = total;
                if sleeping {
                    emit_status(
                        "sleeping",
                        total,
                        embedded,
                        embedded,
                        embedded,
                        "Embedding model sleeping — will wake on next search",
                    );
                } else {
                    emit_status(
                        "ready",
                        total,
                        embedded,
                        embedded,
                        embedded,
                        format!("Indexed {total} files ({embedded} with embeddings)"),
                    );
                }
            }
            "wake" => {
                let _ = ensure_awake(&embedder_slot, &args.cache_dir, &last_used, files_total);
                let (total, embedded) = index
                    .read()
                    .map(|idx| {
                        (
                            idx.len(),
                            idx.iter().filter(|e| e.has_embedding()).count(),
                        )
                    })
                    .unwrap_or((files_total, 0));
                emit_status(
                    "ready",
                    total,
                    embedded,
                    embedded,
                    embedded,
                    "Embedding model awake",
                );
            }
            "reindex" => {
                touch(&last_used);
                let new_roots = load_roots(&roots_path);
                if new_roots.is_empty() {
                    emit_status("error", files_total, 0, 0, 0, "No roots configured");
                    continue;
                }
                emit_status("scanning", 0, 0, 0, 0, "Refreshing folders…");
                set_watches(&mut watcher, &roots, &new_roots);
                roots = new_roots;

                let mut idx = match index.write() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                // Prefer incremental refresh against the live index.
                refresh_index(&mut idx, &roots, false);
                if let Err(e) = idx.save(&index_path) {
                    eprintln!("fileindexer_sidecar: save failed: {e}");
                }
                files_total = idx.len();

                if let Err(e) =
                    ensure_awake(&embedder_slot, &args.cache_dir, &last_used, files_total)
                {
                    emit_status("error", files_total, 0, 0, 0, e);
                    continue;
                }
                let embedded = {
                    let mut g = embedder_slot.lock().expect("embedder lock");
                    let emb = g.as_mut().expect("awake");
                    embed_pending(&mut idx, emb, &args.data_dir, &index_path)
                };
                emit_status(
                    "ready",
                    files_total,
                    embedded,
                    embedded,
                    embedded,
                    format!("Indexed {files_total} files ({embedded} with embeddings)"),
                );
            }
            "search" => {
                let query = cmd.query.unwrap_or_default();
                let id = cmd.id;
                if let Err(e) =
                    ensure_awake(&embedder_slot, &args.cache_dir, &last_used, files_total)
                {
                    emit(&SearchResultEvent {
                        event: "search_result",
                        id,
                        results: Vec::new(),
                    });
                    emit_status("error", files_total, 0, 0, 0, e);
                    continue;
                }
                let results = match (index.read(), embedder_slot.lock()) {
                    (Ok(idx), Ok(mut slot)) => {
                        let emb = slot.as_mut().expect("awake");
                        let fused = idx.search_fused(emb, &query);
                        fused
                            .into_iter()
                            .take(20)
                            .map(|r| SearchHit {
                                path: r.entry.path.display().to_string(),
                                score: r.score,
                                fields: r.matched_fields.iter().map(field_name).collect(),
                            })
                            .collect::<Vec<_>>()
                    }
                    _ => Vec::new(),
                };
                emit(&SearchResultEvent {
                    event: "search_result",
                    id,
                    results,
                });
            }
            "save" => {
                if let Ok(idx) = index.read() {
                    let _ = idx.save(&index_path);
                }
            }
            _ => {}
        }
    }

    stop_idle.store(true, Ordering::Relaxed);
}
