//! Tauri IPC for the structural knowledge-graph engine (two-pass indexing).

use crate::doc_graph::engine::{
    query_kb, run_incremental_sync, BackgroundIndexStatus, IndexingProgress, PipelineReport,
};
use crate::doc_graph::graph::schema::KnowledgeBaseStats;
use crate::doc_graph::state::DocGraphState;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn start_indexing_directory(
    app: AppHandle,
    state: State<'_, DocGraphState>,
    path: String,
) -> Result<PipelineReport, String> {
    let engine = state.0.clone();
    if !engine.try_begin_indexing() {
        return Err("Indexing already in progress".into());
    }

    let root = PathBuf::from(path);
    if !root.is_dir() {
        engine.end_indexing();
        return Err(format!("Not a directory: {}", root.display()));
    }

    let app_for_pass1 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let on_progress: crate::doc_graph::engine::ProgressCallback = Arc::new({
            let app = app_for_pass1.clone();
            move |progress: IndexingProgress| {
                let _ = app.emit("indexing-progress", progress);
            }
        });

        let embedder = engine.embedder()?;
        // Incremental sync: only new/changed files under `root` are re-indexed.
        let report = {
            let mut kb = engine.kb.write();
            run_incremental_sync(
                &root,
                &engine.data_dir,
                &mut kb,
                &engine.index,
                &embedder,
                None,
                Some(on_progress.clone()),
            )?
        };
        engine.end_indexing();

        let deferred: Vec<PathBuf> = report
            .deferred_files
            .iter()
            .map(PathBuf::from)
            .collect();
        if !deferred.is_empty() {
            let on_bg = Arc::new({
                let app = app_for_pass1.clone();
                move |progress: IndexingProgress| {
                    let _ = app.emit("indexing-progress", progress.clone());
                    let _ = app.emit("indexing-pass2-status", progress);
                }
            });
            engine.spawn_pass2(deferred, Some(on_bg));
        }

        Ok::<PipelineReport, crate::doc_graph::errors::EngineError>(report)
    })
    .await
    .map_err(|e| format!("indexing task join error: {e}"))?;

    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn query_knowledge_base(
    state: State<'_, DocGraphState>,
    query: String,
    top_k: Option<usize>,
) -> Result<String, String> {
    let engine = state.0.clone();
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("Query must not be empty".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let embedder = engine.embedder().map_err(|e| e.to_string())?;
        let kb = engine.kb.read();
        query_kb(&q, &kb, &engine.index, &embedder, top_k).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("query task join error: {e}"))?
}

#[tauri::command]
pub async fn get_knowledge_base_stats(
    state: State<'_, DocGraphState>,
) -> Result<KnowledgeBaseStats, String> {
    Ok(state.0.stats())
}

#[tauri::command]
pub async fn get_background_index_status(
    state: State<'_, DocGraphState>,
) -> Result<BackgroundIndexStatus, String> {
    Ok(state.0.background_status())
}

#[tauri::command]
pub async fn clear_knowledge_base(state: State<'_, DocGraphState>) -> Result<(), String> {
    state.0.clear().map_err(|e| e.to_string())
}
