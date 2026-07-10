use crate::governor::{CancellationToken, Governor};
use crate::indexer::db::IndexerDb;
use crate::indexer::paths::{
    collect_index_roots, delete_index_paths, is_blacklisted, normalize_index_path,
};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

/// Start real-time file watching on the home directory (recursive) and any
/// workspace roots outside home. Uses the same root set as the background crawler.
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

    let watch_roots = collect_index_roots(&root_dir, &workspace_paths);
    for dir in &watch_roots {
        if let Err(e) = watcher.watch(dir, RecursiveMode::Recursive) {
            log::warn!(
                "Failed to watch {}: {} (index updates may lag until the next crawl)",
                dir.display(),
                e
            );
        } else {
            log::info!("Watching recursively: {}", dir.display());
        }
    }

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
                if is_blacklisted(&path) {
                    continue;
                }

                let path_str = normalize_index_path(&path);

                if kind.is_remove() {
                    log::debug!("File removed event: {}", path_str);
                    delete_index_paths(&db_clone, &path);
                } else if kind.is_create() || kind.is_modify() {
                    log::debug!("File created/modified event: {}", path_str);

                    let metadata = match fs::metadata(&path) {
                        Ok(m) => m,
                        Err(_) => {
                            delete_index_paths(&db_clone, &path);
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
                            "txt" | "md" => crate::indexer::crawler::read_first_10kb(&path),
                            _ => None,
                        };
                    }

                    let name_tokens = crate::indexer::crawler::tokenize_filename(&filename);
                    let location = crate::indexer::crawler::parent_location(&path, 2);
                    if let Err(e) = db_clone.insert_or_update(
                        &path_str,
                        &filename,
                        &name_tokens,
                        &location,
                        mtime,
                        size,
                        is_dir,
                        content.as_deref(),
                    ) {
                        log::error!("Watcher failed to index {}: {}", path_str, e);
                    } else {
                        let legacy = path.to_string_lossy().into_owned();
                        if legacy != path_str {
                            db_clone.delete(&legacy).ok();
                        }
                    }
                }
            }
        }
        log::info!("Watcher event processing loop stopped.");
    });

    Ok(watcher)
}
