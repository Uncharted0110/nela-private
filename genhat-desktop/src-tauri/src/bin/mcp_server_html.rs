//! mcp-server-html — MCP tool sidecar for HTML rendering.
//!
//! Reads one JSON-RPC 2.0 request from stdin, writes the HTML content to disk,
//! and writes one JSON-RPC 2.0 response to stdout, then exits.

use std::io::{self, BufRead};
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: u64,
    params: HtmlPlan,
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

#[derive(Debug, Deserialize, Serialize)]
struct HtmlPlan {
    html: String,
    output_name: Option<String>,
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

    let plan: HtmlPlan = match serde_json::from_value(raw["params"].clone()) {
        Ok(p) => p,
        Err(e) => {
            write_error(id, -32602, &format!("Invalid HTML plan: {e}"));
            std::process::exit(1);
        }
    };

    match write_html(plan) {
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
    eprintln!("mcp-server-html error: {message}");
    println!("{}", serde_json::to_string(&resp).unwrap_or_default());
}

fn write_html(plan: HtmlPlan) -> Result<PathBuf, String> {
    let output_name = plan.output_name.as_deref().unwrap_or("nela_html");
    let out_dir = std::env::temp_dir().join("nela_artifacts");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Create output dir: {e}"))?;
    let path = out_dir.join(format!("{output_name}.html"));

    std::fs::write(&path, &plan.html)
        .map_err(|e| format!("Failed to write HTML: {e}"))?;

    Ok(path)
}
