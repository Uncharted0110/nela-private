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

        // Active artifact edit — frontend passes the live preview path.
        if let Some(path) = extra.get("artifact_path") {
            if !path.is_empty() && matches_artifact_edit_trigger(prompt) {
                return Some(IntentDecision::patch(path.clone()));
            }
        }

        let trimmed = prompt.trim();

        // Slash commands: /web /excel /ppt /html /rag /files (combinable at start)
        if trimmed.starts_with('/') {
            if let Some(decision) = Self::parse_slash_commands(&trimmed) {
                return Some(decision);
            }
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
            "html" | "webpage" | "page" | "website" => {
                IntentDecision::artifact("mcp-server-html", "html_synthesis")
            }
            "file_search" | "search" | "find" | "files" | "file" => {
                IntentDecision::file_search(0, 1.0)
            }
            "rag" | "docs" | "documents" => IntentDecision::chat_deterministic(),
            "web" | "internet" | "online" => IntentDecision::chat_deterministic(),
            "summarize" | "summarization" => IntentDecision::summarize(0, 1.0),
            _ => IntentDecision::chat_deterministic(),
        }
    }

    /// Parse one or more leading slash tokens. Returns the highest-priority route:
    /// artifact > file_search > summarize > chat.
    fn parse_slash_commands(trimmed: &str) -> Option<IntentDecision> {
        let mut remaining: &str = trimmed;
        let mut artifact: Option<IntentDecision> = None;
        let mut file_search = false;
        let mut summarize = false;
        let mut parsed_any = false;

        while let Some(rest) = remaining.strip_prefix('/') {
            let token = rest
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_lowercase();
            if token.is_empty() {
                break;
            }

            let consumed = token.len() + 1; // slash + token
            remaining = rest[consumed..].trim_start();
            parsed_any = true;

            match token.as_str() {
                "excel" | "xlsx" | "spreadsheet" | "sheet" | "csv" => {
                    artifact = Some(IntentDecision::artifact(
                        "mcp-server-excel",
                        "spreadsheet_synthesis",
                    ));
                }
                "ppt" | "slides" | "presentation" | "deck" | "slide" => {
                    artifact = Some(IntentDecision::artifact(
                        "mcp-server-presentation",
                        "presentation_synthesis",
                    ));
                }
                "html" | "webpage" | "page" | "website" => {
                    artifact = Some(IntentDecision::artifact(
                        "mcp-server-html",
                        "html_synthesis",
                    ));
                }
                "web" | "internet" | "online" => {}
                "rag" | "docs" | "documents" | "kb" | "library" => {}
                "files" | "file" | "search" | "find" | "locate" | "lookup" => {
                    file_search = true;
                }
                "summarize" | "summary" | "tldr" => summarize = true,
                _ => break,
            }
        }

        if artifact.is_some() {
            return artifact;
        }
        if file_search {
            return Some(IntentDecision::file_search(0, 1.0));
        }
        if summarize {
            return Some(IntentDecision::summarize(0, 1.0));
        }

        // Only modifiers like /web with no artifact route — not a Tier 0 hit.
        if parsed_any {
            return None;
        }
        None
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
                // NOTE: The DistilBERT classifier is trained for *RAG over ingested
                // documents* (no_retrieval / simple_rag / multi_doc / summarization),
                // NOT for ambient OS file search. Mapping `simple_rag`/`multi_doc`
                // to `FileSearch` previously hijacked ordinary knowledge questions
                // into the ambient file-search path (e.g. matching a random local
                // file and grounding the answer on it). These labels must resolve to
                // `Chat`; the RAG pipeline decides retrieval separately. Ambient
                // `FileSearch` is only triggered by explicit Tier 0 deterministic
                // triggers (slash commands / "search"/"find" keywords).
                let kind = match label.as_str() {
                    "summarization" => IntentKind::Summarize,
                    // no_retrieval, simple_rag, multi_doc, and anything else → Chat.
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

fn matches_artifact_edit_trigger(prompt: &str) -> bool {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_lowercase();

    // Plain Q&A / explain prompts must stay in chat even if a deck is open.
    // ("explain how facebook changed the world" used to match substring "change".)
    if is_information_seeking_prompt(&lower) {
        return false;
    }

    if !has_edit_verb_word(&lower) {
        return false;
    }

    let strong_create = lower.contains("from scratch")
        || lower.contains("brand new")
        || lower.contains("create a new")
        || lower.contains("make a new")
        || lower.contains("build a new")
        || lower.contains("generate a new");

    let references_existing = references_existing_artifact(&lower);
    let structural = is_structural_artifact_edit(&lower);

    if strong_create && !references_existing {
        return false;
    }

    // Session artifact alone is not enough — require an explicit target hint or
    // a clear structural edit (add/remove slide, change theme, …).
    references_existing || structural
}

fn is_information_seeking_prompt(lower: &str) -> bool {
    // Leading question / explain forms are chat, not deck edits.
    let starters = [
        "explain ",
        "explain,",
        "why ",
        "why,",
        "how does ",
        "how did ",
        "how do ",
        "how can ",
        "how would ",
        "what is ",
        "what are ",
        "what was ",
        "what were ",
        "what does ",
        "what did ",
        "who ",
        "when ",
        "where ",
        "tell me ",
        "describe ",
        "summarize ",
        "can you explain",
        "could you explain",
        "please explain",
    ];
    starters.iter().any(|s| lower.starts_with(s))
        || lower.starts_with("how ") && !lower.contains("slide") && !lower.contains("deck")
}

/// Word-boundary edit verbs — never match "changed" via substring "change".
fn has_edit_verb_word(lower: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)\b(edit|modify|update|change|revise|fix|adjust|tweak|improve|enhance|refine|rewrite|reformat|add|remove|delete|insert|replace|shorten|expand|polish|correct|amend|patch)\b",
        )
        .expect("edit verb regex")
    });
    re.is_match(lower)
}

