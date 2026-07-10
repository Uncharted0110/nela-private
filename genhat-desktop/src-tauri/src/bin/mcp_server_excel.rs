//! mcp-server-excel — MCP tool sidecar for spreadsheet synthesis.
//!
//! Reads one JSON-RPC 2.0 request from stdin, generates an `.xlsx` file using
//! `rust_xlsxwriter`, and writes one JSON-RPC 2.0 response to stdout, then exits.

use std::collections::HashMap;
use std::io::{self, BufRead};
use std::path::PathBuf;

use rust_xlsxwriter::{Format, Workbook};
use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// Wire types
// ─────────────────────────────────────────────────────────────────────────────

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
// Spreadsheet plan types
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
    Pivot {
        row_col: String,
        col_col: String,
        value_col: String,
    },
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
    WriteData {
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    #[serde(rename = "RENAME_SHEET")]
    RenameSheet { name: String },
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory table
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
struct Table {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

impl Table {
    fn is_empty(&self) -> bool {
        self.headers.is_empty() && self.rows.is_empty()
    }

    fn from_source(headers: &[String], rows: &[Vec<String>]) -> Self {
        Self {
            headers: headers.to_vec(),
            rows: rows.to_vec(),
        }
    }

    fn load_write_data(&mut self, headers: &[String], rows: &[Vec<String>]) {
        if self.is_empty() {
            self.headers = headers.to_vec();
            self.rows = normalize_rows(headers.len(), rows);
            return;
        }

        if self.headers == headers {
            self.rows.extend(normalize_rows(headers.len(), rows));
            return;
        }

        // Different schema — replace when current table has no rows.
        if self.rows.is_empty() {
            self.headers = headers.to_vec();
            self.rows = normalize_rows(headers.len(), rows);
        } else {
            self.rows.extend(normalize_rows(self.headers.len(), rows));
        }
    }

    fn col_index(&self, name: &str) -> Option<usize> {
        self.headers
            .iter()
            .position(|h| h.eq_ignore_ascii_case(name))
    }

    fn sort_by(&mut self, col: &str, ascending: bool) -> Result<(), String> {
        let idx = self
            .col_index(col)
            .ok_or_else(|| format!("SORT: column '{col}' not found"))?;

        self.rows.sort_by(|a, b| {
            let av = a.get(idx).map(|s| s.as_str()).unwrap_or("");
            let bv = b.get(idx).map(|s| s.as_str()).unwrap_or("");
            let ord = compare_cells(av, bv);
            if ascending {
                ord
            } else {
                ord.reverse()
            }
        });
        Ok(())
    }

    fn filter_rows(&mut self, col: &str, value: &str) -> Result<(), String> {
        let idx = self
            .col_index(col)
            .ok_or_else(|| format!("FILTER_ROWS: column '{col}' not found"))?;

        let needle = value.trim();
        self.rows.retain(|row| {
            row.get(idx)
                .map(|cell| cell.trim().eq_ignore_ascii_case(needle))
                .unwrap_or(false)
        });
        Ok(())
    }

    fn add_column(&mut self, name: &str, formula: &str) -> Result<(), String> {
        if name.trim().is_empty() {
            return Err("ADD_COLUMN: name is empty".into());
        }
        if self.col_index(name).is_some() {
            return Err(format!("ADD_COLUMN: column '{name}' already exists"));
        }

        self.headers.push(name.to_string());
        for row in &mut self.rows {
            let value = evaluate_formula(formula, &self.headers, row)?;
            row.push(value);
        }
        Ok(())
    }

    fn sum_column(&self, col: &str, label: Option<&str>) -> Result<Table, String> {
        let idx = self
            .col_index(col)
            .ok_or_else(|| format!("SUM_COLUMN: column '{col}' not found"))?;

        let mut total = 0.0f64;
        let mut any_numeric = false;
        for row in &self.rows {
            if let Some(n) = parse_number(row.get(idx).map(|s| s.as_str()).unwrap_or("")) {
                total += n;
                any_numeric = true;
            }
        }

        if !any_numeric {
            return Err(format!("SUM_COLUMN: no numeric values in '{col}'"));
        }

        let mut total_row = vec![String::new(); self.headers.len()];
        if let Some(first) = total_row.first_mut() {
            *first = label
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("SUM({col})"));
        }
        if idx < total_row.len() {
            total_row[idx] = format_number(total);
        }

        let mut rows = self.rows.clone();
        rows.push(total_row);
        Ok(Table {
            headers: self.headers.clone(),
            rows,
        })
    }

    fn count_by_group(&self, group_col: &str) -> Result<Table, String> {
        let idx = self
            .col_index(group_col)
            .ok_or_else(|| format!("COUNT_BY_GROUP: column '{group_col}' not found"))?;

        let mut counts: HashMap<String, usize> = HashMap::new();
        for row in &self.rows {
            let key = row.get(idx).map(|s| s.trim().to_string()).unwrap_or_default();
            if key.is_empty() {
                continue;
            }
            *counts.entry(key).or_insert(0) += 1;
        }

        let mut keys: Vec<_> = counts.keys().cloned().collect();
        keys.sort();

        Ok(Table {
            headers: vec![group_col.to_string(), "Count".into()],
            rows: keys
                .into_iter()
                .map(|k| vec![k.clone(), counts[&k].to_string()])
                .collect(),
        })
    }

    fn average_by_group(&self, value_col: &str, group_col: &str) -> Result<Table, String> {
        let vidx = self
            .col_index(value_col)
            .ok_or_else(|| format!("AVERAGE_BY_GROUP: value column '{value_col}' not found"))?;
        let gidx = self
            .col_index(group_col)
            .ok_or_else(|| format!("AVERAGE_BY_GROUP: group column '{group_col}' not found"))?;

        let mut sums: HashMap<String, f64> = HashMap::new();
        let mut counts: HashMap<String, usize> = HashMap::new();

        for row in &self.rows {
            let group = row.get(gidx).map(|s| s.trim().to_string()).unwrap_or_default();
            if group.is_empty() {
                continue;
            }
            if let Some(n) = parse_number(row.get(vidx).map(|s| s.as_str()).unwrap_or("")) {
                *sums.entry(group.clone()).or_insert(0.0) += n;
                *counts.entry(group).or_insert(0) += 1;
            }
        }

        let mut keys: Vec<_> = sums.keys().cloned().collect();
        keys.sort();

        Ok(Table {
            headers: vec![group_col.to_string(), format!("Avg {value_col}")],
            rows: keys
                .into_iter()
                .filter_map(|k| {
                    let count = counts.get(&k)?;
                    if *count == 0 {
                        return None;
                    }
                    let avg = sums[&k] / (*count as f64);
                    Some(vec![k, format_number(avg)])
                })
                .collect(),
        })
    }

    fn pivot(&self, row_col: &str, col_col: &str, value_col: &str) -> Result<Table, String> {
        let ridx = self
            .col_index(row_col)
            .ok_or_else(|| format!("PIVOT: row column '{row_col}' not found"))?;
        let cidx = self
            .col_index(col_col)
            .ok_or_else(|| format!("PIVOT: column column '{col_col}' not found"))?;
        let vidx = self
            .col_index(value_col)
            .ok_or_else(|| format!("PIVOT: value column '{value_col}' not found"))?;

        let mut col_keys: Vec<String> = Vec::new();
        let mut row_keys: Vec<String> = Vec::new();
        let mut values: HashMap<(String, String), f64> = HashMap::new();

        for row in &self.rows {
            let rk = row.get(ridx).map(|s| s.trim().to_string()).unwrap_or_default();
            let ck = row.get(cidx).map(|s| s.trim().to_string()).unwrap_or_default();
            if rk.is_empty() || ck.is_empty() {
                continue;
            }
            if !col_keys.contains(&ck) {
                col_keys.push(ck.clone());
            }
            if !row_keys.contains(&rk) {
                row_keys.push(rk.clone());
            }
            let n = parse_number(row.get(vidx).map(|s| s.as_str()).unwrap_or("")).unwrap_or(0.0);
            *values.entry((rk, ck)).or_insert(0.0) += n;
        }

        col_keys.sort();
        row_keys.sort();

        let mut headers = vec![row_col.to_string()];
        headers.extend(col_keys.clone());

        let rows = row_keys
            .into_iter()
            .map(|rk| {
                let mut row = vec![rk.clone()];
                for ck in &col_keys {
                    let val = values.get(&(rk.clone(), ck.clone())).copied().unwrap_or(0.0);
                    row.push(format_number(val));
                }
                row
            })
            .collect();

        Ok(Table { headers, rows })
    }
}

fn normalize_rows(width: usize, rows: &[Vec<String>]) -> Vec<Vec<String>> {
    rows.iter()
        .map(|row| {
            let mut padded = row.clone();
            while padded.len() < width {
                padded.push(String::new());
            }
            padded.truncate(width);
            padded
        })
        .filter(|row| row.iter().any(|cell| !cell.trim().is_empty()))
        .collect()
}

fn compare_cells(a: &str, b: &str) -> std::cmp::Ordering {
    match (parse_number(a), parse_number(b)) {
        (Some(na), Some(nb)) => na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal),
        _ => a.to_lowercase().cmp(&b.to_lowercase()),
    }
}

