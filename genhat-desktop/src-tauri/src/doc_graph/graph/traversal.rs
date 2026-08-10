//! Subgraph traversal: parent scope, sibling windows, cross-doc concepts.

use super::schema::{ContainerType, EdgeType, KnowledgeBase, NodeType};
use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;
use petgraph::Direction;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpandedSource {
    pub chunk_id: String,
    pub file_path: String,
    pub file_name: String,
    pub container_title: String,
    pub container_label: String,
    /// Petgraph index of the parent container (for hit merging).
    pub container_index: u32,
    /// Petgraph index of the document root.
    pub document_index: u32,
    /// Ordered ContentBlock indices in the ±radius window (same container only).
    pub window_block_indices: Vec<u32>,
    pub context_blocks: Vec<String>,
    /// Total character length of all ContentBlocks under this document.
    pub document_char_len: usize,
    pub related_cross_doc: Vec<String>,
}

/// Ordered ContentBlocks under `container`, preferring the `NextSibling` chain.
pub fn ordered_blocks_in_container(kb: &KnowledgeBase, container: NodeIndex) -> Vec<NodeIndex> {
    let mut blocks: Vec<NodeIndex> = kb
        .graph
        .neighbors_directed(container, Direction::Outgoing)
        .filter(|n| matches!(kb.graph[*n], NodeType::ContentBlock { .. }))
        .collect();
    if blocks.is_empty() {
        return blocks;
    }

    let block_set: HashSet<NodeIndex> = blocks.iter().copied().collect();
    let mut has_prev: HashSet<NodeIndex> = HashSet::new();
    for &b in &blocks {
        for e in kb.graph.edges_directed(b, Direction::Incoming) {
            if e.weight().edge_type == EdgeType::NextSibling && block_set.contains(&e.source()) {
                has_prev.insert(b);
            }
        }
    }

    let head = blocks.iter().copied().find(|b| !has_prev.contains(b));
    if let Some(mut cur) = head {
        let mut ordered = vec![cur];
        loop {
            let next = kb
                .graph
                .edges_directed(cur, Direction::Outgoing)
                .find(|e| {
                    e.weight().edge_type == EdgeType::NextSibling
                        && block_set.contains(&e.target())
                })
                .map(|e| e.target());
            match next {
                Some(n) if !ordered.contains(&n) => {
                    ordered.push(n);
                    cur = n;
                }
                _ => break,
            }
        }
        if ordered.len() == blocks.len() {
            return ordered;
        }
    }

    blocks.sort_by_key(|n| n.index());
    blocks
}

/// Retrieve ContentBlocks within `radius` of `hit_idx` **inside the same parent
/// container**. Does not cross container boundaries (e.g. Slide 1 ↛ Slide 2).
pub fn get_chunk_window(
    kb: &KnowledgeBase,
    hit_idx: NodeIndex,
    radius: usize,
) -> Vec<NodeIndex> {
    if kb.graph.node_weight(hit_idx).is_none() {
        return Vec::new();
    }
    if !matches!(kb.graph[hit_idx], NodeType::ContentBlock { .. }) {
        return Vec::new();
    }

    let Some(container) = parent_container(kb, hit_idx) else {
        return vec![hit_idx];
    };

    let ordered = ordered_blocks_in_container(kb, container);
    if ordered.is_empty() {
        return vec![hit_idx];
    }

    let focus_pos = ordered.iter().position(|n| *n == hit_idx).unwrap_or(0);
    let start = focus_pos.saturating_sub(radius);
    let end = (focus_pos + radius + 1).min(ordered.len());
    ordered[start..end].to_vec()
}

