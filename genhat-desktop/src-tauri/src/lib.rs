//! GenHat — The Local Intelligence Engine
//!
//! Module structure:
//!   config/     — Configuration loading (models.toml)
//!   registry/   — Model definitions and lookups
//!   backends/   — Model backend implementations (llama-server, etc.)
//!   process/    — Process manager (spawn, health, reap, shutdown)
//!   router/     — Task routing (maps requests to models)
//!   commands/   — Tauri IPC command handlers
//!   system/     — System information and device compatibility
//!   governor/   — Thermal/duty-cycle governor + cancellation bus (revamp P0)
//!   grammar/    — GBNF grammars + Functional Schema Library + JSON repair (revamp P1)
//!   mcp/        — MCP coordinator: sidecar management + stdio JSON-RPC (revamp P2)
//!   intent/     — Tiered intent router: Tier 0/1/2 resolution (revamp P3)

pub mod config;
pub mod paths;
pub mod registry;
pub mod backends;
pub mod process;
pub mod router;
pub mod commands;
pub mod rag;
pub mod workspace;
pub mod tts;
pub mod asr;
pub mod podcast;
pub mod system;
pub mod playground;

// ── Revamp modules ────────────────────────────────────────────────────────────
pub mod governor;
pub mod grammar;
pub mod mcp;
pub mod intent;
pub mod indexer;
pub mod security;
pub mod telemetry;

#[cfg(windows)]
pub mod windows_spawn;
