use crate::governor::{CancellationToken, Governor};
use crate::indexer::db::IndexerDb;
use crate::indexer::paths::{
    collect_index_roots, index_path_exists, is_blacklisted, normalize_index_path,
    remove_from_path_set,
};
use calamine::{Reader, open_workbook_auto};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

/// Read first 10KB of a text file.
pub(crate) fn read_first_10kb(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 10240];
    let bytes_read = file.read(&mut buf).ok()?;
    let s = String::from_utf8_lossy(&buf[..bytes_read]);
    Some(s.into_owned())
}

/// Helper to convert calamine Cell Data to String.
fn cell_to_string(cell: &calamine::Data) -> String {
    use calamine::Data;
    match cell {
        Data::Int(n) => n.to_string(),
        Data::Float(f) => {
            if f.abs() < 1e15 && f.fract() == 0.0 {
                format!("{}", *f as i64)
            } else {
                format!("{f}")
            }
        }
        Data::String(s) => s.clone(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => format!("{dt}"),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("[Error: {e:?}]"),
        Data::Empty => String::new(),
    }
}

/// Extract Excel sheet names and column headers.
pub(crate) fn extract_excel_metadata(path: &Path) -> Option<String> {
    let mut workbook = open_workbook_auto(path).ok()?;
    let mut tokens = Vec::new();

    for sheet_name in workbook.sheet_names().to_vec() {
        tokens.push(format!("Sheet: {}", sheet_name));
        if let Ok(range) = workbook.worksheet_range(&sheet_name) {
            if !range.is_empty() {
                if let Some(first_row) = range.rows().next() {
                    let headers: Vec<String> = first_row
                        .iter()
                        .map(|cell| cell_to_string(cell))
                        .filter(|h| !h.is_empty())
                        .collect();
                    if !headers.is_empty() {
                        tokens.push(format!("Columns: {}", headers.join(", ")));
                    }
                }
            }
        }
    }
    Some(tokens.join("\n"))
}

/// Extract CSV column headers.
pub(crate) fn extract_csv_headers(path: &Path) -> Option<String> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_path(path)
        .ok()?;
    let headers = rdr.headers().ok()?;
    let header_list: Vec<&str> = headers.iter().collect();
    if !header_list.is_empty() {
        Some(format!("Columns: {}", header_list.join(", ")))
    } else {
        None
    }
}

