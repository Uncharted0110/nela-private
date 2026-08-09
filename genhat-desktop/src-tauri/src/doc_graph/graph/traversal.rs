//! Subgraph traversal: parent scope, siblings, cross-doc concepts.

use super::schema::{ContainerType, EdgeType, KnowledgeBase, NodeType};
use petgraph::graph::NodeIndex;
use petgraph::Direction;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpandedSource {
    pub chunk_id: String,
    pub file_path: String,
    pub file_name: String,
    pub container_title: String,
    pub container_label: String,
    pub context_blocks: Vec<String>,
    pub related_cross_doc: Vec<String>,
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

    // Walk up to container + document
    let mut container_idx: Option<NodeIndex> = None;
    for n in kb.graph.neighbors_directed(block_idx, Direction::Incoming) {
        if matches!(kb.graph[n], NodeType::Container { .. }) {
            container_idx = Some(n);
            break;
        }
    }
    let container_idx = container_idx?;

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

    let mut file_path = String::new();
    let mut file_name = String::new();
    for n in kb.graph.neighbors_directed(container_idx, Direction::Incoming) {
        if let NodeType::Document {
            file_path: fp,
            file_name: fnm,
            ..
        } = &kb.graph[n]
        {
            file_path = fp.to_string_lossy().to_string();
            file_name = fnm.clone();
            break;
        }
    }

    // Sibling expansion
    let mut context_blocks = Vec::new();
    let mut ordered_siblings: Vec<NodeIndex> = Vec::new();

    // Find all content blocks under this container
    for n in kb.graph.neighbors_directed(container_idx, Direction::Outgoing) {
        if matches!(kb.graph[n], NodeType::ContentBlock { .. }) {
            ordered_siblings.push(n);
        }
    }
    // Prefer NextSibling chain order when available; otherwise insertion order.
    if ordered_siblings.is_empty() {
        ordered_siblings.push(block_idx);
    }

    let focus_pos = ordered_siblings
        .iter()
        .position(|n| *n == block_idx)
        .unwrap_or(0);
    let start = focus_pos.saturating_sub(1);
    let end = (focus_pos + 2).min(ordered_siblings.len());
    for n in &ordered_siblings[start..end] {
        if let NodeType::ContentBlock { content: c, .. } = &kb.graph[*n] {
            context_blocks.push(c.clone());
        }
    }
    if context_blocks.is_empty() {
        context_blocks.push(content.clone());
    }

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
                // Only include if CrossDocLink or different file
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
        context_blocks,
        related_cross_doc,
    })
}

fn file_of(kb: &KnowledgeBase, block: NodeIndex) -> Option<String> {
    for container in kb.graph.neighbors_directed(block, Direction::Incoming) {
        if matches!(kb.graph[container], NodeType::Container { .. }) {
            for doc in kb.graph.neighbors_directed(container, Direction::Incoming) {
                if let NodeType::Document { file_path, .. } = &kb.graph[doc] {
                    return Some(file_path.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}
