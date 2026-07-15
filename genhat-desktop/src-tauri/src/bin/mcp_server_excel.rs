//! mcp-server-excel — MCP tool sidecar for spreadsheet synthesis.

use std::io::{self, BufRead};

use app_lib::grammar::plan_normalize::parse_spreadsheet_plan;
use app_lib::grammar::schema::SpreadsheetPlan;
use app_lib::spreadsheet::write_spreadsheet_plan;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: u64,
    params: serde_json::Value,
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
    let params = raw.get("params").cloned().unwrap_or(serde_json::json!({ "ops": [] }));

    let plan: SpreadsheetPlan = match parse_spreadsheet_plan(params) {
        Ok(p) => p,
        Err(e) => {
            write_error(id, -32602, &format!("Invalid plan: {e}"));
            std::process::exit(1);
        }
    };

    match write_spreadsheet_plan(plan) {
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