pub fn expand_context(kb: &KnowledgeBase, chunk_id: &str) -> Option<ExpandedSource> {
    let node_u32 = *kb.chunk_to_node.get(chunk_id)?;
    let block_idx = NodeIndex::new(node_u32 as usize);
    if kb.graph.node_weight(block_idx).is_none() {
        return None;
    }

    let NodeType::ContentBlock { content, .. } = &kb.graph[block_idx] else {
        return None;
    };

    let container_idx = parent_container(kb, block_idx)?;
    let (container_title, container_label) = match &kb.graph[container_idx] {
        NodeType::Container {
            title,
            container_type,
            ordinal,
            ..
        } => {
            let label = match container_type {
                ContainerType::Slide => format!("Slide {}", ordinal + 1),
                ContainerType::Section { level } => format!("Heading Level {level}"),
                ContainerType::Sheet { name } => format!("Sheet: {name}"),
                ContainerType::Page { number } => format!("Page {number}"),
                ContainerType::DocumentRoot => "Document".to_string(),
            };
            (title.clone(), label)
        }
        _ => ("Unknown".into(), "Unknown".into()),
    };

    let document_idx = parent_document(kb, container_idx)?;
    let (file_path, file_name) = match &kb.graph[document_idx] {
        NodeType::Document {
            file_path: fp,
            file_name: fnm,
            ..
        } => (fp.to_string_lossy().to_string(), fnm.clone()),
        _ => (String::new(), String::new()),
    };

    let window = get_chunk_window(kb, block_idx, 1);
    let mut context_blocks = Vec::with_capacity(window.len());
    let mut window_block_indices = Vec::with_capacity(window.len());
    for n in &window {
        window_block_indices.push(n.index() as u32);
        if let NodeType::ContentBlock { content: c, .. } = &kb.graph[*n] {
            context_blocks.push(c.clone());
        }
    }
    if context_blocks.is_empty() {
        context_blocks.push(content.clone());
        window_block_indices.push(block_idx.index() as u32);
    }

    let document_char_len = document_char_length(kb, document_idx);

    // Cross-doc via concepts
    let mut related_cross_doc = Vec::new();
    for concept in kb.graph.neighbors_directed(block_idx, Direction::Outgoing) {
        if !matches!(kb.graph[concept], NodeType::Concept { .. }) {
            continue;
        }
        for other in kb.graph.neighbors_directed(concept, Direction::Incoming) {
            if other == block_idx {
                continue;
            }
            if let NodeType::ContentBlock {
                content: c,
                chunk_id: oid,
                ..
            } = &kb.graph[other]
            {
                let different = file_of(kb, other).map(|f| f != file_path).unwrap_or(false);
                let has_cross = kb.graph.edges_connecting(block_idx, other).any(|e| {
                    e.weight().edge_type == EdgeType::CrossDocLink
                }) || kb.graph.edges_connecting(other, block_idx).any(|e| {
                    e.weight().edge_type == EdgeType::CrossDocLink
                });
                if different || has_cross {
                    related_cross_doc.push(format!("{oid}: {}", truncate(c, 160)));
                    if related_cross_doc.len() >= 3 {
                        break;
                    }
                }
            }
        }
        if related_cross_doc.len() >= 3 {
            break;
        }
    }

    Some(ExpandedSource {
        chunk_id: chunk_id.to_string(),
        file_path,
        file_name,
        container_title,
        container_label,
        container_index: container_idx.index() as u32,
        document_index: document_idx.index() as u32,
        window_block_indices,
        context_blocks,
        document_char_len,
        related_cross_doc,
    })
}

/// All ContentBlock text under a document, containers ordered by NextSibling.
pub fn document_full_text(kb: &KnowledgeBase, document_idx: NodeIndex) -> String {
    let containers = ordered_containers(kb, document_idx);
    let mut parts: Vec<String> = Vec::new();
    for container in containers {
        if let NodeType::Container { title, .. } = &kb.graph[container] {
            if !title.trim().is_empty() {
                parts.push(format!("## {title}"));
            }
        }
        for block in ordered_blocks_in_container(kb, container) {
            if let NodeType::ContentBlock { content, .. } = &kb.graph[block] {
                let t = content.trim();
                if !t.is_empty() {
                    parts.push(t.to_string());
                }
            }
        }
    }
    parts.join("\n\n")
}

pub fn document_char_length(kb: &KnowledgeBase, document_idx: NodeIndex) -> usize {
    let mut total = 0usize;
    for container in kb.graph.neighbors_directed(document_idx, Direction::Outgoing) {
        if !matches!(kb.graph[container], NodeType::Container { .. }) {
            continue;
        }
        for block in kb.graph.neighbors_directed(container, Direction::Outgoing) {
            if let NodeType::ContentBlock { content, .. } = &kb.graph[block] {
                total += content.chars().count();
            }
        }
    }
    total
}

fn ordered_containers(kb: &KnowledgeBase, document_idx: NodeIndex) -> Vec<NodeIndex> {
    let mut containers: Vec<NodeIndex> = kb
        .graph
        .neighbors_directed(document_idx, Direction::Outgoing)
        .filter(|n| matches!(kb.graph[*n], NodeType::Container { .. }))
        .collect();
    if containers.is_empty() {
        return containers;
    }

    let set: HashSet<NodeIndex> = containers.iter().copied().collect();
    let mut has_prev: HashSet<NodeIndex> = HashSet::new();
    for &c in &containers {
        for e in kb.graph.edges_directed(c, Direction::Incoming) {
            if e.weight().edge_type == EdgeType::NextSibling && set.contains(&e.source()) {
                has_prev.insert(c);
            }
        }
    }
    let head = containers.iter().copied().find(|c| !has_prev.contains(c));
    if let Some(mut cur) = head {
        let mut ordered = vec![cur];
        loop {
            let next = kb
                .graph
                .edges_directed(cur, Direction::Outgoing)
                .find(|e| {
                    e.weight().edge_type == EdgeType::NextSibling && set.contains(&e.target())
                })
                .map(|e| e.target());
            match next {
                Some(n) if !ordered.contains(&n) => {
                    ordered.push(n);
                    cur = n;
                }
                _ => break,
            }
        }
        if ordered.len() == containers.len() {
            return ordered;
        }
    }

    containers.sort_by_key(|n| match &kb.graph[*n] {
        NodeType::Container { ordinal, .. } => *ordinal,
        _ => n.index(),
    });
    containers
}

