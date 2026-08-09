//! Format expanded subgraph hits into LLM-ready Markdown.
//!
//! Adaptive rules:
//! - **Small docs** (≤ [`SMALL_DOC_CHAR_THRESHOLD`] chars ≈ 3k tokens): emit the
//!   full document once under a single `### Source N: file_name` header.
//! - **Large docs**: emit parent container header + merged ±1 chunk windows.
//!
//! Overlapping windows in the same container are merged into one contiguous
//! block range. Output is capped at [`CONTEXT_CHAR_BUDGET`] characters
//! (≈ 4,000 tokens).

use crate::doc_graph::graph::schema::{KnowledgeBase, NodeType};
use crate::doc_graph::graph::traversal::{
    document_full_text, expand_context, ordered_blocks_in_container, ExpandedSource,
};
use petgraph::graph::NodeIndex;
use std::collections::{HashMap, HashSet};

/// ≈ 3,000 tokens / ~2 pages.
pub const SMALL_DOC_CHAR_THRESHOLD: usize = 12_000;
/// ≈ 4,000 tokens of assembled context.
pub const CONTEXT_CHAR_BUDGET: usize = 16_000;

#[derive(Debug, Clone)]
enum AssembledUnit {
    /// Rule A — complete small document.
    FullDocument {
        file_name: String,
        file_path: String,
        body: String,
    },
    /// Rule B — container header + contiguous merged window.
    Subgraph {
        file_name: String,
        file_path: String,
        container_label: String,
        container_title: String,
        blocks: Vec<String>,
        related_cross_doc: Vec<String>,
    },
}

/// Assemble Markdown from ranked hit chunk ids (already truncated to top_k).
pub fn assemble_markdown(kb: &KnowledgeBase, hit_chunk_ids: &[String]) -> String {
    assemble_markdown_with_budget(kb, hit_chunk_ids, CONTEXT_CHAR_BUDGET)
}

pub fn assemble_markdown_with_budget(
    kb: &KnowledgeBase,
    hit_chunk_ids: &[String],
    char_budget: usize,
) -> String {
    if hit_chunk_ids.is_empty() {
        return "No relevant structural context found.".to_string();
    }

    let mut expansions: Vec<ExpandedSource> = Vec::new();
    for id in hit_chunk_ids {
        if let Some(src) = expand_context(kb, id) {
            expansions.push(src);
        }
    }
    if expansions.is_empty() {
        return "No relevant structural context found.".to_string();
    }

    let units = merge_into_units(kb, &expansions);
    render_units(&units, char_budget)
}

fn merge_into_units(kb: &KnowledgeBase, expansions: &[ExpandedSource]) -> Vec<AssembledUnit> {
    #[derive(Clone, Copy)]
    enum UnitKey {
        SmallDoc(u32),
        LargeContainer { doc: u32, container: u32 },
    }

    let mut order: Vec<UnitKey> = Vec::new();
    let mut seen_small: HashSet<u32> = HashSet::new();
    let mut seen_large: HashSet<(u32, u32)> = HashSet::new();
    let mut large_hits: HashMap<(u32, u32), Vec<&ExpandedSource>> = HashMap::new();
    let mut small_meta: HashMap<u32, &ExpandedSource> = HashMap::new();

    for src in expansions {
        if src.document_char_len <= SMALL_DOC_CHAR_THRESHOLD {
            if seen_small.insert(src.document_index) {
                order.push(UnitKey::SmallDoc(src.document_index));
                small_meta.insert(src.document_index, src);
            }
            continue;
        }
        let key = (src.document_index, src.container_index);
        if seen_large.insert(key) {
            order.push(UnitKey::LargeContainer {
                doc: key.0,
                container: key.1,
            });
        }
        large_hits.entry(key).or_default().push(src);
    }

    let mut units = Vec::with_capacity(order.len());
    for key in order {
        match key {
            UnitKey::SmallDoc(doc_id) => {
                let Some(src) = small_meta.get(&doc_id) else {
                    continue;
                };
                let doc_idx = NodeIndex::new(doc_id as usize);
                units.push(AssembledUnit::FullDocument {
                    file_name: src.file_name.clone(),
                    file_path: src.file_path.clone(),
                    body: document_full_text(kb, doc_idx),
                });
            }
            UnitKey::LargeContainer { doc, container } => {
                let key = (doc, container);
                let Some(hits) = large_hits.get(&key) else {
                    continue;
                };
                let Some(first) = hits.first() else {
                    continue;
                };
                let container_idx = NodeIndex::new(container as usize);
                let ordered = ordered_blocks_in_container(kb, container_idx);
                let index_of: HashMap<u32, usize> = ordered
                    .iter()
                    .enumerate()
                    .map(|(i, n)| (n.index() as u32, i))
                    .collect();

                let mut positions: Vec<usize> = Vec::new();
                for hit in hits {
                    for &bi in &hit.window_block_indices {
                        if let Some(&pos) = index_of.get(&bi) {
                            positions.push(pos);
                        }
                    }
                }
                if positions.is_empty() {
                    continue;
                }
                positions.sort_unstable();
                positions.dedup();
                let start = *positions.first().unwrap();
                let end = *positions.last().unwrap();

                let mut blocks = Vec::new();
                for n in &ordered[start..=end] {
                    if let NodeType::ContentBlock { content, .. } = &kb.graph[*n] {
                        let t = content.trim();
                        if !t.is_empty() {
                            blocks.push(t.to_string());
                        }
                    }
                }

                let mut related = Vec::new();
                let mut seen_rel = HashSet::new();
                for hit in hits {
                    for rel in &hit.related_cross_doc {
                        if seen_rel.insert(rel.clone()) {
                            related.push(rel.clone());
                        }
                    }
                }

                units.push(AssembledUnit::Subgraph {
                    file_name: first.file_name.clone(),
                    file_path: first.file_path.clone(),
                    container_label: first.container_label.clone(),
                    container_title: first.container_title.clone(),
                    blocks,
                    related_cross_doc: related,
                });
            }
        }
    }

    units
}

