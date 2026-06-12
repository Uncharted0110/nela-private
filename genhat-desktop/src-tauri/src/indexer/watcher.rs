use crate::governor::{CancellationToken, Governor};
use crate::indexer::db::IndexerDb;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

/// Start real-time file watching on the root home directory with Linux watch limit fallback.
pub fn start_watcher(
    root_dir: PathBuf,
    db: IndexerDb,
    governor: Arc<Governor>,
    cancel_token: CancellationToken,
    workspace_paths: Vec<PathBuf>,
) -> Result<RecommendedWatcher, String> {
    let db_clone = db.clone();
    let governor_clone = governor.clone();
    let cancel_clone = cancel_token.clone();

    // Channel for forwarding notify events to processor thread
    let (tx, rx) = std::sync::mpsc::channel();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {e}"))?;

    // 1. Watch active workspaces recursively
    for ws_path in &workspace_paths {
        if ws_path.exists() {
            if let Err(e) = watcher.watch(ws_path, RecursiveMode::Recursive) {
                log::warn!("Failed to watch workspace {}: {}", ws_path.display(), e);
            } else {
                log::info!("Watching workspace recursively: {}", ws_path.display());
            }
        }
    }

    // 2. Watch standard user folders recursively
    let documents = root_dir.join("Documents");
    let downloads = root_dir.join("Downloads");
    let desktop = root_dir.join("Desktop");

    for dir in &[documents, downloads, desktop] {
        if dir.exists() {
            if let Err(e) = watcher.watch(dir, RecursiveMode::Recursive) {
                log::warn!("Failed to watch standard directory {}: {}", dir.display(), e);
            } else {
                log::info!("Watching standard directory recursively: {}", dir.display());
            }
        }
    }

    // 3. Watch home directory top-level folder non-recursively
    if let Err(e) = watcher.watch(&root_dir, RecursiveMode::NonRecursive) {
        log::warn!("Failed to watch top-level {}: {}", root_dir.display(), e);
    } else {
        log::info!("Watching top-level home directory non-recursively.");
    }

    // Spawn the background thread to handle watcher events
    std::thread::spawn(move || {
        log::info!("Watcher event processing loop started.");
        let mut duty_guard = governor_clone.indexer_duty_cycle();

        while let Ok(event) = rx.recv() {
            if cancel_clone.is_cancelled() {
                break;
            }

            duty_guard.checkpoint_sync();

            let paths = event.paths;
            let kind = event.kind;

            for path in paths {
                // Ignore blacklisted files/directories
                if crate::indexer::crawler::is_blacklisted(&path) {
                    continue;
                }

                let path_str = path.to_string_lossy().to_string();

                if kind.is_remove() {
                    log::debug!("File removed event: {}", path_str);
                    if let Err(e) = db_clone.delete(&path_str) {
                        log::error!("Failed to delete index record for removed file {}: {}", path_str, e);
                    }
                } else if kind.is_create() || kind.is_modify() {
                    log::debug!("File created/modified event: {}", path_str);

                    let metadata = match fs::metadata(&path) {
                        Ok(m) => m,
                        Err(_) => {
                            // File was deleted or inaccessible
                            db_clone.delete(&path_str).ok();
                            continue;
                        }
                    };

                    let is_dir = metadata.is_dir();
                    let size = metadata.len() as i64;
                    let mtime = metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);

                    // Incremental write check
                    if let Ok(Some((db_mtime, db_size))) = db_clone.get_file_metadata(&path_str) {
                        if db_mtime == mtime && db_size == size {
                            continue;
                        }
                    }

                    let filename = path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();

                    let mut content = None;

                    if !is_dir {
                        let ext = path
                            .extension()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_lowercase();

                        content = match ext.as_str() {
                            "xlsx" | "xls" | "ods" => crate::indexer::crawler::extract_excel_metadata(&path),
                            "csv" => crate::indexer::crawler::extract_csv_headers(&path),
                            "pdf" | "docx" | "pptx" => {
                                match crate::rag::parsers::parse_document(&path) {
                                    Ok(parsed) => {
                                        let text: String = parsed
                                            .sections
                                            .iter()
                                            .map(|s| s.text.as_str())
                                            .collect::<Vec<_>>()
                                            .join("\n\n");
                                        if text.trim().is_empty() {
                                            None
                                        } else {
                                            Some(text.chars().take(10240).collect())
                                        }
                                    }
                                    Err(_) => None,
                                }
                            }
                            "txt" | "md" | "rs" | "py" | "js" | "json" | "ts" | "tsx" | "html" | "css" | "toml" | "yaml" | "yml" => {
                                crate::indexer::crawler::read_first_10kb(&path)
                            }
                            _ => None,
                        };
                    }

                    if let Err(e) = db_clone.insert_or_update(&path_str, &filename, mtime, size, is_dir, content.as_deref()) {
                        log::error!("Watcher failed to index {}: {}", path_str, e);
                    }
                }
            }
        }
        log::info!("Watcher event processing loop stopped.");
    });

    Ok(watcher)
}
