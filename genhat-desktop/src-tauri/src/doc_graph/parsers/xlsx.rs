//! XLSX / spreadsheet parser via calamine.

use super::traits::{DocumentParser, ParsedContainer, ParsedContentBlock, ParsedDocument};
use crate::doc_graph::errors::ParserError;
use crate::doc_graph::graph::schema::{BlockType, ContainerType};
use calamine::{open_workbook_auto, Data, Reader};
use std::path::Path;

pub struct XlsxParser;

impl DocumentParser for XlsxParser {
    fn can_parse(&self, extension: &str) -> bool {
        matches!(extension, "xlsx" | "xls" | "ods")
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParserError> {
        let mut workbook = open_workbook_auto(path)
            .map_err(|e| ParserError::Parse(format!("calamine open failed: {e}")))?;

        let title = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("workbook.xlsx")
            .to_string();

        let sheet_names = workbook.sheet_names().to_vec();
        let mut containers = Vec::new();

        for (ordinal, sheet_name) in sheet_names.into_iter().enumerate() {
            let Ok(range) = workbook.worksheet_range(&sheet_name) else {
                continue;
            };

            let mut rows: Vec<String> = Vec::new();
            for row in range.rows() {
                let cells: Vec<String> = row
                    .iter()
                    .map(|c| match c {
                        Data::Empty => String::new(),
                        Data::String(s) => s.clone(),
                        Data::Float(f) => f.to_string(),
                        Data::Int(i) => i.to_string(),
                        Data::Bool(b) => b.to_string(),
                        Data::DateTime(dt) => format!("{dt:?}"),
                        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
                        Data::Error(e) => format!("ERR:{e:?}"),
                    })
                    .collect();
                if cells.iter().any(|c| !c.trim().is_empty()) {
                    rows.push(cells.join(" | "));
                }
            }

            if rows.is_empty() {
                continue;
            }

            let markdown = if rows.len() > 1 {
                let header = &rows[0];
                let sep = header
                    .split(" | ")
                    .map(|_| "---")
                    .collect::<Vec<_>>()
                    .join(" | ");
                let mut md = format!("| {header} |\n| {sep} |\n");
                for r in rows.iter().skip(1) {
                    md.push_str(&format!("| {r} |\n"));
                }
                md
            } else {
                rows.join("\n")
            };

            containers.push(ParsedContainer {
                title: sheet_name.clone(),
                container_type: ContainerType::Sheet {
                    name: sheet_name,
                },
                ordinal,
                blocks: vec![ParsedContentBlock {
                    content: markdown,
                    block_type: BlockType::TableMarkdown,
                }],
            });
        }

        Ok(ParsedDocument { title, containers, ..Default::default() })
    }
}
