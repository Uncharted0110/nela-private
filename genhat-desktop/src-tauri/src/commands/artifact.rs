//! Tauri commands for MCP artifact generation.
//!
//! Exposes the MCP coordinator and intent resolver to the frontend.

use crate::intent::{IntentDecision, IntentResolverState};
use crate::mcp::coordinator::McpCoordinatorState;
use crate::mcp::types::{PipelineStage, ToolCall};
use crate::grammar::schema::{SpreadsheetPlan, PresentationPlan, HtmlPlan};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State, Manager};

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveIntentRequest {
    pub prompt: String,
    #[serde(default)]
    pub extra: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactResult {
    pub path: String,
    pub kind: String,
    pub warning: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve the macro-intent of a prompt without executing anything.
///
/// Used by the frontend to show the appropriate mode UI before invoking
/// any model or tool.
#[tauri::command]
pub async fn resolve_intent(
    request: ResolveIntentRequest,
    resolver: State<'_, IntentResolverState>,
) -> Result<IntentDecision, String> {
    Ok(resolver
        .0
        .resolve(&request.prompt, &request.extra)
        .await)
}

/// Generate a spreadsheet artifact from a `SpreadsheetPlan`.
///
/// Emits `pipeline-stage` events to the frontend during execution so the
/// `ProgressSlate` component can show live progress.
#[tauri::command]
pub async fn generate_spreadsheet(
    plan: SpreadsheetPlan,
    app: AppHandle,
    coordinator: State<'_, McpCoordinatorState>,
) -> Result<ArtifactResult, String> {
    emit_stage(&app, PipelineStage::WritingCode);

    let app_cache_dir = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir());
    let call = ToolCall::Excel(plan);
    let result = coordinator.0.invoke(call, &app_cache_dir)?;

    emit_stage(
        &app,
        PipelineStage::LivePreview {
            path: result.path.clone(),
        },
    );

    Ok(ArtifactResult {
        path: result.path,
        kind: result.kind,
        warning: result.warning,
    })
}

/// Generate a presentation artifact from a `PresentationPlan`.
#[tauri::command]
pub async fn generate_presentation(
    plan: PresentationPlan,
    app: AppHandle,
    coordinator: State<'_, McpCoordinatorState>,
) -> Result<ArtifactResult, String> {
    emit_stage(&app, PipelineStage::WritingCode);

    let app_cache_dir = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir());
    let call = ToolCall::Presentation(plan);
    let result = coordinator.0.invoke(call, &app_cache_dir)?;

    emit_stage(
        &app,
        PipelineStage::LivePreview {
            path: result.path.clone(),
        },
    );

    Ok(ArtifactResult {
        path: result.path,
        kind: result.kind,
        warning: result.warning,
    })
}

/// Generate an HTML page artifact from a `HtmlPlan`.
#[tauri::command]
pub async fn generate_html(
    plan: HtmlPlan,
    app: AppHandle,
    coordinator: State<'_, McpCoordinatorState>,
) -> Result<ArtifactResult, String> {
    emit_stage(&app, PipelineStage::WritingCode);

    let app_cache_dir = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir());
    let call = ToolCall::Html(plan);
    let result = coordinator.0.invoke(call, &app_cache_dir)?;

    emit_stage(
        &app,
        PipelineStage::LivePreview {
            path: result.path.clone(),
        },
    );

    Ok(ArtifactResult {
        path: result.path,
        kind: result.kind,
        warning: result.warning,
    })
}

/// Write raw bytes (base64-encoded by the frontend) to an absolute path.
///
/// Used by the presentation exporter to persist generated PDF/PPTX files the
/// frontend builds in-memory (via jsPDF / pptxgenjs) to a user-chosen path.
#[tauri::command]
pub fn save_binary_file(path: String, contents_base64: String) -> Result<(), String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    let bytes = STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(|e| format!("Failed to decode base64 payload: {e}"))?;

    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory '{}': {e}", parent.display()))?;
        }
    }

    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write file '{path}': {e}"))?;
    Ok(())
}

/// Get the current governor state (battery, thread count, thermal pressure).
#[tauri::command]
pub fn get_governor_state(
    governor: State<'_, crate::governor::GovernorState>,
) -> serde_json::Value {
    serde_json::json!({
        "on_battery": governor.0.on_battery(),
        "thermal_pressure": governor.0.thermal_pressure(),
        "inference_threads": governor.0.inference_threads(),
    })
}

