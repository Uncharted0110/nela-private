//! MCP coordinator — spawns sidecar binaries and communicates via stdio JSON-RPC.
//!
//! ## Lifecycle (revamp.md §8.1)
//! ```text
//! spawn sidecar → write ToolCall JSON to stdin → read ToolResult from stdout
//!   → exit(0) on completion → reap child
//!   → crash (non-zero exit / broken pipe) → return Err → caller routes to fallback §9
//! ```
//!
//! ## Sidecar resolution
//! Sidecars are looked for in:
//!   - `<bundle>/mcp-lin/` (Linux), `<bundle>/mcp-mac/` (macOS),
//!     `<bundle>/mcp-win/` (Windows)
//!   - Adjacent to the current executable (dev builds)
//!
//! Each sidecar is a standalone Rust binary that reads one JSON-RPC request
//! from stdin and writes one JSON-RPC response to stdout, then exits.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;

use tokio::sync::broadcast;

use crate::mcp::types::{JsonRpcRequest, JsonRpcResponse, PipelineStage, ToolCall, ToolResult};
use crate::paths::resolve_bundled_binary;

/// MCP coordinator: manages sidecar tool invocations.
///
/// Stored as `Arc<McpCoordinator>` in Tauri app state.
pub struct McpCoordinator {
    /// Broadcast channel for pipeline progress events → frontend.
    progress_tx: broadcast::Sender<PipelineStage>,
}

impl std::fmt::Debug for McpCoordinator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpCoordinator").finish()
    }
}

impl Default for McpCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl McpCoordinator {
    pub fn new() -> Self {
        let (progress_tx, _) = broadcast::channel(64);
        Self { progress_tx }
    }

    /// Subscribe to pipeline progress events.
    pub fn subscribe(&self) -> broadcast::Receiver<PipelineStage> {
        self.progress_tx.subscribe()
    }

    /// Broadcast a pipeline stage update (best-effort, ignores send errors when no receivers).
    pub fn emit(&self, stage: PipelineStage) {
        let _ = self.progress_tx.send(stage);
    }

    /// Invoke a MCP tool sidecar.
    ///
    /// Sends the `ToolCall` as a JSON-RPC request over stdin, reads the
    /// `ToolResult` from stdout, and returns it.
    ///
    /// Returns an `Err` on sidecar crash, broken pipe, or JSON parse failure.
    /// The caller is responsible for routing to the unhappy-path fallback (§9).
    pub fn invoke(&self, call: ToolCall, app_cache_dir: &std::path::Path) -> Result<ToolResult, String> {
        let (binary_name, method) = match &call {
            ToolCall::Excel(_) => ("mcp-server-excel", "tools/call"),
            ToolCall::Presentation(_) => ("mcp-server-presentation", "tools/call"),
            ToolCall::Html(_) => ("mcp-server-html", "tools/call"),
        };

        self.emit(PipelineStage::WritingCode);

        let binary_path = resolve_mcp_binary(binary_name)?;

        // Verify cryptographic signature before spawning (revamp P6)
        if let Err(e) = crate::security::verify_sidecar(&binary_path, app_cache_dir) {
            return Err(format!("Security Block: {e}"));
        }

        // Serialise the plan as JSON-RPC params.
        let params = match &call {
            ToolCall::Excel(plan) => {
                serde_json::to_value(plan).map_err(|e| format!("Serialise plan: {e}"))?
            }
            ToolCall::Presentation(plan) => {
                serde_json::to_value(plan).map_err(|e| format!("Serialise plan: {e}"))?
            }
            ToolCall::Html(plan) => {
                serde_json::to_value(plan).map_err(|e| format!("Serialise plan: {e}"))?
            }
        };

        let rpc_request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: 1,
            method: method.to_string(),
            params,
        };

        let request_json =
            serde_json::to_string(&rpc_request).map_err(|e| format!("Serialise RPC: {e}"))?;

        // Spawn the sidecar with stdio pipes.
        let mut child = Command::new(&binary_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Spawn '{binary_name}': {e}"))?;

        log::info!(
            "MCP sidecar '{}' spawned (pid={})",
            binary_name,
            child.id()
        );

        // Write request to stdin then close the pipe so the sidecar knows EOF.
        if let Some(mut stdin) = child.stdin.take() {
            writeln!(stdin, "{request_json}")
                .map_err(|e| format!("Write to sidecar stdin: {e}"))?;
        }

        // Wait for the sidecar and collect output.
        let output = child
            .wait_with_output()
            .map_err(|e| format!("Wait for '{binary_name}': {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "MCP sidecar '{}' exited {:?}: {}",
                binary_name,
                output.status.code(),
                stderr.trim()
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let response: JsonRpcResponse = serde_json::from_str(stdout.trim())
            .map_err(|e| format!("Parse sidecar response: {e}\nRaw stdout: {stdout}"))?;

        if let Some(err) = response.error {
            return Err(format!(
                "MCP tool error {}: {}",
                err.code, err.message
            ));
        }

        let result_value = response
            .result
            .ok_or_else(|| "MCP response missing 'result'".to_string())?;

        let tool_result: ToolResult = serde_json::from_value(result_value)
            .map_err(|e| format!("Deserialise ToolResult: {e}"))?;

        self.emit(PipelineStage::LivePreview {
            path: tool_result.path.clone(),
        });

        log::info!("MCP '{}' → {}", binary_name, tool_result.path);
        Ok(tool_result)
    }
}

// ── Sidecar resolution ────────────────────────────────────────────────────────

fn resolve_mcp_binary(name: &str) -> Result<std::path::PathBuf, String> {
    let os_folder = if cfg!(windows) {
        "mcp-win"
    } else if cfg!(target_os = "macos") {
        "mcp-mac"
    } else {
        "mcp-lin"
    };

    let exe_names: &[&str] = if cfg!(windows) {
        // Static slice — can't build a Vec<&str> from a format! here easily,
        // so handle the .exe suffix by checking both.
        &[]
    } else {
        &[name][..]
    };

    // Windows: try <name>.exe
    #[cfg(windows)]
    let exe_name_win = format!("{name}.exe");
    #[cfg(windows)]
    let exe_names: &[&str] = &[exe_name_win.as_str()];

    if let Ok(path) = resolve_bundled_binary(os_folder, exe_names) {
        return Ok(path);
    }

    // Dev fallback: look next to the current executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = if cfg!(windows) {
                dir.join(format!("{name}.exe"))
            } else {
                dir.join(name)
            };
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    Err(format!(
        "MCP sidecar '{name}' not found. Bundle it in '{os_folder}/'."
    ))
}

/// Tauri managed state wrapper for the MCP coordinator.
pub struct McpCoordinatorState(pub Arc<McpCoordinator>);
