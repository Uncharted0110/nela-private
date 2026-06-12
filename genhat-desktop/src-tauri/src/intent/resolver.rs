//! Tiered intent resolver (revamp.md §4).
//!
//! Resolves the user's macro-intent in ≤150 ms before any heavy model spin-up,
//! using three tiers in priority order:
//!
//! | Tier | Mechanism                  | Budget   | When used                          |
//! |------|----------------------------|----------|------------------------------------|
//! | 0    | Deterministic              | < 1 ms   | Slash commands, UI mode, keywords  |
//! | 1    | ONNX DistilBERT classifier | 10–30 ms | All other requests                 |
//! | 2    | SLM fallback (warm only)   | ≤250 ms  | Tier 1 confidence < threshold      |
//!
//! The 150 ms target is achievable because Tier 0 handles the majority of
//! interactions, and Tier 1 uses the existing in-process ONNX classifier —
//! no llama-server cold start (revamp.md §4.2).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use super::types::{IntentDecision, IntentKind};
use crate::registry::types::{TaskRequest, TaskResponse, TaskType};
use crate::router::TaskRouter;

/// Minimum Tier 1 classifier confidence to use the result directly.
/// Below this threshold, Tier 2 (SLM) is attempted, or Chat is used as default.
const TIER1_CONFIDENCE_THRESHOLD: f32 = 0.75;

/// The intent resolver — holds a reference to the task router for Tier 1/2 calls.
pub struct IntentResolver {
    router: Arc<TaskRouter>,
}

impl std::fmt::Debug for IntentResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IntentResolver").finish()
    }
}

impl IntentResolver {
    pub fn new(router: Arc<TaskRouter>) -> Self {
        Self { router }
    }

    /// Resolve macro-intent for a user prompt.
    ///
    /// Attempts tiers in order; falls back to `Chat` if all tiers fail or
    /// return low-confidence results.
    pub async fn resolve(
        &self,
        prompt: &str,
        extra: &HashMap<String, String>,
    ) -> IntentDecision {
        let start = Instant::now();

        // Tier 0 — deterministic (sub-ms)
        if let Some(decision) = self.tier0(prompt, extra) {
            log::debug!(
                "IntentResolver Tier 0 → {:?} in {:?}",
                decision.kind,
                start.elapsed()
            );
            return decision;
        }

        // Tier 1 — ONNX classifier (10–30 ms)
        if let Some(decision) = self.tier1(prompt).await {
            log::debug!(
                "IntentResolver Tier 1 → {:?} (conf={:.2}) in {:?}",
                decision.kind,
                decision.confidence,
                start.elapsed()
            );
            if decision.confidence >= TIER1_CONFIDENCE_THRESHOLD {
                return decision;
            }
        }

        // Tier 2 — SLM fallback (warm model only; defaults to Chat if not warm)
        let decision = self.tier2(prompt).await;
        log::debug!(
            "IntentResolver Tier 2 → {:?} in {:?}",
            decision.kind,
            start.elapsed()
        );
        decision
    }

    // ── Tier 0: deterministic ─────────────────────────────────────────────────

    fn tier0(&self, prompt: &str, extra: &HashMap<String, String>) -> Option<IntentDecision> {
        // Explicit intent from UI (e.g. mode buttons, drag-and-drop artifact).
        if let Some(intent_key) = extra.get("intent") {
            return Some(self.parse_explicit_intent(intent_key));
        }

        let trimmed = prompt.trim();

        // Slash commands: /excel, /ppt, /search, /summarize, …
        if let Some(cmd) = trimmed.strip_prefix('/') {
            let cmd_word = cmd.split_whitespace().next().unwrap_or("").to_lowercase();
            return Some(match cmd_word.as_str() {
                "excel" | "xlsx" | "spreadsheet" | "sheet" => {
                    IntentDecision::artifact("mcp-server-excel", "spreadsheet_synthesis")
                }
                "ppt" | "slides" | "presentation" | "deck" | "slide" => {
                    IntentDecision::artifact("mcp-server-presentation", "presentation_synthesis")
                }
                "html" | "webpage" | "web" | "page" | "website" => {
                    IntentDecision::artifact("mcp-server-html", "html_synthesis")
                }
                "search" | "find" | "locate" | "lookup" => {
                    IntentDecision::file_search(0, 1.0)
                }
                "summarize" | "summary" | "tldr" => IntentDecision::summarize(0, 1.0),
                _ => IntentDecision::chat_deterministic(),
            });
        }

        // High-signal natural-language triggers (only the most unambiguous phrases).
        let lower = trimmed.to_lowercase();
        if matches_artifact_trigger_excel(&lower) {
            return Some(IntentDecision::artifact(
                "mcp-server-excel",
                "spreadsheet_synthesis",
            ));
        }
        if matches_artifact_trigger_presentation(&lower) {
            return Some(IntentDecision::artifact(
                "mcp-server-presentation",
                "presentation_synthesis",
            ));
        }
        if matches_artifact_trigger_html(&lower) {
            return Some(IntentDecision::artifact(
                "mcp-server-html",
                "html_synthesis",
            ));
        }

        None
    }

