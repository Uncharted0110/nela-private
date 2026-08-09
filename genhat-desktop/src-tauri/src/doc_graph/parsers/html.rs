//! HTML DOM parser via scraper.

use super::traits::{DocumentParser, ParsedContainer, ParsedContentBlock, ParsedDocument};
use crate::doc_graph::errors::ParserError;
use crate::doc_graph::graph::schema::{BlockType, ContainerType};
use scraper::{Html, Selector};
use std::path::Path;

pub struct HtmlParser;

impl DocumentParser for HtmlParser {
    fn can_parse(&self, extension: &str) -> bool {
        matches!(extension, "html" | "htm")
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParserError> {
        let html = std::fs::read_to_string(path)?;
        let title = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("document.html")
            .to_string();

        let document = Html::parse_document(&html);
        let body_sel = Selector::parse("body").map_err(|e| ParserError::Parse(e.to_string()))?;
        let root = document.select(&body_sel).next();

        let mut containers: Vec<ParsedContainer> = Vec::new();
        let mut current_blocks: Vec<ParsedContentBlock> = Vec::new();
        let mut current_title = "Document".to_string();
        let mut current_type = ContainerType::DocumentRoot;
        let mut ordinal = 0usize;
        let mut started = false;

        let content_sel = Selector::parse("h1, h2, h3, h4, h5, h6, p, li, table").map_err(|e| {
            ParserError::Parse(e.to_string())
        })?;

        let scope = root.map(|r| r.html()).unwrap_or_else(|| html.clone());
        let scoped = Html::parse_fragment(&scope);

        for el in scoped.select(&content_sel) {
            let name = el.value().name().to_lowercase();

            if matches!(name.as_str(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
                if started {
                    containers.push(ParsedContainer {
                        title: current_title.clone(),
                        container_type: current_type.clone(),
                        ordinal,
                        blocks: std::mem::take(&mut current_blocks),
                    });
                    ordinal += 1;
                }
                started = true;
                let level = name.chars().nth(1).and_then(|c| c.to_digit(10)).unwrap_or(1) as u8;
                current_title = el.text().collect::<String>().trim().to_string();
                if current_title.is_empty() {
                    current_title = format!("Section {ordinal}");
                }
                current_type = ContainerType::Section { level };
                current_blocks.push(ParsedContentBlock {
                    content: current_title.clone(),
                    block_type: BlockType::Header,
                });
            } else if name == "li" {
                started = true;
                let text = el.text().collect::<String>().trim().to_string();
                if !text.is_empty() {
                    current_blocks.push(ParsedContentBlock {
                        content: text,
                        block_type: BlockType::BulletListItem,
                    });
                }
            } else if name == "table" {
                started = true;
                let tr_sel = Selector::parse("tr").unwrap();
                let cell_sel = Selector::parse("th, td").unwrap();
                let rows: Vec<String> = el
                    .select(&tr_sel)
                    .map(|tr| {
                        tr.select(&cell_sel)
                            .map(|c| c.text().collect::<String>().trim().to_string())
                            .filter(|t| !t.is_empty())
                            .collect::<Vec<_>>()
                            .join(" | ")
                    })
                    .filter(|r| !r.is_empty())
                    .collect();
                if !rows.is_empty() {
                    current_blocks.push(ParsedContentBlock {
                        content: format!("| {} |", rows.join(" |\n| ")),
                        block_type: BlockType::TableMarkdown,
                    });
                }
            } else if name == "p" {
                started = true;
                let text = el.text().collect::<String>().trim().to_string();
                if !text.is_empty() {
                    current_blocks.push(ParsedContentBlock {
                        content: text,
                        block_type: BlockType::Paragraph,
                    });
                }
            }
        }

        if !current_blocks.is_empty() || started {
            containers.push(ParsedContainer {
                title: current_title,
                container_type: current_type,
                ordinal,
                blocks: current_blocks,
            });
        }

        if containers.is_empty() {
            let fallback = document.root_element().text().collect::<String>();
            let trimmed = fallback.split_whitespace().collect::<Vec<_>>().join(" ");
            if !trimmed.is_empty() {
                containers.push(ParsedContainer {
                    title: "Document".into(),
                    container_type: ContainerType::DocumentRoot,
                    ordinal: 0,
                    blocks: vec![ParsedContentBlock {
                        content: trimmed,
                        block_type: BlockType::Paragraph,
                    }],
                });
            }
        }

        Ok(ParsedDocument { title, containers })
    }
}
