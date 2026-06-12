//! mcp-server-excel — MCP tool sidecar for spreadsheet synthesis.
//!
//! Reads one JSON-RPC 2.0 request from stdin, generates an `.xlsx` file using
//! `rust_xlsxwriter`, and writes one JSON-RPC 2.0 response to stdout, then exits.
//!
//! This binary is the "native computes" half of the "SLM routes, native computes"
//! architecture (revamp.md §1.1). It never calls any LLM.
//!
//! ## Protocol
//! ```text
//! stdin:  {"jsonrpc":"2.0","id":1,"method":"tools/call","params":<SpreadsheetPlan>}\n
//! stdout: {"jsonrpc":"2.0","id":1,"result":{"path":"...","kind":"xlsx"}}\n
//!     or: {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"..."}}\n
//! ```

use std::collections::HashMap;
use std::io::{self, BufRead};
use std::path::PathBuf;

use rust_xlsxwriter::{Format, Workbook, XlsxError};
use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// Wire types (duplicated from app_lib to keep this binary self-contained)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: u64,
    params: SpreadsheetPlan,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<ToolResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct ToolResult {
    path: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Spreadsheet plan types (must mirror grammar::schema::SpreadsheetPlan)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct SpreadsheetPlan {
    ops: Vec<SpreadsheetOp>,
    source_rows: Option<Vec<Vec<String>>>,
    headers: Option<Vec<String>>,
    output_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op")]
enum SpreadsheetOp {
    #[serde(rename = "SUM_COLUMN")]
    SumColumn { col: String, label: Option<String> },
    #[serde(rename = "AVERAGE_BY_GROUP")]
    AverageByGroup { value_col: String, group_col: String },
    #[serde(rename = "PIVOT")]
    Pivot { row_col: String, col_col: String, value_col: String },
    #[serde(rename = "SORT_DESC")]
    SortDesc { col: String },
    #[serde(rename = "SORT_ASC")]
    SortAsc { col: String },
    #[serde(rename = "FILTER_ROWS")]
    FilterRows { col: String, value: String },
    #[serde(rename = "COUNT_BY_GROUP")]
    CountByGroup { group_col: String },
    #[serde(rename = "ADD_COLUMN")]
    AddColumn { name: String, formula: String },
    #[serde(rename = "WRITE_DATA")]
    WriteData { headers: Vec<String>, rows: Vec<Vec<String>> },
    #[serde(rename = "RENAME_SHEET")]
    RenameSheet { name: String },
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

fn main() {
    let stdin = io::stdin();
    let mut line = String::new();
    if let Err(e) = stdin.lock().read_line(&mut line) {
        write_error(0, -32700, &format!("Failed to read stdin: {e}"));
        std::process::exit(1);
    }

    let line = line.trim();
    if line.is_empty() {
        write_error(0, -32700, "Empty request");
        std::process::exit(1);
    }

    // Parse as a generic Value first to extract id, then re-parse params.
    let raw: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            write_error(0, -32700, &format!("JSON parse error: {e}"));
            std::process::exit(1);
        }
    };

    let id = raw["id"].as_u64().unwrap_or(0);

    let plan: SpreadsheetPlan = match serde_json::from_value(raw["params"].clone()) {
        Ok(p) => p,
        Err(e) => {
            write_error(id, -32602, &format!("Invalid plan: {e}"));
            std::process::exit(1);
        }
    };

    match generate_xlsx(plan) {
        Ok((path, warning)) => {
            let resp = JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(ToolResult {
                    path: path.to_string_lossy().to_string(),
                    kind: "xlsx".to_string(),
                    warning,
                }),
                error: None,
            };
            println!("{}", serde_json::to_string(&resp).unwrap());
        }
        Err(e) => {
            write_error(id, -32603, &e);
            std::process::exit(1);
        }
    }
}

fn write_error(id: u64, code: i32, message: &str) {
    let resp = JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: None,
        error: Some(JsonRpcError {
            code,
            message: message.to_string(),
        }),
    };
    eprintln!("mcp-server-excel error: {message}");
    println!("{}", serde_json::to_string(&resp).unwrap_or_default());
}

// ─────────────────────────────────────────────────────────────────────────────
// XLSX generation
// ─────────────────────────────────────────────────────────────────────────────

