//! Tauri commands for the Ambient FTS5 Indexer.

use std::path::Path;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use crate::commands::inference::TaskRouterState;
use crate::indexer::disk::{find_on_disk, is_allowed_existing_path};
use crate::indexer::query::parse_search_hints;
use crate::indexer::rank::{search_ranked, RankedFileRecord};
use crate::indexer::AmbientIndexerState;
use tauri::State;

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn ranked_from_path(path_key: &str, score: f32) -> Option<RankedFileRecord> {
    let path = Path::new(path_key);
    let metadata = std::fs::metadata(path).ok()?;
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    Some(RankedFileRecord {
        path: path_key.to_string(),
        filename,
        is_dir: metadata.is_dir(),
        size: metadata.len() as i64,
        mtime,
        score,
        snippet: String::new(),
    })
}

/// Search the ambient files index — BM25 candidates reranked by the cross-encoder.
/// Falls back to on-disk filename search when the index has not caught up yet.
#[tauri::command]
pub async fn search_ambient_files(
    query: String,
    indexer: State<'_, AmbientIndexerState>,
    router: State<'_, TaskRouterState>,
) -> Result<Vec<RankedFileRecord>, String> {
    let hints = parse_search_hints(&query);
    let home = home_dir();
    let workspaces: Vec<PathBuf> = Vec::new();

    if let Some(ref abs) = hints.absolute_path {
        if is_allowed_existing_path(&home, &workspaces, abs) {
            if let Some(hit) = ranked_from_path(abs, 1.0) {
                log::info!("ambient search: direct path hit {}", abs);
                return Ok(vec![hit]);
            }
        }
    }

    let mut results = search_ranked(&indexer.0.db, &router.0, &query).await?;
    if results.is_empty() {
        let disk_hits = find_on_disk(&home, &workspaces, &hints, 10);
        results = disk_hits
            .into_iter()
            .filter_map(|c| ranked_from_path(&c.path, 0.88))
            .collect();
        if !results.is_empty() {
            log::info!(
                "ambient search: on-disk fallback returned {} hit(s) for '{}'",
                results.len(),
                query
            );
        }
    }

    Ok(results)
}

/// Retrieve the indexed cache content (tokens/headers) of a system file.
#[tauri::command]
pub async fn get_ambient_file_content(
    path: String,
    state: State<'_, AmbientIndexerState>,
) -> Result<Option<String>, String> {
    if !crate::indexer::paths::index_path_exists(&path) {
        crate::indexer::paths::delete_index_paths(&state.0.db, std::path::Path::new(&path));
        return Ok(None);
    }
    state.0.db.get_file_content(&path)
}
