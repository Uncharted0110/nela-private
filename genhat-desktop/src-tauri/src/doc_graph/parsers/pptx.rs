//! PPTX parser — presentation.xml ordering + slide/notes XML text frames.

use super::traits::{DocumentParser, ParsedContainer, ParsedContentBlock, ParsedDocument};
use crate::doc_graph::errors::ParserError;
use crate::doc_graph::graph::schema::{BlockType, ContainerType};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::io::{Cursor, Read};
use std::path::Path;
use zip::ZipArchive;

pub struct PptxParser;

impl DocumentParser for PptxParser {
    fn can_parse(&self, extension: &str) -> bool {
        extension == "pptx"
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParserError> {
        let file = std::fs::File::open(path)?;
        let mut archive = ZipArchive::new(file).map_err(|e| ParserError::Zip(e.to_string()))?;

        let title = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("presentation.pptx")
            .to_string();

        // Discover slide paths (prefer presentation.xml relationships order when present).
        let mut slide_names: Vec<String> = Vec::new();
        for i in 0..archive.len() {
            let name = archive
                .by_index(i)
                .map(|f| f.name().to_string())
                .unwrap_or_default();
            if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                slide_names.push(name);
            }
        }
        slide_names.sort_by(|a, b| nat_ord(a, b));

        let mut containers = Vec::new();
        for (ordinal, slide_name) in slide_names.iter().enumerate() {
            let texts = extract_texts(&mut archive, slide_name)?;
            let notes_name = format!(
                "ppt/notesSlides/notesSlide{}.xml",
                ordinal + 1
            );
            let notes = extract_texts(&mut archive, &notes_name).unwrap_or_default();

            let mut blocks: Vec<ParsedContentBlock> = texts
                .into_iter()
                .filter(|t| !t.trim().is_empty())
                .map(|content| {
                    let block_type = if content.trim_start().starts_with(['•', '-', '*']) {
                        BlockType::BulletListItem
                    } else {
                        BlockType::Paragraph
                    };
                    ParsedContentBlock {
                        content,
                        block_type,
                    }
                })
                .collect();

            for n in notes {
                let trimmed = n.trim();
                if !trimmed.is_empty() {
                    blocks.push(ParsedContentBlock {
                        content: format!("[Notes] {trimmed}"),
                        block_type: BlockType::Paragraph,
                    });
                }
            }

            if blocks.is_empty() {
                continue;
            }

            let slide_title = blocks
                .first()
                .map(|b| {
                    let t = b.content.clone();
                    if t.len() > 80 {
                        format!("{}…", &t[..80])
                    } else {
                        t
                    }
                })
                .unwrap_or_else(|| format!("Slide {}", ordinal + 1));

            containers.push(ParsedContainer {
                title: slide_title,
                container_type: ContainerType::Slide,
                ordinal,
                blocks,
            });
        }

        Ok(ParsedDocument { title, containers })
    }
}

fn extract_texts(archive: &mut ZipArchive<std::fs::File>, name: &str) -> Result<Vec<String>, ParserError> {
    let mut file = match archive.by_name(name) {
        Ok(f) => f,
        Err(_) => return Ok(Vec::new()),
    };
    let mut xml = String::new();
    file.read_to_string(&mut xml)
        .map_err(|e| ParserError::Parse(e.to_string()))?;

    let mut reader = Reader::from_reader(Cursor::new(xml.as_bytes()));
    reader.config_mut().trim_text(true);

    let mut texts = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut in_paragraph = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let local = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if local == "t" {
                    in_text = true;
                } else if local == "a" || local == "p" {
                    // DrawingML paragraphs often use <a:p>
                    if local == "p" {
                        in_paragraph = true;
                        current.clear();
                    }
                }
            }
            Ok(Event::Text(t)) if in_text => {
                current.push_str(&t.unescape().unwrap_or_default());
            }
            Ok(Event::End(e)) => {
                let local = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if local == "t" {
                    in_text = false;
                } else if local == "p" && in_paragraph {
                    in_paragraph = false;
                    let trimmed = current.trim().to_string();
                    if !trimmed.is_empty() {
                        texts.push(trimmed);
                    }
                    current.clear();
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(ParserError::Parse(e.to_string())),
            _ => {}
        }
        buf.clear();
    }

    // Fallback: if paragraph grouping failed, collect any leftover.
    if texts.is_empty() {
        let mut reader = Reader::from_reader(Cursor::new(xml.as_bytes()));
        reader.config_mut().trim_text(true);
        let mut buf = Vec::new();
        let mut all = String::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e))
                    if String::from_utf8_lossy(e.local_name().as_ref()) == "t" =>
                {
                    in_text = true;
                }
                Ok(Event::Text(t)) if in_text => {
                    all.push_str(&t.unescape().unwrap_or_default());
                    all.push(' ');
                }
                Ok(Event::End(e))
                    if String::from_utf8_lossy(e.local_name().as_ref()) == "t" =>
                {
                    in_text = false;
                }
                Ok(Event::Eof) => break,
                Err(_) => break,
                _ => {}
            }
            buf.clear();
        }
        let trimmed = all.split_whitespace().collect::<Vec<_>>().join(" ");
        if !trimmed.is_empty() {
            texts.push(trimmed);
        }
    }

    Ok(texts)
}

fn nat_ord(a: &str, b: &str) -> std::cmp::Ordering {
    let num = |s: &str| -> usize {
        s.chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or(0)
    };
    num(a).cmp(&num(b)).then_with(|| a.cmp(b))
}