/// Get the GBNF grammar for a specific schema/manifest ID.
#[tauri::command]
pub fn get_schema_grammar(schema_id: String) -> Result<String, String> {
    match schema_id.as_str() {
        "spreadsheet_synthesis" => Ok(crate::grammar::SPREADSHEET_PLAN_GBNF.to_string()),
        "presentation_synthesis" => Ok(crate::grammar::PRESENTATION_PLAN_GBNF.to_string()),
        "html_synthesis" => Ok(crate::grammar::HTML_PLAN_GBNF.to_string()),
        other => Err(format!("Unknown schema_id: {other}")),
    }
}

/// Parse spreadsheet file cells/rows using calamine or csv parsing library.
#[tauri::command]
pub fn parse_spreadsheet_data(path: String) -> Result<serde_json::Value, String> {
    if path.ends_with(".csv") {
        let mut reader = csv::Reader::from_path(&path)
            .map_err(|e| format!("Failed to open CSV: {e}"))?;
        let mut rows = Vec::new();
        
        // Read headers
        if let Ok(headers) = reader.headers() {
            let header_row: Vec<String> = headers.iter().map(|s| s.to_string()).collect();
            if !header_row.is_empty() {
                rows.push(header_row);
            }
        }
        
        for result in reader.records() {
            let record = result.map_err(|e| format!("Failed to read CSV record: {e}"))?;
            let row_data: Vec<String> = record.iter().map(|s| s.to_string()).collect();
            rows.push(row_data);
        }
        return Ok(serde_json::json!({
            "sheet_name": "CSV",
            "rows": rows,
        }));
    }

    use calamine::{Reader, open_workbook_auto};
    let mut workbook = open_workbook_auto(&path)
        .map_err(|e| format!("Failed to open spreadsheet: {e}"))?;

    let sheet_name = workbook.sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| "No sheets found in workbook".to_string())?;

    let range = workbook.worksheet_range(&sheet_name)
        .map_err(|e| format!("Failed to read sheet range: {e}"))?;

    let mut rows = Vec::new();
    for row in range.rows() {
        let mut row_data = Vec::new();
        for cell in row {
            row_data.push(cell_to_string(cell));
        }
        rows.push(row_data);
    }

    Ok(serde_json::json!({
        "sheet_name": sheet_name,
        "rows": rows,
    }))
}


// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn emit_stage(app: &AppHandle, stage: PipelineStage) {
    if let Err(e) = app.emit("pipeline-stage", &stage) {
        log::debug!("Failed to emit pipeline-stage event: {e}");
    }
}

/// Apply a unified diff patch to a file.
#[tauri::command]
pub async fn apply_diff_patch(path: String, patch: String) -> Result<String, String> {
    let original = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {e}"))?;

    let patched = apply_patch(&original, &patch)?;

    std::fs::write(&path, &patched)
        .map_err(|e| format!("Failed to write patched file: {e}"))?;

    Ok(patched)
}

fn apply_patch(original: &str, patch: &str) -> Result<String, String> {
    let mut original_lines: Vec<&str> = original.lines().collect();
    let mut patch_lines = patch.lines().peekable();
    let mut offset: i32 = 0;

    while let Some(line) = patch_lines.next() {
        if line.starts_with("@@ ") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 3 {
                continue;
            }

            let old_range = parts[1].strip_prefix('-').unwrap_or(parts[1]);
            let old_parts: Vec<&str> = old_range.split(',').collect();
            let old_start = old_parts[0].parse::<usize>().map_err(|e| e.to_string())?;
            let old_len = if old_parts.len() > 1 {
                old_parts[1].parse::<usize>().map_err(|e| e.to_string())?
            } else {
                1
            };

            let mut expected_old = Vec::new();
            let mut new_lines = Vec::new();

            while let Some(&hunk_line) = patch_lines.peek() {
                if hunk_line.starts_with("@@") || hunk_line.starts_with("diff ") {
                    break;
                }
                patch_lines.next();

                if hunk_line.starts_with(' ') {
                    let content = &hunk_line[1..];
                    expected_old.push(content);
                    new_lines.push(content);
                } else if hunk_line.starts_with('-') {
                    expected_old.push(&hunk_line[1..]);
                } else if hunk_line.starts_with('+') {
                    new_lines.push(&hunk_line[1..]);
                }
            }

            let start_idx = (old_start as i32 - 1 + offset) as usize;
            if start_idx + old_len > original_lines.len() {
                return Err(format!(
                    "Patch range out of bounds: start={}, len={}, original={}",
                    start_idx, old_len, original_lines.len()
                ));
            }

            original_lines.splice(start_idx..(start_idx + old_len), new_lines.clone());
            offset += new_lines.len() as i32 - old_len as i32;
        }
    }

    Ok(original_lines.join("\n"))
}

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

