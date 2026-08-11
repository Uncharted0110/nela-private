//! Unified document parser trait.

use crate::doc_graph::errors::ParserError;
use crate::doc_graph::graph::schema::{BlockType, ContainerType};
use std::path::Path;

pub struct ParsedContentBlock {
    pub content: String,
    pub block_type: BlockType,
}

pub struct ParsedContainer {
    pub title: String,
    pub container_type: ContainerType,
    pub ordinal: usize,
    pub blocks: Vec<ParsedContentBlock>,
}

/// Optional PDF (or other) extraction quality metadata for manifest tracking.
#[derive(Debug, Clone, Default)]
pub struct ExtractionStats {
    pub pages_ok: u32,
    pub pages_failed: u32,
    pub pages_total: u32,
}

impl ExtractionStats {
    pub fn quality_ratio(&self) -> f32 {
        let attempted = self.pages_ok.saturating_add(self.pages_failed);
        if attempted == 0 {
            return 1.0;
        }
        (self.pages_ok as f32 / attempted as f32).clamp(0.0, 1.0)
    }

    pub fn incomplete(&self) -> bool {
        self.pages_failed > 0
    }
}

pub struct ParsedDocument {
    pub title: String,
    pub containers: Vec<ParsedContainer>,
    pub extraction: ExtractionStats,
}

impl Default for ParsedDocument {
    fn default() -> Self {
        Self {
            title: String::new(),
            containers: Vec::new(),
            extraction: ExtractionStats::default(),
        }
    }
}

pub trait DocumentParser: Send + Sync {
    fn can_parse(&self, extension: &str) -> bool;
    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParserError>;
}