fn parse_number(s: &str) -> Option<f64> {
    let cleaned = s.trim().replace(',', "");
    if cleaned.is_empty() {
        return None;
    }
    cleaned.parse::<f64>().ok()
}

fn format_number(n: f64) -> String {
    if (n.fract()).abs() < f64::EPSILON {
        format!("{}", n as i64)
    } else {
        format!("{n:.4}").trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn evaluate_formula(formula: &str, headers: &[String], row: &[String]) -> Result<String, String> {
    let expr = formula.trim();
    if expr.is_empty() {
        return Ok(String::new());
    }

    // Try to resolve a single column reference.
    if let Some(idx) = headers
        .iter()
        .position(|h| h.eq_ignore_ascii_case(expr))
    {
        return Ok(row.get(idx).cloned().unwrap_or_default());
    }

    // Replace column names with numeric values (longest names first).
    let mut names: Vec<&str> = headers.iter().map(|s| s.as_str()).collect();
    names.sort_by_key(|s| std::cmp::Reverse(s.len()));

    let mut substituted = expr.to_string();
    for name in names {
        let idx = headers.iter().position(|h| h == name).unwrap();
        let cell = row.get(idx).map(|s| s.as_str()).unwrap_or("0");
        let num = parse_number(cell).unwrap_or(0.0).to_string();
        substituted = substituted.replace(name, &num);
    }

    eval_arithmetic(&substituted).map(format_number)
}

fn eval_arithmetic(expr: &str) -> Result<f64, String> {
    let tokens = tokenize_arithmetic(expr)?;
    let mut pos = 0;
    let value = parse_add_sub(&tokens, &mut pos)?;
    if pos != tokens.len() {
        return Err(format!("ADD_COLUMN: unexpected token in '{expr}'"));
    }
    Ok(value)
}

#[derive(Debug, Clone)]
enum ArithToken {
    Number(f64),
    Op(char),
    LParen,
    RParen,
}

fn tokenize_arithmetic(expr: &str) -> Result<Vec<ArithToken>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = expr.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit()) {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            let num: f64 = chars[start..i]
                .iter()
                .collect::<String>()
                .parse()
                .map_err(|_| format!("ADD_COLUMN: invalid number in '{expr}'"))?;
            tokens.push(ArithToken::Number(num));
            continue;
        }
        if "+-*/".contains(c) {
            tokens.push(ArithToken::Op(c));
            i += 1;
            continue;
        }
        if c == '(' {
            tokens.push(ArithToken::LParen);
            i += 1;
            continue;
        }
        if c == ')' {
            tokens.push(ArithToken::RParen);
            i += 1;
            continue;
        }
        return Err(format!("ADD_COLUMN: invalid character '{c}' in '{expr}'"));
    }
    Ok(tokens)
}

