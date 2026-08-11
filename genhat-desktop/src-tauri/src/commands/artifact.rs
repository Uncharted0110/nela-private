//! Tauri commands for MCP artifact generation.
//!
//! Exposes the MCP coordinator and intent resolver to the frontend.

use crate::intent::{IntentDecision, IntentResolverState};
use crate::mcp::types::PipelineStage;
use crate::grammar::schema::HtmlPlan;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

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

/// Generate a spreadsheet artifact from a plan object (tolerant of minor schema drift).
#[tauri::command]
pub async fn generate_spreadsheet(
    plan: serde_json::Value,
    app: AppHandle,
) -> Result<ArtifactResult, String> {
    emit_stage(&app, PipelineStage::WritingCode);

    let plan = crate::grammar::plan_normalize::parse_spreadsheet_plan(plan)?;
    let (path, warning) = crate::spreadsheet::write_spreadsheet_plan(plan)?;

    emit_stage(
        &app,
        PipelineStage::LivePreview {
            path: path.to_string_lossy().to_string(),
        },
    );

    Ok(ArtifactResult {
        path: path.to_string_lossy().to_string(),
        kind: "xlsx".to_string(),
        warning,
    })
}

/// Generate a presentation artifact from a plan object (tolerant of minor schema drift).
#[tauri::command]
pub async fn generate_presentation(
    plan: serde_json::Value,
    app: AppHandle,
) -> Result<ArtifactResult, String> {
    emit_stage(&app, PipelineStage::WritingCode);

    let prompt = plan
        .get("_prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut plan_value = plan;
    if let Some(obj) = plan_value.as_object_mut() {
        obj.remove("_prompt");
        obj.remove("_target_slides");
    }
    let plan = crate::grammar::plan_normalize::parse_presentation_plan(plan_value, &prompt)?;
    let path = crate::presentation::write_presentation_plan(plan)?;

    emit_stage(
        &app,
        PipelineStage::LivePreview {
            path: path.to_string_lossy().to_string(),
        },
    );

    Ok(ArtifactResult {
        path: path.to_string_lossy().to_string(),
        kind: "html".to_string(),
        warning: None,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsePresentationDeckRequest {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPresentationDeck {
    pub theme: Option<String>,
    pub slides: Vec<serde_json::Value>,
    pub slide_count: usize,
    pub is_nela_deck: bool,
}

/// Parse a NELA HTML slide deck (or native PPTX) into a compact plan (for edit flows).
#[tauri::command]
pub fn parse_presentation_deck(
    request: ParsePresentationDeckRequest,
) -> Result<ParsedPresentationDeck, String> {
    let lower = request.path.to_ascii_lowercase();
    let is_pptx = lower.ends_with(".pptx") || lower.ends_with(".ppt");
    let plan = crate::presentation::load_presentation_plan(&request.path)?;
    let is_nela_deck = if is_pptx {
        false
    } else {
        let html = std::fs::read_to_string(&request.path)
            .map_err(|e| format!("Failed to read presentation: {e}"))?;
        crate::presentation::is_nela_presentation_html(&html)
    };
    let slides: Vec<serde_json::Value> = plan
        .slides
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to serialize slides: {e}"))?;
    let slide_count = slides.len();
    Ok(ParsedPresentationDeck {
        theme: plan.theme,
        slides,
        slide_count,
        is_nela_deck,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPresentationDeckRequest {
    pub path: String,
    #[serde(default)]
    pub append_slides: Vec<crate::grammar::schema::PresentationSlide>,
    /// Zero-based index to insert new slides. When omitted, slides append at the end.
    #[serde(default)]
    pub insert_at: Option<usize>,
    #[serde(default)]
    pub replacement_plan: Option<serde_json::Value>,
    #[serde(default)]
    pub output_name: Option<String>,
}

/// Edit an existing NELA HTML deck (append slides or apply a full replacement plan).
#[tauri::command]
pub async fn edit_presentation_deck(
    request: EditPresentationDeckRequest,
    app: AppHandle,
) -> Result<ArtifactResult, String> {
    emit_stage(&app, PipelineStage::WritingCode);

    let out_path = if let Some(plan_value) = request.replacement_plan {
        let plan: crate::grammar::schema::PresentationPlan =
            serde_json::from_value(plan_value)
                .map_err(|e| format!("Invalid replacement plan: {e}"))?;
        crate::presentation::rewrite_deck_from_plan(
            &request.path,
            plan,
            request.output_name,
        )?
    } else if !request.append_slides.is_empty() {
        let html = std::fs::read_to_string(&request.path)
            .map_err(|e| format!("Failed to read presentation: {e}"))?;
        let existing = crate::presentation::parse_presentation_html(&html)?;
        let insert_at = request
            .insert_at
            .unwrap_or(existing.slides.len())
            .min(existing.slides.len());
        crate::presentation::insert_slides_to_deck(
            &request.path,
            request.append_slides,
            insert_at,
            request.output_name,
        )?
    } else {
        return Err("No slides to append and no replacement plan provided".to_string());
    };

    emit_stage(
        &app,
        PipelineStage::LivePreview {
            path: out_path.to_string_lossy().to_string(),
        },
    );

    Ok(ArtifactResult {
        path: out_path.to_string_lossy().to_string(),
        kind: "html".to_string(),
        warning: None,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPresentationOpsRequest {
    pub path: String,
    pub ops: Vec<crate::presentation::PresentationEditOp>,
    #[serde(default)]
    pub output_name: Option<String>,
}

/// Apply a surgical op list to a NELA HTML deck or native PPTX (writes a new HTML deck).
#[tauri::command]
pub async fn apply_presentation_ops(
    request: ApplyPresentationOpsRequest,
    app: AppHandle,
) -> Result<ArtifactResult, String> {
    emit_stage(&app, PipelineStage::WritingCode);

    let out_path = crate::presentation::apply_ops_to_deck(
        &request.path,
        request.ops,
        request.output_name,
    )?;

    emit_stage(
        &app,
        PipelineStage::LivePreview {
            path: out_path.to_string_lossy().to_string(),
        },
    );

    Ok(ArtifactResult {
        path: out_path.to_string_lossy().to_string(),
        kind: "html".to_string(),
        warning: None,
    })
}

/// Generate an HTML page artifact from a `HtmlPlan`.
///
/// Renders in-process (no MCP sidecar) so structured section plans always use
/// the current renderer — avoids stale sidecar binaries expecting legacy `html`.
#[tauri::command]
pub async fn generate_html(
    plan: HtmlPlan,
    app: AppHandle,
) -> Result<ArtifactResult, String> {
    emit_stage(&app, PipelineStage::WritingCode);

    let path = crate::html::write_html_plan(plan)?;

    emit_stage(
        &app,
        PipelineStage::LivePreview {
            path: path.to_string_lossy().to_string(),
        },
    );

    Ok(ArtifactResult {
        path: path.to_string_lossy().to_string(),
        kind: "html".to_string(),
        warning: None,
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
        "html_synthesis" => Ok(crate::grammar::HTML_PAGE_PLAN_GBNF.to_string()),
        other => Err(format!("Unknown schema_id: {other}")),
    }
}

/// Parse spreadsheet file cells/rows using calamine or csv parsing library.
///
/// When `max_rows` is set, only the header plus that many data rows are returned
/// (keeps memory bounded for large workbooks during edit flows).
#[tauri::command]
pub fn parse_spreadsheet_data(
    path: String,
    max_rows: Option<usize>,
) -> Result<serde_json::Value, String> {
    let row_cap = max_rows.filter(|n| *n > 0);

    if path.ends_with(".csv") {
        let mut reader = csv::Reader::from_path(&path)
            .map_err(|e| format!("Failed to open CSV: {e}"))?;
        let mut rows = Vec::new();
        let mut data_rows = 0usize;

        if let Ok(headers) = reader.headers() {
            let header_row: Vec<String> = headers.iter().map(|s| s.to_string()).collect();
            if !header_row.is_empty() {
                rows.push(header_row);
            }
        }

        for result in reader.records() {
            if let Some(cap) = row_cap {
                if data_rows >= cap {
                    break;
                }
            }
            let record = result.map_err(|e| format!("Failed to read CSV record: {e}"))?;
            let row_data: Vec<String> = record.iter().map(|s| s.to_string()).collect();
            rows.push(row_data);
            data_rows += 1;
        }
        return Ok(serde_json::json!({
            "sheet_name": "CSV",
            "rows": rows,
            "truncated": row_cap.is_some_and(|cap| data_rows >= cap),
        }));
    }

    use calamine::{Reader, open_workbook_auto};
    let mut workbook = open_workbook_auto(&path)
        .map_err(|e| format!("Failed to open spreadsheet: {e}"))?;

    let sheet_names = workbook.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return Err("No sheets found in workbook".to_string());
    }

    let mut sheets_out = Vec::new();
    for sheet_name in &sheet_names {
        let range = match workbook.worksheet_range(sheet_name) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("Failed to read sheet '{sheet_name}': {e}");
                continue;
            }
        };

        let mut rows = Vec::new();
        let mut data_rows = 0usize;
        for row in range.rows() {
            if rows.is_empty() {
                let mut row_data = Vec::new();
                for cell in row {
                    row_data.push(cell_to_string(cell));
                }
                rows.push(row_data);
                continue;
            }
            if let Some(cap) = row_cap {
                if data_rows >= cap {
                    break;
                }
            }
            let mut row_data = Vec::new();
            for cell in row {
                row_data.push(cell_to_string(cell));
            }
            rows.push(row_data);
            data_rows += 1;
        }

        sheets_out.push(serde_json::json!({
            "sheet_name": sheet_name,
            "rows": rows,
            "truncated": row_cap.is_some_and(|cap| data_rows >= cap),
        }));
    }

    if sheets_out.is_empty() {
        return Err("No readable sheets found in workbook".to_string());
    }

    let first = &sheets_out[0];
    Ok(serde_json::json!({
        "sheet_name": first.get("sheet_name").cloned().unwrap_or(serde_json::Value::String("Sheet1".into())),
        "rows": first.get("rows").cloned().unwrap_or(serde_json::Value::Array(vec![])),
        "truncated": first.get("truncated").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "sheets": sheets_out,
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

/// Write full text contents as a **new** artifact copy next to the source naming.
/// Used for deterministic freeform HTML deck edits (no LLM / no diff).
#[tauri::command]
pub async fn write_artifact_copy(
    path: String,
    contents: String,
    output_name: Option<String>,
) -> Result<String, String> {
    let stem = output_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| crate::presentation::edited_output_name(&path));
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("html");
    let out_dir = crate::paths::artifacts_dir();
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Create output dir: {e}"))?;
    let out_path = crate::paths::unique_artifact_path(&out_dir, &stem, ext);
    std::fs::write(&out_path, contents.as_bytes())
        .map_err(|e| format!("Failed to write artifact copy: {e}"))?;
    Ok(out_path.to_string_lossy().to_string())
}

/// Apply a unified diff patch to a file, writing a **new** artifact copy.
/// The original path is left unchanged. Returns the new file path.
#[tauri::command]
pub async fn apply_diff_patch(path: String, patch: String) -> Result<String, String> {
    let original = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {e}"))?;

    let patched = apply_patch(&original, &patch)?;

    if patched == original {
        return Err(
            "Patch did not change the file — try rephrasing the edit or use a more specific instruction"
                .to_string(),
        );
    }

    let stem = crate::presentation::edited_output_name(&path);
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("html");
    let out_dir = crate::paths::artifacts_dir();
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Create output dir: {e}"))?;
    let out_path = crate::paths::unique_artifact_path(&out_dir, &stem, ext);

    std::fs::write(&out_path, &patched)
        .map_err(|e| format!("Failed to write patched file: {e}"))?;

    Ok(out_path.to_string_lossy().to_string())
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

