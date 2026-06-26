//! Tauri commands for the Ambient FTS5 Indexer.

use crate::indexer::rank::{search_ranked, RankedFileRecord};
use crate::indexer::AmbientIndexerState;
use crate::commands::inference::TaskRouterState;
use tauri::State;

/// Search the ambient files index — BM25 candidates reranked by the cross-encoder.
#[tauri::command]
pub async fn search_ambient_files(
    query: String,
    indexer: State<'_, AmbientIndexerState>,
    router: State<'_, TaskRouterState>,
) -> Result<Vec<RankedFileRecord>, String> {
    search_ranked(&indexer.0.db, &router.0, &query).await
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
