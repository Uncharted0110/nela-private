//! MCP (Model Context Protocol) coordinator module.
//!
//! Implements the "SLM routes, native computes" principle (revamp.md §1.1).
//! The coordinator spawns signed sidecar binaries, communicates via stdio
//! JSON-RPC, and broadcasts pipeline progress events to the frontend.
//!
//! ## Submodules
//! - `coordinator` — Sidecar lifecycle and JSON-RPC dispatch
//! - `types`       — Wire types (ToolCall, ToolResult, PipelineStage, JSON-RPC)

pub mod coordinator;
pub mod types;

pub use coordinator::{McpCoordinator, McpCoordinatorState};
pub use types::{PipelineStage, ToolCall, ToolResult};