fn parse_add_sub(tokens: &[ArithToken], pos: &mut usize) -> Result<f64, String> {
    let mut value = parse_mul_div(tokens, pos)?;
    while *pos < tokens.len() {
        match tokens[*pos] {
            ArithToken::Op('+') => {
                *pos += 1;
                value += parse_mul_div(tokens, pos)?;
            }
            ArithToken::Op('-') => {
                *pos += 1;
                value -= parse_mul_div(tokens, pos)?;
            }
            _ => break,
        }
    }
    Ok(value)
}

fn parse_mul_div(tokens: &[ArithToken], pos: &mut usize) -> Result<f64, String> {
    let mut value = parse_unary(tokens, pos)?;
    while *pos < tokens.len() {
        match tokens[*pos] {
            ArithToken::Op('*') => {
                *pos += 1;
                value *= parse_unary(tokens, pos)?;
            }
            ArithToken::Op('/') => {
                *pos += 1;
                let rhs = parse_unary(tokens, pos)?;
                if rhs.abs() < f64::EPSILON {
                    return Err("ADD_COLUMN: division by zero".into());
                }
                value /= rhs;
            }
            _ => break,
        }
    }
    Ok(value)
}

fn parse_unary(tokens: &[ArithToken], pos: &mut usize) -> Result<f64, String> {
    if *pos < tokens.len() {
        if let ArithToken::Op('-') = tokens[*pos] {
            *pos += 1;
            return Ok(-parse_unary(tokens, pos)?);
        }
        if let ArithToken::Op('+') = tokens[*pos] {
            *pos += 1;
            return parse_unary(tokens, pos);
        }
    }
    parse_primary(tokens, pos)
}