pub fn parent_container(kb: &KnowledgeBase, block_idx: NodeIndex) -> Option<NodeIndex> {
    for n in kb.graph.neighbors_directed(block_idx, Direction::Incoming) {
        if matches!(kb.graph[n], NodeType::Container { .. }) {
            return Some(n);
        }
    }
    None
}

pub fn parent_document(kb: &KnowledgeBase, container_idx: NodeIndex) -> Option<NodeIndex> {
    for n in kb.graph.neighbors_directed(container_idx, Direction::Incoming) {
        if matches!(kb.graph[n], NodeType::Document { .. }) {
            return Some(n);
        }
    }
    None
}

fn file_of(kb: &KnowledgeBase, block: NodeIndex) -> Option<String> {
    let container = parent_container(kb, block)?;
    let doc = parent_document(kb, container)?;
    if let NodeType::Document { file_path, .. } = &kb.graph[doc] {
        return Some(file_path.to_string_lossy().to_string());
    }
    None
}

/// Resolve the on-disk path for a content chunk (for live-staleness checks).
pub fn file_path_for_chunk(kb: &KnowledgeBase, chunk_id: &str) -> Option<String> {
    let node_u32 = *kb.chunk_to_node.get(chunk_id)?;
    let block_idx = NodeIndex::new(node_u32 as usize);
    file_of(kb, block_idx)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc_graph::graph::schema::{
        BlockType, ContainerType, EdgeData, EdgeType, FileType, NodeType,
    };
    use std::path::PathBuf;

    fn tiny_kb() -> (KnowledgeBase, NodeIndex, NodeIndex, NodeIndex) {
        let mut kb = KnowledgeBase::new();
        let doc = kb.graph.add_node(NodeType::Document {
            file_name: "deck.pptx".into(),
            file_path: PathBuf::from("/tmp/deck.pptx"),
            file_type: FileType::PPTX,
            file_size_bytes: 1,
            modified_timestamp: 0,
        });
        let c1 = kb.graph.add_node(NodeType::Container {
            title: "Intro".into(),
            container_type: ContainerType::Slide,
            ordinal: 0,
        });
        let c2 = kb.graph.add_node(NodeType::Container {
            title: "Next".into(),
            container_type: ContainerType::Slide,
            ordinal: 1,
        });
        kb.graph.add_edge(
            doc,
            c1,
            EdgeData {
                edge_type: EdgeType::ParentOf,
                weight: 1.0,
            },
        );
        kb.graph.add_edge(
            doc,
            c2,
            EdgeData {
                edge_type: EdgeType::ParentOf,
                weight: 1.0,
            },
        );
        kb.graph.add_edge(
            c1,
            c2,
            EdgeData {
                edge_type: EdgeType::NextSibling,
                weight: 1.0,
            },
        );

        let mut prev = None;
        let mut blocks = Vec::new();
        for (i, text) in ["A", "B", "C"].iter().enumerate() {
            let b = kb.graph.add_node(NodeType::ContentBlock {
                content: text.to_string(),
                block_type: BlockType::Paragraph,
                token_count: 1,
                chunk_id: format!("c1-{i}"),
            });
            kb.graph.add_edge(
                c1,
                b,
                EdgeData {
                    edge_type: EdgeType::ParentOf,
                    weight: 1.0,
                },
            );
            if let Some(p) = prev {
                kb.graph.add_edge(
                    p,
                    b,
                    EdgeData {
                        edge_type: EdgeType::NextSibling,
                        weight: 1.0,
                    },
                );
            }
            prev = Some(b);
            blocks.push(b);
        }
        // Block on slide 2 — must not enter slide-1 windows.
        let other = kb.graph.add_node(NodeType::ContentBlock {
            content: "OTHER".into(),
            block_type: BlockType::Paragraph,
            token_count: 1,
            chunk_id: "c2-0".into(),
        });
        kb.graph.add_edge(
            c2,
            other,
            EdgeData {
                edge_type: EdgeType::ParentOf,
                weight: 1.0,
            },
        );

        (kb, blocks[0], blocks[1], blocks[2])
    }

    #[test]
    fn chunk_window_stays_inside_container() {
        let (kb, a, b, c) = tiny_kb();
        let win = get_chunk_window(&kb, b, 1);
        assert_eq!(win, vec![a, b, c]);
        let texts: Vec<_> = win
            .iter()
            .filter_map(|n| match &kb.graph[*n] {
                NodeType::ContentBlock { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert!(!texts.contains(&"OTHER"));
    }

    #[test]
    fn chunk_window_edge_clamps() {
        let (kb, a, b, _) = tiny_kb();
        let win = get_chunk_window(&kb, a, 1);
        assert_eq!(win, vec![a, b]);
    }
}
