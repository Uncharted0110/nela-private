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

pub struct ParsedDocument {
    pub title: String,
    pub containers: Vec<ParsedContainer>,
}

pub trait DocumentParser: Send + Sync {
    fn can_parse(&self, extension: &str) -> bool;
    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParserError>;
}