    fn parse_explicit_intent(&self, key: &str) -> IntentDecision {
        match key {
            "excel" | "spreadsheet" | "xlsx" => {
                IntentDecision::artifact("mcp-server-excel", "spreadsheet_synthesis")
            }
            "presentation" | "slides" | "ppt" => {
                IntentDecision::artifact("mcp-server-presentation", "presentation_synthesis")
            }
            "html" | "webpage" | "web" | "page" | "website" => {
                IntentDecision::artifact("mcp-server-html", "html_synthesis")
            }
            "file_search" | "search" | "find" => IntentDecision::file_search(0, 1.0),
            "summarize" | "summarization" => IntentDecision::summarize(0, 1.0),
            _ => IntentDecision::chat_deterministic(),
        }
    }

    // ── Tier 1: ONNX DistilBERT classifier ───────────────────────────────────

    async fn tier1(&self, prompt: &str) -> Option<IntentDecision> {
        let request = TaskRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            task_type: TaskType::Classify,
            input: prompt.to_string(),
            model_override: None,
            extra: HashMap::new(),
            cancel_token: None,
        };

        match self.router.route(&request).await {
            Ok(TaskResponse::Classification { label, confidence }) => {
                let kind = match label.as_str() {
                    "no_retrieval" => IntentKind::Chat,
                    "simple_rag" | "multi_doc" => IntentKind::FileSearch,
                    "summarization" => IntentKind::Summarize,
                    _ => IntentKind::Chat,
                };
                Some(IntentDecision {
                    kind,
                    tier: 1,
                    confidence,
                })
            }
            Ok(_) => None,
            Err(e) => {
                log::debug!("IntentResolver Tier 1 classifier unavailable: {e}");
                None
            }
        }
    }

    // ── Tier 2: SLM fallback ──────────────────────────────────────────────────

    async fn tier2(&self, _prompt: &str) -> IntentDecision {
        // Full SLM-based classification with a grammar-constrained single-shot
        // prompt is the complete implementation.  For now, this tier defaults
        // to Chat (the safe fallback) when no warm model is available.
        //
        // A warm-model check and grammar-constrained completion will be wired
        // here once the GBNF layer is exercised end-to-end in P2.
        IntentDecision::chat_deterministic()
    }
}

// ── High-signal trigger patterns ─────────────────────────────────────────────

fn matches_artifact_trigger_excel(lower: &str) -> bool {
    let has_excel_noun = lower.contains("excel")
        || lower.contains("spreadsheet")
        || lower.contains("xlsx")
        || lower.contains("sheet")
        || lower.contains("csv")
        || lower.contains("table");

    let has_create_verb = lower.contains("create")
        || lower.contains("make")
        || lower.contains("build")
        || lower.contains("generate")
        || lower.contains("synthesis")
        || lower.contains("synthesize")
        || lower.contains("render")
        || lower.contains("output")
        || lower.contains("write")
        || lower.contains("give me")
        || lower.contains("show me")
        || lower.contains("summarize to")
        || lower.contains("put in")
        || lower.contains("convert");

    has_excel_noun && has_create_verb
}

fn matches_artifact_trigger_presentation(lower: &str) -> bool {
    let has_presentation_noun = lower.contains("presentation")
        || lower.contains("slides")
        || lower.contains("slide deck")
        || lower.contains("powerpoint")
        || lower.contains("ppt")
        || lower.contains("deck");

    let has_create_verb = lower.contains("create")
        || lower.contains("make")
        || lower.contains("build")
        || lower.contains("generate")
        || lower.contains("synthesis")
        || lower.contains("synthesize")
        || lower.contains("render")
        || lower.contains("output")
        || lower.contains("write")
        || lower.contains("give me")
        || lower.contains("show me")
        || lower.contains("put in")
        || lower.contains("convert");

    has_presentation_noun && has_create_verb
}

fn matches_artifact_trigger_html(lower: &str) -> bool {
    let has_html_noun = lower.contains("html")
        || lower.contains("webpage")
        || lower.contains("website")
        || lower.contains("web page")
        || lower.contains("landing page");

    let has_create_verb = lower.contains("create")
        || lower.contains("make")
        || lower.contains("build")
        || lower.contains("generate")
        || lower.contains("synthesis")
        || lower.contains("synthesize")
        || lower.contains("render")
        || lower.contains("output")
        || lower.contains("write")
        || lower.contains("give me")
        || lower.contains("show me")
        || lower.contains("put in")
        || lower.contains("convert");

    has_html_noun && has_create_verb
}
