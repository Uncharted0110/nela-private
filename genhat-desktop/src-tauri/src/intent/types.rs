//! Intent decision types for the tiered intent resolver (revamp.md §4).

use serde::{Deserialize, Serialize};

/// The macro-intent of a user request, resolved before any heavy model spin-up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum IntentKind {
    /// Standard conversational chat (no special tool).
    Chat,
    /// File/document search via the ambient indexer + RAG pipeline.
    FileSearch,
    /// Artifact synthesis via a named MCP tool.
    Artifact { tool: String, schema_id: String },
    /// Iterative diff-patch applied to an existing artifact.
    Patch { artifact_path: String },
    /// Summarisation of a document or conversation.
    Summarize,
}

/// The full resolved intent decision, including the resolution tier and confidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentDecision {
    pub kind: IntentKind,
    /// Resolution tier: 0 = deterministic, 1 = ONNX classifier, 2 = SLM fallback.
    pub tier: u8,
    /// Classifier confidence (1.0 for deterministic Tier 0).
    pub confidence: f32,
}

impl IntentDecision {
    pub fn chat_deterministic() -> Self {
        Self {
            kind: IntentKind::Chat,
            tier: 0,
            confidence: 1.0,
        }
    }

    pub fn file_search(tier: u8, confidence: f32) -> Self {
        Self {
            kind: IntentKind::FileSearch,
            tier,
            confidence,
        }
    }

    pub fn summarize(tier: u8, confidence: f32) -> Self {
        Self {
            kind: IntentKind::Summarize,
            tier,
            confidence,
        }
    }

    pub fn artifact(tool: impl Into<String>, schema_id: impl Into<String>) -> Self {
        Self {
            kind: IntentKind::Artifact {
                tool: tool.into(),
                schema_id: schema_id.into(),
            },
            tier: 0,
            confidence: 1.0,
        }
    }
}
