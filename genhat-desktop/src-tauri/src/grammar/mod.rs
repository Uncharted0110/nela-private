//! Grammar module — GBNF constrained output and Functional Schema Library.
//!
//! ## Architecture
//!
//! The grammar layer sits between the intent router and the MCP coordinator.
//! The SLM emits a compact JSON plan constrained by a GBNF grammar; the plan
//! is validated/repaired here before being dispatched to a native MCP tool.
//!
//! ```text
//! Intent → Schema Manifest → GBNF → SLM plan (≤500 tokens) → repair → MCP tool
//! ```
//!
//! ## Submodules
//! - `gbnf`   — GBNF string constants and builders
//! - `schema` — Operation vocabulary (SpreadsheetOp, SlideLayout, …)
//! - `repair` — JSON key repair with Levenshtein distance

pub mod gbnf;
pub mod repair;
pub mod schema;

pub use gbnf::{
    json_object_with_keys, JSON_VALUE_GBNF, PRESENTATION_PLAN_GBNF, SPREADSHEET_PLAN_GBNF,
    HTML_PLAN_GBNF,
};
pub use repair::{repair_json_keys, RepairError};
pub use schema::{
    PresentationPlan, PresentationSlide, SchemaManifest, SlideLayout, SpreadsheetOp,
    SpreadsheetPlan, HtmlPlan,
};

/// Valid top-level keys for a `SpreadsheetPlan` payload.
pub const SPREADSHEET_PLAN_KEYS: &[&str] =
    &["ops", "source_rows", "headers", "output_name"];

/// Valid top-level keys for a `PresentationPlan` payload.
pub const PRESENTATION_PLAN_KEYS: &[&str] = &["slides", "theme", "output_name"];

/// Valid top-level keys for a `HtmlPlan` payload.
pub const HTML_PLAN_KEYS: &[&str] = &["html", "output_name"];

/// Validate and optionally repair a JSON payload against a known key allowlist.
///
/// Returns the repaired JSON string, or an error if any key is too corrupted
/// (distance > 3 — revamp.md §5.2 "discard and route to fallback recovery").
pub fn validate_and_repair(json: &str, valid_keys: &[&str]) -> Result<String, RepairError> {
    repair_json_keys(json, valid_keys)
}
