//! Assemble petgraph nodes/edges from parsed documents.
//!
//! Structural edges only: `ParentOf` and `NextSibling`.
//! Concept / CrossDocLink expansion is intentionally disabled.

use crate::doc_graph::graph::schema::{
    estimate_tokens, make_chunk_id, EdgeData, EdgeType, FileType, KnowledgeBase, NodeType,
};
use crate::doc_graph::parsers::ParsedDocument;
use crate::doc_graph::search::indexer::TantivyIndex;
use petgraph::graph::NodeIndex;
use std::path::Path;
use std::time::SystemTime;

pub struct AssembledChunk {
    pub chunk_id: String,
    pub content: String,
    pub title: String,
    pub file_path: String,
    pub node_index: u32,
}

/// Lightweight chunk descriptor used for parallel Tantivy indexing
/// before petgraph node indices are known.
#[derive(Debug, Clone)]
pub struct PreparedChunk {
    pub chunk_id: String,
    pub content: String,
    pub title: String,
    pub file_path: String,
    pub ordinal: usize,
}

/// Flatten a parsed document into chunk records (deterministic chunk_ids).
pub fn prepare_chunks(path: &Path, parsed: &ParsedDocument) -> Vec<PreparedChunk> {
    let path_str = path.to_string_lossy().to_string();
    let mut out = Vec::new();
    for container in &parsed.containers {
        for (bi, block) in container.blocks.iter().enumerate() {
            let ordinal = container.ordinal * 10_000 + bi;
            let chunk_id = make_chunk_id(&path_str, ordinal, &block.content);
            out.push(PreparedChunk {
                chunk_id,
                content: block.content.clone(),
                title: container.title.clone(),
                file_path: path_str.clone(),
                ordinal,
            });
        }
    }
    out
}

/// Index prepared chunks into Tantivy (safe to call from Rayon workers).
pub fn index_prepared_chunks(
    index: &TantivyIndex,
    chunks: &[PreparedChunk],
) -> Result<(), crate::doc_graph::errors::EngineError> {
    for c in chunks {
        // node_index filled later during graph assembly; BM25 retrieval keys on chunk_id.
        index.add_chunk(&c.chunk_id, &c.file_path, &c.title, &c.content, 0)?;
    }
    Ok(())
}

/// Build structural graph nodes/edges only (no Tantivy writes, no concept linking).
pub fn assemble_graph_only(
    kb: &mut KnowledgeBase,
    path: &Path,
    parsed: &ParsedDocument,
) -> Result<Vec<AssembledChunk>, crate::doc_graph::errors::EngineError> {
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let file_type = FileType::from_extension(&ext).unwrap_or(FileType::TXT);
    let meta = std::fs::metadata(path).ok();
    let file_size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let path_str = path.to_string_lossy().to_string();

    let doc_idx = kb.graph.add_node(NodeType::Document {
        file_name,
        file_path: path.to_path_buf(),
        file_type,
        file_size_bytes: file_size,
        modified_timestamp: modified,
    });

    let mut chunks = Vec::new();
    let mut prev_container: Option<NodeIndex> = None;

    for container in &parsed.containers {
        let container_idx = kb.graph.add_node(NodeType::Container {
            title: container.title.clone(),
            container_type: container.container_type.clone(),
            ordinal: container.ordinal,
        });
        kb.graph.add_edge(
            doc_idx,
            container_idx,
            EdgeData {
                edge_type: EdgeType::ParentOf,
                weight: 1.0,
            },
        );
        if let Some(prev) = prev_container {
            kb.graph.add_edge(
                prev,
                container_idx,
                EdgeData {
                    edge_type: EdgeType::NextSibling,
                    weight: 1.0,
                },
            );
        }
        prev_container = Some(container_idx);

        let mut prev_block: Option<NodeIndex> = None;
        for (bi, block) in container.blocks.iter().enumerate() {
            let chunk_id = make_chunk_id(&path_str, container.ordinal * 10_000 + bi, &block.content);
            let block_idx = kb.graph.add_node(NodeType::ContentBlock {
                content: block.content.clone(),
                block_type: block.block_type.clone(),
                token_count: estimate_tokens(&block.content),
                chunk_id: chunk_id.clone(),
            });
            kb.graph.add_edge(
                container_idx,
                block_idx,
                EdgeData {
                    edge_type: EdgeType::ParentOf,
                    weight: 1.0,
                },
            );
            if let Some(prev) = prev_block {
                kb.graph.add_edge(
                    prev,
                    block_idx,
                    EdgeData {
                        edge_type: EdgeType::NextSibling,
                        weight: 1.0,
                    },
                );
            }
            prev_block = Some(block_idx);

            let node_u32 = block_idx.index() as u32;
            kb.chunk_to_node.insert(chunk_id.clone(), node_u32);

            chunks.push(AssembledChunk {
                chunk_id,
                content: block.content.clone(),
                title: container.title.clone(),
                file_path: path_str.clone(),
                node_index: node_u32,
            });
        }
    }

    Ok(chunks)
}

/// Remove a document subtree by absolute path. Returns deleted chunk_ids.
/// Rebuilds `chunk_to_node` afterwards because petgraph may renumber nodes.
pub fn remove_document_by_path(kb: &mut KnowledgeBase, path: &Path) -> Vec<String> {
    use petgraph::Direction;

    let target = path.to_path_buf();
    let mut doc_roots: Vec<NodeIndex> = Vec::new();
    for idx in kb.graph.node_indices() {
        if let NodeType::Document { file_path, .. } = &kb.graph[idx] {
            if file_path == &target {
                doc_roots.push(idx);
            }
        }
    }
    if doc_roots.is_empty() {
        return Vec::new();
    }

    let mut remove_set = std::collections::HashSet::new();
    let mut chunk_ids = Vec::new();
    let mut stack = doc_roots;
    while let Some(n) = stack.pop() {
        if !remove_set.insert(n) {
            continue;
        }
        if let NodeType::ContentBlock { chunk_id, .. } = &kb.graph[n] {
            chunk_ids.push(chunk_id.clone());
        }
        for child in kb.graph.neighbors_directed(n, Direction::Outgoing) {
            stack.push(child);
        }
    }

    chunk_ids.sort();
    chunk_ids.dedup();
    for id in &chunk_ids {
        kb.chunk_to_node.remove(id);
    }

    let mut nodes: Vec<NodeIndex> = remove_set.into_iter().collect();
    nodes.sort_by_key(|n| std::cmp::Reverse(n.index()));
    for n in nodes {
        if kb.graph.node_weight(n).is_some() {
            kb.graph.remove_node(n);
        }
    }

    kb.rebuild_chunk_map();
    kb.purge_vectors_for_chunks(&chunk_ids);
    chunk_ids
}

/// Legacy helper kept for callers that still pass an index (indexes then builds graph).
#[allow(dead_code)]
pub fn assemble_document(
    kb: &mut KnowledgeBase,
    index: &TantivyIndex,
    path: &Path,
    parsed: &ParsedDocument,
) -> Result<Vec<AssembledChunk>, crate::doc_graph::errors::EngineError> {
    let prepared = prepare_chunks(path, parsed);
    index_prepared_chunks(index, &prepared)?;
    assemble_graph_only(kb, path, parsed)
}