fn parse_primary(tokens: &[ArithToken], pos: &mut usize) -> Result<f64, String> {
    if *pos >= tokens.len() {
        return Err("ADD_COLUMN: unexpected end of expression".into());
    }
    match &tokens[*pos] {
        ArithToken::Number(n) => {
            *pos += 1;
            Ok(*n)
        }
        ArithToken::LParen => {
            *pos += 1;
            let value = parse_add_sub(tokens, pos)?;
            if *pos >= tokens.len() || !matches!(tokens[*pos], ArithToken::RParen) {
                return Err("ADD_COLUMN: missing ')'".into());
            }
            *pos += 1;
            Ok(value)
        }
        _ => Err("ADD_COLUMN: expected number".into()),
    }
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

struct SheetOutput {
    name: String,
    table: Table,
}

fn generate_xlsx(plan: SpreadsheetPlan) -> Result<(PathBuf, Option<String>), String> {
    let output_name = plan.output_name.as_deref().unwrap_or("nela_artifact");
    let out_dir = std::env::temp_dir().join("nela_artifacts");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Create output dir: {e}"))?;
    let path = out_dir.join(format!("{output_name}.xlsx"));

    let headers = plan.headers.as_deref().unwrap_or(&[]);
    let source_rows = plan.source_rows.as_deref().unwrap_or(&[]);

    let mut main_table = if !headers.is_empty() {
        Table::from_source(headers, source_rows)
    } else {
        Table::default()
    };

    let mut sheet_name = "Sheet1".to_string();
    let mut extra_sheets: Vec<SheetOutput> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for op in &plan.ops {
        match op {
            SpreadsheetOp::WriteData { headers, rows } => {
                main_table.load_write_data(headers, rows);
            }
            SpreadsheetOp::RenameSheet { name } => {
                if !name.trim().is_empty() {
                    sheet_name = sanitize_sheet_name(name);
                }
            }
            SpreadsheetOp::SortDesc { col } => {
                if let Err(e) = main_table.sort_by(col, false) {
                    warnings.push(e);
                }
            }
            SpreadsheetOp::SortAsc { col } => {
                if let Err(e) = main_table.sort_by(col, true) {
                    warnings.push(e);
                }
            }
            SpreadsheetOp::FilterRows { col, value } => {
                if let Err(e) = main_table.filter_rows(col, value) {
                    warnings.push(e);
                }
            }
            SpreadsheetOp::AddColumn { name, formula } => {
                if let Err(e) = main_table.add_column(name, formula) {
                    warnings.push(e);
                }
            }
            SpreadsheetOp::SumColumn { col, label } => {
                match main_table.sum_column(col, label.as_deref()) {
                    Ok(updated) => main_table = updated,
                    Err(e) => warnings.push(e),
                }
            }
            SpreadsheetOp::CountByGroup { group_col } => {
                match main_table.count_by_group(group_col) {
                    Ok(summary) => extra_sheets.push(SheetOutput {
                        name: format!("Count by {group_col}"),
                        table: summary,
                    }),
                    Err(e) => warnings.push(e),
                }
            }
            SpreadsheetOp::AverageByGroup { value_col, group_col } => {
                match main_table.average_by_group(value_col, group_col) {
                    Ok(summary) => extra_sheets.push(SheetOutput {
                        name: format!("Avg {value_col}"),
                        table: summary,
                    }),
                    Err(e) => warnings.push(e),
                }
            }
            SpreadsheetOp::Pivot {
                row_col,
                col_col,
                value_col,
            } => match main_table.pivot(row_col, col_col, value_col) {
                Ok(pivot) => extra_sheets.push(SheetOutput {
                    name: "Pivot".into(),
                    table: pivot,
                }),
                Err(e) => warnings.push(e),
            },
        }
    }

    if main_table.is_empty() {
        return Err(
            "No spreadsheet data to write. Plan must include WRITE_DATA or attached source rows."
                .into(),
        );
    }

    let mut workbook = Workbook::new();
    write_table_to_sheet(&mut workbook, &sheet_name, &main_table)?;

    for (i, sheet) in extra_sheets.iter().enumerate() {
        let name = if i == 0 {
            sheet.name.clone()
        } else {
            format!("{} ({})", sheet.name, i + 1)
        };
        write_table_to_sheet(&mut workbook, &sanitize_sheet_name(&name), &sheet.table)?;
    }

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

fn extract_sheet_label(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.contains("set_name(") {
        let quote_idx = trimmed.find('"').or_else(|| trimmed.find('\''));
        if let Some(start) = quote_idx {
            let quote = trimmed.as_bytes()[start] as char;
            let after = &trimmed[start + 1..];
            if let Some(end) = after.find(quote) {
                return after[..end].trim().to_string();
            }
        }
    }
    trimmed.trim_matches('"').trim_matches('\'').trim().to_string()
}

fn sanitize_sheet_name(name: &str) -> String {
    let cleaned = extract_sheet_label(name);
    let cleaned: String = cleaned
        .chars()
        .map(|c| if "\\/*?:[]".contains(c) { '_' } else { c })
        .collect();
    let truncated: String = cleaned.trim().chars().take(31).collect();
    if truncated.is_empty() {
        "Sheet1".into()
    } else {
        truncated
    }
}

fn write_table_to_sheet(
    workbook: &mut Workbook,
    sheet_name: &str,
    table: &Table,
) -> Result<(), String> {
    let safe_name = sanitize_sheet_name(sheet_name);
    let worksheet = workbook.add_worksheet();
    worksheet
        .set_name(&safe_name)
        .map_err(|e| format!("Rename sheet '{safe_name}': {e}"))?;

    let header_fmt = Format::new().set_bold();

    for (col_idx, header) in table.headers.iter().enumerate() {
        worksheet
            .write_with_format(0, col_idx as u16, header.as_str(), &header_fmt)
            .map_err(|e| format!("Write header: {e}"))?;
    }

    for (row_idx, row) in table.rows.iter().enumerate() {
        for (col_idx, cell) in row.iter().enumerate() {
            if let Some(n) = parse_number(cell) {
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

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sort_and_filter() {
        let mut table = Table {
            headers: vec!["Name".into(), "Score".into()],
            rows: vec![
                vec!["Bob".into(), "80".into()],
                vec!["Alice".into(), "95".into()],
            ],
        };
        table.sort_by("Score", false).unwrap();
        assert_eq!(table.rows[0][0], "Alice");
        table.filter_rows("Name", "Alice").unwrap();
        assert_eq!(table.rows.len(), 1);
    }

    #[test]
    fn write_data_becomes_primary_when_empty() {
        let mut table = Table::default();
        table.load_write_data(
            &["A".into(), "B".into()],
            &[vec!["1".into(), "2".into()]],
        );
        assert_eq!(table.headers, vec!["A", "B"]);
        assert_eq!(table.rows.len(), 1);
    }

    #[test]
    fn arithmetic_formula() {
        let headers = vec!["Price".into(), "Qty".into()];
        let row = vec!["10".into(), "3".into()];
        let result = evaluate_formula("Price * Qty", &headers, &row).unwrap();
        assert_eq!(result, "30");
    }
}