/// Lowercase the filename and split it into space-separated tokens on
/// `_`, `-`, `.`, whitespace, AND camelCase boundaries.
/// "TaxReturn_2023.pdf" -> "tax return 2023 pdf"
pub(crate) fn tokenize_filename(filename: &str) -> String {
    let mut out = String::with_capacity(filename.len() * 2);
    let mut prev_lower = false;
    for ch in filename.chars() {
        if ch == '_' || ch == '-' || ch == '.' || ch.is_whitespace() {
            out.push(' ');
            prev_lower = false;
        } else {
            // camelCase boundary: lower/digit followed by Upper
            if ch.is_uppercase() && prev_lower {
                out.push(' ');
            }
            for c in ch.to_lowercase() {
                out.push(c);
            }
            prev_lower = ch.is_lowercase() || ch.is_numeric();
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The last `levels` parent directory names of `path`, tokenized like a filename.
/// ".../projectA/src/main.rs", levels=2 -> "projecta src"
pub(crate) fn parent_location(path: &std::path::Path, levels: usize) -> String {
    let mut comps: Vec<String> = path
        .parent()
        .map(|p| {
            p.components()
                .filter_map(|c| c.as_os_str().to_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let take = comps.len().min(levels);
    let tail = comps.split_off(comps.len() - take); // last `take` components
    tail.iter().map(|s| tokenize_filename(s)).collect::<Vec<_>>().join(" ")
}

/// Drop index rows whose files no longer exist (handles legacy path spellings).
fn prune_missing_files(
    db: &IndexerDb,
    governor: &Arc<Governor>,
    cancel_token: &CancellationToken,
) {
    log::info!("Pruning stale ambient index entries for missing files...");
    let paths = db.get_all_paths().unwrap_or_default();
    let mut duty_guard = governor.indexer_duty_cycle();
    let mut pruned = 0usize;

    for path_key in paths {
        if cancel_token.is_cancelled() {
            return;
        }
        duty_guard.checkpoint_sync();

        if index_path_exists(&path_key) {
            continue;
        }

        if db.delete(&path_key).is_ok() {
            pruned += 1;
        }
    }

    if pruned > 0 {
        log::info!("Pruned {pruned} stale ambient index record(s).");
    }
}

/// Main background crawling logic.
pub fn run_crawler(
    home_dir: PathBuf,
    workspace_paths: Vec<PathBuf>,
    db: IndexerDb,
    governor: Arc<Governor>,
    cancel_token: CancellationToken,
) {
    log::info!("Starting background ambient crawler...");

    prune_missing_files(&db, &governor, &cancel_token);

    // Gather all existing paths from database for deletion sync
    let mut db_paths: HashSet<String> = db.get_all_paths().unwrap_or_default().into_iter().collect();

    let mut duty_guard = governor.indexer_duty_cycle();

    let targets = collect_index_roots(&home_dir, &workspace_paths);

    for target_path in targets {
        if cancel_token.is_cancelled() {
            log::info!("Crawler cancelled cooperatively.");
            return;
        }

        log::info!("Crawling target recursively: {}", target_path.display());

        let walk = WalkDir::new(&target_path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !is_blacklisted(e.path()));

        for entry in walk {
            if cancel_token.is_cancelled() {
                log::info!("Crawler cancelled cooperatively.");
                return;
            }

            duty_guard.checkpoint_sync();

            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let path = entry.path();
            let path_str = normalize_index_path(path);
            remove_from_path_set(&mut db_paths, path);

            let metadata = match fs::metadata(path) {
                Ok(m) => m,
                Err(_) => continue,
            };

            let is_dir = metadata.is_dir();
            let size = metadata.len() as i64;
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            // Incremental check: compare with DB
            if let Ok(Some((db_mtime, db_size))) = db.get_file_metadata(&path_str) {
                if db_mtime == mtime && db_size == size {
                    let ext = path
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    // If it's a rich text document and has non-zero size, check if we already extracted content
                    if size > 0 && matches!(ext.as_str(), "pdf" | "docx" | "pptx") {
                        if let Ok(Some(content)) = db.get_file_content(&path_str) {
                            if !content.trim().is_empty() {
                                continue;
                            }
                        }
                    } else {
                        continue;
                    }
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
                    "xlsx" | "xls" | "ods" => extract_excel_metadata(path),
                    "csv" => extract_csv_headers(path),
                    "pdf" | "docx" | "pptx" => {
                        match crate::rag::parsers::parse_document(path) {
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
                            Err(e) => {
                                log::debug!("Failed to parse {} for indexing: {}", path.display(), e);
                                None
                            }
                        }
                    }
                    "txt" | "md" => read_first_10kb(path),
                    _ => None,
                };
            }

            let name_tokens = tokenize_filename(&filename);
            let location = parent_location(path, 2);
            if let Err(e) = db.insert_or_update(
                &path_str,
                &filename,
                &name_tokens,
                &location,
                mtime,
                size,
                is_dir,
                content.as_deref(),
            ) {
                log::error!("Failed to index {}: {}", path_str, e);
            } else {
                // Remove legacy spellings so we don't keep duplicate rows.
                let legacy = path.to_string_lossy().into_owned();
                if legacy != path_str {
                    db.delete(&legacy).ok();
                }
            }
        }
    }

    // Sync deletions: paths still in db_paths were not seen during this crawl.
    for removed_path in db_paths {
        if cancel_token.is_cancelled() {
            return;
        }
        duty_guard.checkpoint_sync();

        if let Err(e) = db.delete(&removed_path) {
            log::error!("Failed to delete stale index record for {}: {}", removed_path, e);
        }
    }

    log::info!("Background ambient crawl completed successfully.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_splits_camel_case() {
        assert_eq!(tokenize_filename("TaxReturn_2023.pdf"), "tax return 2023 pdf");
    }
}