fn render_units(units: &[AssembledUnit], char_budget: usize) -> String {
    if units.is_empty() {
        return "No relevant structural context found.".to_string();
    }

    let mut out = String::new();
    let mut source_no = 0usize;

    for unit in units {
        let piece = match unit {
            AssembledUnit::FullDocument {
                file_name,
                file_path,
                body,
            } => {
                source_no += 1;
                format!(
                    "### Source {source_no}: {file_name}\n\
                     - **Location:** Full document (File: {file_path})\n\
                     - **Context:**\n{body}\n"
                )
            }
            AssembledUnit::Subgraph {
                file_name,
                file_path,
                container_label,
                container_title,
                blocks,
                related_cross_doc,
            } => {
                source_no += 1;
                let mut s = format!(
                    "### Source {source_no}: {file_name} > {container_label}: {container_title}\n\
                     - **Location:** {container_label} (File: {file_path})\n\
                     - **Context:**\n"
                );
                for block in blocks {
                    for line in block.lines() {
                        s.push_str(&format!("  - {}\n", line.trim()));
                    }
                }
                if !related_cross_doc.is_empty() {
                    s.push_str("- **Related (cross-doc):**\n");
                    for rel in related_cross_doc {
                        s.push_str(&format!("  - {rel}\n"));
                    }
                }
                s
            }
        };

        let sep = if out.is_empty() {
            String::new()
        } else {
            "\n---\n\n".to_string()
        };
        let addition = format!("{sep}{piece}");
        if out.chars().count() + addition.chars().count() > char_budget {
            let remaining = char_budget.saturating_sub(out.chars().count());
            if remaining > 80 {
                // Truncate cleanly on a character boundary.
                let truncated: String = addition.chars().take(remaining.saturating_sub(1)).collect();
                out.push_str(&truncated);
                out.push('…');
            }
            break;
        }
        out.push_str(&addition);
    }

    if out.is_empty() {
        "No relevant structural context found.".to_string()
    } else {
        out
    }
}

/// Backward-compatible helper used by older call sites that already expanded hits.
pub fn assemble_markdown_from_sources(sources: &[ExpandedSource]) -> String {
    if sources.is_empty() {
        return "No relevant structural context found.".to_string();
    }
    // Without a KB we cannot re-merge windows / load full docs — fall back to
    // a budgeted concatenation of the pre-expanded windows.
    let mut fake_units = Vec::new();
    let mut seen_small: HashSet<u32> = HashSet::new();
    for src in sources {
        if src.document_char_len <= SMALL_DOC_CHAR_THRESHOLD {
            if seen_small.insert(src.document_index) {
                fake_units.push(AssembledUnit::FullDocument {
                    file_name: src.file_name.clone(),
                    file_path: src.file_path.clone(),
                    body: src.context_blocks.join("\n\n"),
                });
            }
        } else {
            fake_units.push(AssembledUnit::Subgraph {
                file_name: src.file_name.clone(),
                file_path: src.file_path.clone(),
                container_label: src.container_label.clone(),
                container_title: src.container_title.clone(),
                blocks: src.context_blocks.clone(),
                related_cross_doc: src.related_cross_doc.clone(),
            });
        }
    }
    render_units(&fake_units, CONTEXT_CHAR_BUDGET)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_truncates() {
        let units = vec![AssembledUnit::FullDocument {
            file_name: "a.txt".into(),
            file_path: "/a.txt".into(),
            body: "x".repeat(500),
        }];
        let out = render_units(&units, 120);
        assert!(out.chars().count() <= 120);
        assert!(out.ends_with('…') || out.chars().count() < 120);
    }
}
