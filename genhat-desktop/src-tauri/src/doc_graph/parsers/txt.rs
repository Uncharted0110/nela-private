//! Plain-text / Markdown parser — split on double newlines.

use super::traits::{DocumentParser, ParsedContainer, ParsedContentBlock, ParsedDocument};
use crate::doc_graph::errors::ParserError;
use crate::doc_graph::graph::schema::{BlockType, ContainerType};
use std::path::Path;

pub struct TxtParser;

impl DocumentParser for TxtParser {
    fn can_parse(&self, extension: &str) -> bool {
        matches!(extension, "txt" | "md" | "markdown")
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParserError> {
        let bytes = std::fs::read(path)?;
        let text = String::from_utf8_lossy(&bytes).to_string();
        let title = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("document.txt")
            .to_string();

        let paragraphs: Vec<&str> = text
            .split("\n\n")
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .collect();

        if paragraphs.is_empty() {
            return Ok(ParsedDocument {
                title,
                containers: Vec::new(),
            });
        }

        let mut containers = Vec::new();
        for (i, para) in paragraphs.iter().enumerate() {
            let is_heading = para.starts_with('#')
                || (para.len() < 80 && !para.contains('\n') && para.chars().any(|c| c.is_uppercase()));
            let block_type = if is_heading {
                BlockType::Header
            } else if para.trim_start().starts_with(['-', '*', '•']) {
                BlockType::BulletListItem
            } else {
                BlockType::Paragraph
            };

            let container_title = if is_heading {
                para.trim_start_matches('#').trim().to_string()
            } else {
                format!("Paragraph {}", i + 1)
            };

            containers.push(ParsedContainer {
                title: container_title,
                container_type: if is_heading {
                    ContainerType::Section { level: 1 }
                } else {
                    ContainerType::DocumentRoot
                },
                ordinal: i,
                blocks: vec![ParsedContentBlock {
                    content: para.to_string(),
                    block_type,
                }],
            });
        }

        Ok(ParsedDocument { title, containers })
    }
}
