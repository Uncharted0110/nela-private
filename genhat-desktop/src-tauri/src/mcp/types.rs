//! MCP (Model Context Protocol) wire types for stdio JSON-RPC communication.
//!
//! The coordinator speaks JSON-RPC 2.0 over stdin/stdout with each sidecar
//! binary. This module defines the shared envelope types.

use serde::{Deserialize, Serialize};

use crate::grammar::schema::{PresentationPlan, SpreadsheetPlan, HtmlPlan};

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 envelope
// ─────────────────────────────────────────────────────────────────────────────

/// JSON-RPC 2.0 request sent to a sidecar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: serde_json::Value,
}

/// JSON-RPC 2.0 response read from a sidecar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

/// JSON-RPC error object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool call / result
// ─────────────────────────────────────────────────────────────────────────────

/// A tool call dispatched by the MCP coordinator to a sidecar binary.
///
/// The variant determines which sidecar is spawned and which plan type is
/// serialised as the JSON-RPC `params`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "tool", content = "plan")]
pub enum ToolCall {
    #[serde(rename = "mcp-server-excel")]
    Excel(SpreadsheetPlan),
    #[serde(rename = "mcp-server-presentation")]
    Presentation(PresentationPlan),
    #[serde(rename = "mcp-server-html")]
    Html(HtmlPlan),
}

/// Result returned by a successfully completed MCP sidecar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    /// Absolute path to the generated artifact on disk.
    pub path: String,
    /// Artifact kind identifier (e.g. `"xlsx"`, `"html"`).
    pub kind: String,
    /// Optional non-fatal warning.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline progress events
// ─────────────────────────────────────────────────────────────────────────────

/// Pipeline progress events broadcast to the frontend via a Tauri event channel.
///
/// The frontend renders these as the `ProgressSlate` state machine:
/// `[Intent Locked] → [Searching SSD…] → [Crunching Metrics…] → [Writing Code…] → [Live Preview]`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage")]
pub enum PipelineStage {
    IntentLocked { intent: String },
    SearchingDisk,
    CrunchingMetrics,
    WritingCode,
    LivePreview { path: String },
    Error { message: String },
}

impl PipelineStage {
    /// Human-readable label shown in the ProgressSlate component.
    pub fn label(&self) -> &'static str {
        match self {
            PipelineStage::IntentLocked { .. } => "Intent Locked",
            PipelineStage::SearchingDisk => "Searching SSD\u{2026}",
            PipelineStage::CrunchingMetrics => "Crunching Metrics\u{2026}",
            PipelineStage::WritingCode => "Writing Code\u{2026}",
            PipelineStage::LivePreview { .. } => "Live Preview",
            PipelineStage::Error { .. } => "Error",
        }
    }
}
