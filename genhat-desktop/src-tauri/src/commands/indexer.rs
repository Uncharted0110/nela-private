//! Tauri commands for the Ambient FTS5 Indexer.

use crate::indexer::db::FileRecord;
use crate::indexer::AmbientIndexerState;
use tauri::State;

/// Search the ambient files index.
#[tauri::command]
pub async fn search_ambient_files(
    query: String,
    state: State<'_, AmbientIndexerState>,
) -> Result<Vec<FileRecord>, String> {
    state.0.search(&query)
}

/// Retrieve the indexed cache content (tokens/headers) of a system file.
#[tauri::command]
pub async fn get_ambient_file_content(
    path: String,
    state: State<'_, AmbientIndexerState>,
) -> Result<Option<String>, String> {
    state.0.db.get_file_content(&path)
}
