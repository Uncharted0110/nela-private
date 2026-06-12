//! Intent router — resolves macro-intent before any heavy model spin-up.
//!
//! Uses a tiered resolver to meet the ≤150 ms budget (revamp.md §4):
//! - Tier 0: deterministic (slash commands, explicit UI mode, keyword triggers)
//! - Tier 1: ONNX DistilBERT classifier (reuses the existing in-process model)
//! - Tier 2: SLM fallback (warm model only)
//!
//! ## Submodules
//! - `types`    — `IntentDecision`, `IntentKind`
//! - `resolver` — `IntentResolver` (tiered logic)

pub mod resolver;
pub mod types;

pub use resolver::IntentResolver;
pub use types::{IntentDecision, IntentKind};

/// Tauri managed state wrapper for the intent resolver.
pub struct IntentResolverState(pub std::sync::Arc<IntentResolver>);