fn references_existing_artifact(lower: &str) -> bool {
    lower.contains("this file")
        || lower.contains("this deck")
        || lower.contains("this slide")
        || lower.contains("this spreadsheet")
        || lower.contains("this sheet")
        || lower.contains("this page")
        || lower.contains("this html")
        || lower.contains("this presentation")
        || lower.contains("this ppt")
        || lower.contains("this artifact")
        || lower.contains("the file")
        || lower.contains("the deck")
        || lower.contains("the spreadsheet")
        || lower.contains("the sheet")
        || lower.contains("the page")
        || lower.contains("the presentation")
        || lower.contains("the ppt")
        || lower.contains("my deck")
        || lower.contains("my spreadsheet")
        || lower.contains("my presentation")
        || lower.contains("current artifact")
        || lower.contains("above file")
        || lower.contains("attached file")
        || lower.contains("open file")
        || lower.contains("same file")
        || lower.contains("same deck")
        || lower.contains("existing deck")
        || lower.contains("existing presentation")
}

fn is_structural_artifact_edit(lower: &str) -> bool {
    // Clear deck/spreadsheet surgery without needing "this deck".
    (lower.contains("slide")
        && (lower.contains("add")
            || lower.contains("remove")
            || lower.contains("delete")
            || lower.contains("insert")
            || lower.contains("append")
            || lower.contains("reorder")
            || lower.contains("move")))
        || lower.contains("change the theme")
        || lower.contains("change theme")
        || lower.contains("update the theme")
        || lower.contains("change the title")
        || lower.contains("rename the title")
        || lower.contains("add a column")
        || lower.contains("add column")
        || lower.contains("delete column")
        || lower.contains("remove column")
        || lower.contains("add a row")
        || lower.contains("add row")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explain_changed_world_is_not_artifact_edit() {
        assert!(!matches_artifact_edit_trigger(
            "explain how facebook changed the world"
        ));
    }

    #[test]
    fn change_this_deck_theme_is_artifact_edit() {
        assert!(matches_artifact_edit_trigger(
            "change the theme on this deck to midnight"
        ));
    }

    #[test]
    fn add_slide_is_structural_edit() {
        assert!(matches_artifact_edit_trigger(
            "add a slide about privacy at the end"
        ));
    }

    #[test]
    fn substring_change_in_changed_is_not_edit_verb() {
        assert!(!has_edit_verb_word("facebook changed the world"));
        assert!(has_edit_verb_word("please change the title"));
    }
}