fn generate_xlsx(plan: SpreadsheetPlan) -> Result<(PathBuf, Option<String>), String> {
    // ── Resolve output path first ────────────────────────────────────────────
    let output_name = plan.output_name.as_deref().unwrap_or("nela_artifact");
    let out_dir = std::env::temp_dir().join("nela_artifacts");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Create output dir: {e}"))?;
    let path = out_dir.join(format!("{output_name}.xlsx"));

    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();

    let header_fmt = Format::new().set_bold();

    // ── Write source data ────────────────────────────────────────────────────
    let headers = plan.headers.as_deref().unwrap_or(&[]);
    let source_rows = plan.source_rows.as_deref().unwrap_or(&[]);

    // Build column-index map from headers.
    let col_index: HashMap<&str, usize> = headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.as_str(), i))
        .collect();

    // Write headers.
    for (col_idx, header) in headers.iter().enumerate() {
        worksheet
            .write_with_format(0, col_idx as u16, header.as_str(), &header_fmt)
            .map_err(|e| format!("Write header: {e}"))?;
    }

    // Write data rows.
    for (row_idx, row) in source_rows.iter().enumerate() {
        for (col_idx, cell) in row.iter().enumerate() {
            // Try numeric, fall back to string.
            if let Ok(n) = cell.parse::<f64>() {
                worksheet
                    .write(row_idx as u32 + 1, col_idx as u16, n)
                    .map_err(|e| format!("Write cell: {e}"))?;
            } else {
                worksheet
                    .write(row_idx as u32 + 1, col_idx as u16, cell.as_str())
                    .map_err(|e| format!("Write cell: {e}"))?;
            }
        }
    }

    let mut warnings: Vec<String> = Vec::new();

    // ── Apply operations ─────────────────────────────────────────────────────
    // Operations that produce summary rows are appended after the data.
    let mut next_row = source_rows.len() as u32 + 2; // +1 header, +1 blank gap

    for op in &plan.ops {
        match op {
            SpreadsheetOp::SumColumn { col, label } => {
                let col_letter = excel_col_letter(col_index.get(col.as_str()).copied());
                let data_rows = source_rows.len() as u32;

                if let Some(&ci) = col_index.get(col.as_str()) {
                    // Write label in column A, formula in the target column.
                    let default_label = format!("SUM({col})");
                    let label_text = label.as_deref().unwrap_or(&default_label);
                    worksheet
                        .write(next_row, 0, label_text)
                        .map_err(|e| format!("Write sum label: {e}"))?;

                    let formula = format!("=SUM({col_letter}2:{col_letter}{data_rows}+1)");
                    worksheet
                        .write_formula(next_row, ci as u16, &*formula)
                        .map_err(|e| format!("Write sum formula: {e}"))?;

                    next_row += 1;
                } else {
                    warnings.push(format!("SUM_COLUMN: column '{col}' not found in headers"));
                }
            }

            SpreadsheetOp::RenameSheet { name } => {
                worksheet
                    .set_name(name)
                    .map_err(|e| format!("Rename sheet: {e}"))?;
            }

            // Other operations are noted as warnings (full implementation requires
            // in-memory row manipulation beyond the scope of this initial sidecar).
            SpreadsheetOp::AverageByGroup { value_col, group_col } => {
                warnings.push(format!(
                    "AVERAGE_BY_GROUP({value_col} by {group_col}): simplified — use pivot tables for full grouping"
                ));
            }
            SpreadsheetOp::SortDesc { col } | SpreadsheetOp::SortAsc { col } => {
                warnings.push(format!(
                    "SORT on '{col}': xlsxwriter does not support in-place sort; sort data before ingestion"
                ));
            }
            SpreadsheetOp::CountByGroup { group_col } => {
                warnings.push(format!(
                    "COUNT_BY_GROUP({group_col}): COUNTIF formulas not yet auto-generated; add manually"
                ));
            }
            SpreadsheetOp::FilterRows { col, value } => {
                warnings.push(format!(
                    "FILTER_ROWS({col}={value}): AutoFilter applied; user must activate filter"
                ));
                // Apply autofilter as a best-effort hint.
                if !headers.is_empty() && !source_rows.is_empty() {
                    let _ = worksheet.autofilter(
                        0,
                        0,
                        source_rows.len() as u32,
                        (headers.len() - 1) as u16,
                    );
                }
            }
            SpreadsheetOp::Pivot { .. } => {
                warnings.push(
                    "PIVOT: pivot tables require VBA/Excel formulas; data written as-is".to_string(),
                );
            }
            SpreadsheetOp::AddColumn { name, formula } => {
                warnings.push(format!(
                    "ADD_COLUMN({name}={formula}): column appended as a note; formula not auto-wired"
                ));
                let new_col_idx = headers.len() as u16;
                worksheet
                    .write_with_format(0, new_col_idx, name.as_str(), &header_fmt)
                    .map_err(|e| format!("Write ADD_COLUMN header: {e}"))?;
            }
            SpreadsheetOp::WriteData { headers: wd_headers, rows: wd_rows } => {
                // Write headers from WRITE_DATA op
                for (col_idx, header) in wd_headers.iter().enumerate() {
                    worksheet
                        .write_with_format(next_row, col_idx as u16, header.as_str(), &header_fmt)
                        .map_err(|e| format!("Write WRITE_DATA header: {e}"))?;
                }
                next_row += 1;
                // Write data rows
                for row in wd_rows {
                    for (col_idx, cell) in row.iter().enumerate() {
                        if let Ok(n) = cell.parse::<f64>() {
                            worksheet
                                .write(next_row, col_idx as u16, n)
                                .map_err(|e| format!("Write WRITE_DATA cell: {e}"))?;
                        } else {
                            worksheet
                                .write(next_row, col_idx as u16, cell.as_str())
                                .map_err(|e| format!("Write WRITE_DATA cell: {e}"))?;
                        }
                    }
                    next_row += 1;
                }
            }
        }
    }

    // ── Save the workbook ────────────────────────────────────────────────────
    workbook
        .save(&path)
        .map_err(|e| format!("Save workbook: {e}"))?;

    let warning = if warnings.is_empty() {
        None
    } else {
        Some(warnings.join("; "))
    };

    Ok((path, warning))
}

/// Return the Excel column letter (A, B, …, Z, AA, …) for a zero-based column index.
fn excel_col_letter(idx: Option<usize>) -> String {
    let mut n = idx.unwrap_or(0) + 1; // 1-based
    let mut result = String::new();
    while n > 0 {
        n -= 1;
        result.insert(0, (b'A' + (n % 26) as u8) as char);
        n /= 26;
    }
    result
}
