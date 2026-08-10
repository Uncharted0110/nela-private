//! Render spreadsheet artifacts to XLSX files.

use std::collections::HashMap;
use std::path::PathBuf;

use rust_xlsxwriter::{Chart, ChartType, Color, Format, FormatBorder, Url, Workbook, Worksheet};

use crate::grammar::schema::{SpreadsheetOp, SpreadsheetPlan};

// ─────────────────────────────────────────────────────────────────────────────
// XLSX generation
// ─────────────────────────────────────────────────────────────────────────────

pub fn write_spreadsheet_plan(plan: SpreadsheetPlan) -> Result<(PathBuf, Option<String>), String> {
    // ── Resolve output path first ────────────────────────────────────────────
    let output_name = plan.output_name.as_deref().unwrap_or("nela_artifact");
    let out_dir = crate::paths::artifacts_dir();
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Create output dir: {e}"))?;
    let path = crate::paths::unique_artifact_path(&out_dir, output_name, "xlsx");

    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();

    let header_fmt = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x2173_46)) // Excel-green header
        .set_border(FormatBorder::Thin)
        .set_border_color(Color::RGB(0x1B5E_38));

    let cell_fmt = Format::new()
        .set_border(FormatBorder::Thin)
        .set_border_color(Color::RGB(0xD0D0_D0));

    // Track working table so WRITE_DATA + ADD_CHART share the same columns.
    let mut working_headers: Vec<String> = plan.headers.clone().unwrap_or_default();
    let mut working_rows: Vec<Vec<String>> = plan.source_rows.clone().unwrap_or_default();

    // Build column-index map from headers.
    let mut col_index: HashMap<String, usize> = working_headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.clone(), i))
        .collect();

    // Write headers.
    for (col_idx, header) in working_headers.iter().enumerate() {
        worksheet
            .write_with_format(0, col_idx as u16, header.as_str(), &header_fmt)
            .map_err(|e| format!("Write header: {e}"))?;
    }

    // Write data rows.
    for (row_idx, row) in working_rows.iter().enumerate() {
        for (col_idx, cell) in row.iter().enumerate() {
            write_smart_cell(
                worksheet,
                row_idx as u32 + 1,
                col_idx as u16,
                cell,
                &cell_fmt,
            )?;
        }
    }

    let mut warnings: Vec<String> = Vec::new();

    // ── Apply operations ─────────────────────────────────────────────────────
    // Operations that produce summary rows are appended after the data.
    let mut next_row = working_rows.len() as u32 + 2; // +1 header, +1 blank gap
    let mut chart_slot: u16 = 0;

    for op in &plan.ops {
        match op {
            SpreadsheetOp::SumColumn { col, label } => {
                let col_letter = excel_col_letter(col_index.get(col.as_str()).copied());
                let data_rows = working_rows.len() as u32;

                if let Some(&ci) = col_index.get(col.as_str()) {
                    // Write label in column A, formula in the target column.
                    let default_label = format!("SUM({col})");
                    let lbl = label.as_deref().unwrap_or(&default_label);
                    worksheet
                        .write(next_row, 0, lbl)
                        .map_err(|e| format!("Write SUM label: {e}"))?;
                    let formula = format!("=SUM({col_letter}2:{col_letter}{})", data_rows + 1);
                    worksheet
                        .write_formula(next_row, ci as u16, formula.as_str())
                        .map_err(|e| format!("Write SUM formula: {e}"))?;

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

            SpreadsheetOp::AverageByGroup { value_col, group_col } => {
                warnings.push(format!(
                    "AVERAGE_BY_GROUP({value_col} by {group_col}): simplified — use ADD_CHART for visual grouping"
                ));
            }
            SpreadsheetOp::SortDesc { col } | SpreadsheetOp::SortAsc { col } => {
                warnings.push(format!(
                    "SORT on '{col}': xlsxwriter does not support in-place sort; sort data before ingestion"
                ));
            }
            SpreadsheetOp::CountByGroup { group_col } => {
                warnings.push(format!(
                    "COUNT_BY_GROUP({group_col}): prefer ADD_CHART with category_col for a visual dashboard"
                ));
            }
            SpreadsheetOp::FilterRows { col, value } => {
                warnings.push(format!(
                    "FILTER_ROWS({col}={value}): AutoFilter applied; user must activate filter"
                ));
                if !working_headers.is_empty() && !working_rows.is_empty() {
                    let _ = worksheet.autofilter(
                        0,
                        0,
                        working_rows.len() as u32,
                        (working_headers.len() - 1) as u16,
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
                let new_col_idx = working_headers.len() as u16;
                worksheet
                    .write_with_format(0, new_col_idx, name.as_str(), &header_fmt)
                    .map_err(|e| format!("Write ADD_COLUMN header: {e}"))?;
            }
            SpreadsheetOp::WriteData { headers: wd_headers, rows: wd_rows } => {
                for (col_idx, header) in wd_headers.iter().enumerate() {
                    worksheet
                        .write_with_format(next_row, col_idx as u16, header.as_str(), &header_fmt)
                        .map_err(|e| format!("Write WRITE_DATA header: {e}"))?;
                }
                next_row += 1;
                for row in wd_rows {
                    for (col_idx, cell) in row.iter().enumerate() {
                        write_smart_cell(worksheet, next_row, col_idx as u16, cell, &cell_fmt)?;
                    }
                    next_row += 1;
                }
                // Prefer WRITE_DATA as the working table when source was empty.
                if working_headers.is_empty() || working_rows.is_empty() {
                    working_headers = wd_headers.clone();
                    working_rows = wd_rows.clone();
                    col_index = working_headers
                        .iter()
                        .enumerate()
                        .map(|(i, h)| (h.clone(), i))
                        .collect();
                }
            }
            SpreadsheetOp::AddChart {
                chart_type,
                category_col,
                value_col,
                title,
            } => {
                match insert_dashboard_chart(
                    worksheet,
                    &header_fmt,
                    &cell_fmt,
                    &working_headers,
                    &working_rows,
                    chart_type,
                    category_col,
                    value_col.as_deref(),
                    title.as_deref(),
                    chart_slot,
                ) {
                    Ok(()) => chart_slot = chart_slot.saturating_add(1),
                    Err(msg) => warnings.push(msg),
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

fn insert_dashboard_chart(
    worksheet: &mut Worksheet,
    header_fmt: &Format,
    cell_fmt: &Format,
    headers: &[String],
    rows: &[Vec<String>],
    chart_type: &str,
    category_col: &str,
    value_col: Option<&str>,
    title: Option<&str>,
    chart_slot: u16,
) -> Result<(), String> {
    if headers.is_empty() || rows.is_empty() {
        return Err("ADD_CHART: no tabular data available".into());
    }

    let cat_idx = column_index(headers, category_col)
        .ok_or_else(|| format!("ADD_CHART: category column '{category_col}' not found"))?;

    let points = if let Some(vcol) = value_col.filter(|s| !s.trim().is_empty()) {
        let val_idx = column_index(headers, vcol)
            .ok_or_else(|| format!("ADD_CHART: value column '{vcol}' not found"))?;
        aggregate_sum(rows, cat_idx, val_idx)
    } else {
        aggregate_count(rows, cat_idx)
    };

    if points.is_empty() {
        return Err("ADD_CHART: no plottable points".into());
    }

    // Write a compact summary table to the right of the data for the chart series.
    let base_col = (headers.len() as u16).saturating_add(2).saturating_add(chart_slot * 4);
    let summary_title = title.unwrap_or("Chart data");
    worksheet
        .write_with_format(0, base_col, "Category", header_fmt)
        .map_err(|e| format!("ADD_CHART header: {e}"))?;
    worksheet
        .write_with_format(0, base_col + 1, summary_title, header_fmt)
        .map_err(|e| format!("ADD_CHART header: {e}"))?;

    for (i, (label, value)) in points.iter().enumerate() {
        let r = (i as u32) + 1;
        worksheet
            .write_with_format(r, base_col, label.as_str(), cell_fmt)
            .map_err(|e| format!("ADD_CHART category: {e}"))?;
        worksheet
            .write_number_with_format(r, base_col + 1, *value, cell_fmt)
            .map_err(|e| format!("ADD_CHART value: {e}"))?;
    }

    let last_row = points.len() as u32;
    let cat_letter = excel_col_letter(Some(base_col as usize));
    let val_letter = excel_col_letter(Some((base_col + 1) as usize));
    let cats = format!("{cat_letter}2:{cat_letter}{}", last_row + 1);
    let vals = format!("{val_letter}2:{val_letter}{}", last_row + 1);

    let ctype = match chart_type.to_ascii_lowercase().as_str() {
        "bar" => ChartType::Bar,
        "line" => ChartType::Line,
        "pie" => ChartType::Pie,
        _ => ChartType::Column,
    };

    let mut chart = Chart::new(ctype);
    chart.title().set_name(summary_title);
    chart
        .add_series()
        .set_categories(cats.as_str())
        .set_values(vals.as_str())
        .set_name(summary_title);

    let chart_row = 1u32 + (chart_slot as u32) * 16;
    let chart_col = base_col + 3;
    worksheet
        .insert_chart(chart_row, chart_col, &chart)
        .map_err(|e| format!("ADD_CHART insert: {e}"))?;

    Ok(())
}

fn column_index(headers: &[String], name: &str) -> Option<usize> {
    let target = name.trim().to_lowercase();
    headers
        .iter()
        .position(|h| h.trim().to_lowercase() == target)
}

fn parse_number(s: &str) -> Option<f64> {
    let cleaned = s.trim().replace(',', "");
    cleaned.parse::<f64>().ok()
}

fn aggregate_count(rows: &[Vec<String>], cat_idx: usize) -> Vec<(String, f64)> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let label = row.get(cat_idx).cloned().unwrap_or_default();
        if label.trim().is_empty() {
            continue;
        }
        *counts.entry(label).or_default() += 1;
    }
    let mut points: Vec<(String, f64)> = counts
        .into_iter()
        .map(|(k, v)| (k, v as f64))
        .collect();
    points.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    points.truncate(24);
    points
}

fn aggregate_sum(rows: &[Vec<String>], cat_idx: usize, val_idx: usize) -> Vec<(String, f64)> {
    let mut sums: HashMap<String, f64> = HashMap::new();
    for row in rows {
        let label = row.get(cat_idx).cloned().unwrap_or_default();
        if label.trim().is_empty() {
            continue;
        }
        let val = row
            .get(val_idx)
            .and_then(|s| parse_number(s))
            .unwrap_or(0.0);
        *sums.entry(label).or_default() += val;
    }
    let mut points: Vec<(String, f64)> = sums.into_iter().collect();
    points.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    points.truncate(24);
    points
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

/// First http(s) URL in a cell, if any.
fn extract_http_url(text: &str) -> Option<&str> {
    let lower = text.to_ascii_lowercase();
    let start = lower.find("https://").or_else(|| lower.find("http://"))?;
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ')' | ']' | '>' | ',' | ';'))
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

fn write_smart_cell(
    worksheet: &mut Worksheet,
    row: u32,
    col: u16,
    cell: &str,
    fmt: &Format,
) -> Result<(), String> {
    if let Some(url) = extract_http_url(cell) {
        if url.len() == cell.trim().len() {
            worksheet
                .write_url_with_format(row, col, Url::new(url), fmt)
                .map_err(|e| format!("Write URL: {e}"))?;
            return Ok(());
        }
    }
    if let Some(n) = parse_number(cell) {
        if !cell.trim().starts_with('0') || cell.trim() == "0" || cell.contains('.') {
            worksheet
                .write_number_with_format(row, col, n, fmt)
                .map_err(|e| format!("Write number: {e}"))?;
            return Ok(());
        }
    }
    worksheet
        .write_with_format(row, col, cell, fmt)
        .map_err(|e| format!("Write cell: {e}"))?;
    Ok(())
}
