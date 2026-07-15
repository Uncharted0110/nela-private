//! mcp-server-presentation — MCP tool sidecar for presentation slide synthesis.

use std::io::{self, BufRead};

use app_lib::grammar::plan_normalize::parse_presentation_plan;
use app_lib::grammar::schema::PresentationPlan;
use app_lib::presentation::write_presentation_plan;
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
    let params = raw.get("params").cloned().unwrap_or(serde_json::json!({}));

    let plan: PresentationPlan = match parse_presentation_plan(params, "") {
        Ok(p) => p,
        Err(e) => {
            write_error(id, -32602, &format!("Invalid presentation plan: {e}"));
            std::process::exit(1);
        }
    };

    match write_presentation_plan(plan) {
        Ok(path) => {
            let resp = JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(ToolResult {
                    path: path.to_string_lossy().to_string(),
                    kind: "html".to_string(),
                    warning: None,
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
    eprintln!("mcp-server-presentation error: {message}");
    println!("{}", serde_json::to_string(&resp).unwrap_or_default());
}
