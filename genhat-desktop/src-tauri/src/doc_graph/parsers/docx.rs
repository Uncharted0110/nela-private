//! DOCX parser — zip + quick-xml streaming of word/document.xml.

use super::traits::{DocumentParser, ParsedContainer, ParsedContentBlock, ParsedDocument};
use crate::doc_graph::errors::ParserError;
use crate::doc_graph::graph::schema::{BlockType, ContainerType};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::io::{Cursor, Read};
use std::path::Path;
use zip::ZipArchive;

pub struct DocxParser;

impl DocumentParser for DocxParser {
    fn can_parse(&self, extension: &str) -> bool {
        extension == "docx"
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParserError> {
        let file = std::fs::File::open(path)?;
        let mut archive = ZipArchive::new(file).map_err(|e| ParserError::Zip(e.to_string()))?;
        let mut xml_file = archive
            .by_name("word/document.xml")
            .map_err(|e| ParserError::Zip(format!("missing word/document.xml: {e}")))?;
        let mut xml = String::new();
        xml_file
            .read_to_string(&mut xml)
            .map_err(|e| ParserError::Parse(e.to_string()))?;

        let title = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("document.docx")
            .to_string();

        let mut reader = Reader::from_reader(Cursor::new(xml.as_bytes()));
        reader.config_mut().trim_text(true);

        let mut containers: Vec<ParsedContainer> = Vec::new();
        let mut current_blocks: Vec<ParsedContentBlock> = Vec::new();
        let mut current_title = "Document".to_string();
        let mut current_type = ContainerType::DocumentRoot;
        let mut ordinal = 0usize;
        let mut started = false;

        let mut in_paragraph = false;
        let mut in_text = false;
        let mut para_text = String::new();
        let mut heading_level: Option<u8> = None;
        let mut buf = Vec::new();

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) => {
                    let local = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                    match local.as_str() {
                        "p" => {
                            in_paragraph = true;
                            para_text.clear();
                            heading_level = None;
                        }
                        "t" => in_text = true,
                        "pStyle" => {
                            for attr in e.attributes().flatten() {
                                let local = attr.key.local_name();
                                let key = String::from_utf8_lossy(local.as_ref());
                                if key == "val" {
                                    let val = attr
                                        .decode_and_unescape_value(reader.decoder())
                                        .map(|v| v.to_string())
                                        .unwrap_or_default();
                                    if let Some(rest) = val.strip_prefix("Heading") {
                                        if let Ok(level) = rest.parse::<u8>() {
                                            heading_level = Some(level.clamp(1, 6));
                                        }
                                    } else if val.eq_ignore_ascii_case("Title") {
                                        heading_level = Some(1);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Event::Text(t)) if in_text => {
                    para_text.push_str(&t.unescape().unwrap_or_default());
                }
                Ok(Event::End(e)) => {
                    let local = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                    match local.as_str() {
                        "t" => in_text = false,
                        "p" if in_paragraph => {
                            in_paragraph = false;
                            let text = para_text.trim().to_string();
                            if text.is_empty() {
                                continue;
                            }
                            if let Some(level) = heading_level {
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
                                current_title = text.clone();
                                current_type = ContainerType::Section { level };
                                current_blocks.push(ParsedContentBlock {
                                    content: text,
                                    block_type: BlockType::Header,
                                });
                            } else {
                                started = true;
                                let block_type = if text.starts_with(['•', '-', '*']) {
                                    BlockType::BulletListItem
                                } else {
                                    BlockType::Paragraph
                                };
                                current_blocks.push(ParsedContentBlock {
                                    content: text,
                                    block_type,
                                });
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => return Err(ParserError::Parse(e.to_string())),
                _ => {}
            }
            buf.clear();
        }

        if !current_blocks.is_empty() || started {
            containers.push(ParsedContainer {
                title: current_title,
                container_type: current_type,
                ordinal,
                blocks: current_blocks,
            });
        }

        Ok(ParsedDocument { title, containers })
    }
}
