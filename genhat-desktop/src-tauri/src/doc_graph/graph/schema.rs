//! Graph node / edge schema for the structural knowledge base.

use petgraph::graph::DiGraph;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NodeType {
    Document {
        file_name: String,
        file_path: PathBuf,
        file_type: FileType,
        file_size_bytes: u64,
        modified_timestamp: u64,
    },
    Container {
        title: String,
        container_type: ContainerType,
        ordinal: usize,
    },
    ContentBlock {
        content: String,
        block_type: BlockType,
        token_count: usize,
        chunk_id: String,
    },
    Concept {
        name: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileType {
    PDF,
    DOCX,
    PPTX,
    XLSX,
    HTML,
    TXT,
}

impl FileType {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_lowercase().as_str() {
            "pdf" => Some(Self::PDF),
            "docx" => Some(Self::DOCX),
            "pptx" => Some(Self::PPTX),
            "xlsx" | "xls" | "ods" => Some(Self::XLSX),
            "html" | "htm" => Some(Self::HTML),
            "txt" | "md" | "markdown" | "json" => Some(Self::TXT),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ContainerType {
    Slide,
    Section { level: u8 },
    Sheet { name: String },
    Page { number: usize },
    DocumentRoot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BlockType {
    Paragraph,
    TableMarkdown,
    BulletListItem,
    TableCellRow,
    Header,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeData {
    pub edge_type: EdgeType,
    pub weight: f32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EdgeType {
    ParentOf,
    NextSibling,
    HasConcept,
    CrossDocLink,
}

pub type KnowledgeGraph = DiGraph<NodeType, EdgeData>;

/// Serializable knowledge-base snapshot (graph + chunk→node map + vectors).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KnowledgeBase {
    pub graph: KnowledgeGraph,
    /// Maps deterministic chunk_id → petgraph node index (as u32).
    pub chunk_to_node: HashMap<String, u32>,
    /// Dense embedding vectors aligned with `vector_chunk_ids`.
    pub vectors: Vec<Vec<f32>>,
    pub vector_chunk_ids: Vec<String>,
}

impl KnowledgeBase {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn save_graph(&self, path: &std::path::Path) -> Result<(), crate::doc_graph::errors::EngineError> {
        let bytes = bincode::serialize(self)
            .map_err(|e| crate::doc_graph::errors::EngineError::Serde(e.to_string()))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, bytes)?;
        Ok(())
    }

    pub fn load_graph(path: &std::path::Path) -> Result<Self, crate::doc_graph::errors::EngineError> {
        if !path.exists() {
            return Ok(Self::new());
        }
        let bytes = std::fs::read(path)?;
        bincode::deserialize(&bytes)
            .map_err(|e| crate::doc_graph::errors::EngineError::Serde(e.to_string()))
    }

    pub fn save_vectors(&self, path: &std::path::Path) -> Result<(), crate::doc_graph::errors::EngineError> {
        let payload = (&self.vector_chunk_ids, &self.vectors);
        let bytes = bincode::serialize(&payload)
            .map_err(|e| crate::doc_graph::errors::EngineError::Serde(e.to_string()))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, bytes)?;
        Ok(())
    }

    pub fn load_vectors(
        &mut self,
        path: &std::path::Path,
    ) -> Result<(), crate::doc_graph::errors::EngineError> {
        if !path.exists() {
            return Ok(());
        }
        let bytes = std::fs::read(path)?;
        let (ids, vectors): (Vec<String>, Vec<Vec<f32>>) = bincode::deserialize(&bytes)
            .map_err(|e| crate::doc_graph::errors::EngineError::Serde(e.to_string()))?;
        self.vector_chunk_ids = ids;
        self.vectors = vectors;
        Ok(())
    }

    pub fn stats(&self) -> KnowledgeBaseStats {
        KnowledgeBaseStats {
            nodes: self.graph.node_count(),
            edges: self.graph.edge_count(),
            chunks: self.chunk_to_node.len(),
            vectors: self.vectors.len(),
        }
    }

    /// Rebuild `chunk_to_node` after petgraph node removals (indices may shift).
    pub fn rebuild_chunk_map(&mut self) {
        self.chunk_to_node.clear();
        for idx in self.graph.node_indices() {
            if let NodeType::ContentBlock { chunk_id, .. } = &self.graph[idx] {
                self.chunk_to_node
                    .insert(chunk_id.clone(), idx.index() as u32);
            }
        }
    }

    /// Drop dense vectors that belonged to removed chunk ids.
    pub fn purge_vectors_for_chunks(&mut self, removed: &[String]) {
        if removed.is_empty() || self.vector_chunk_ids.is_empty() {
            return;
        }
        let drop: std::collections::HashSet<&str> =
            removed.iter().map(|s| s.as_str()).collect();
        let mut keep_ids = Vec::new();
        let mut keep_vecs = Vec::new();
        for (id, vec) in self
            .vector_chunk_ids
            .iter()
            .zip(self.vectors.iter())
        {
            if !drop.contains(id.as_str()) {
                keep_ids.push(id.clone());
                keep_vecs.push(vec.clone());
            }
        }
        self.vector_chunk_ids = keep_ids;
        self.vectors = keep_vecs;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBaseStats {
    pub nodes: usize,
    pub edges: usize,
    pub chunks: usize,
    pub vectors: usize,
}

/// Deterministic chunk id from filepath + ordinal + content.
pub fn make_chunk_id(file_path: &str, ordinal: usize, content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(file_path.as_bytes());
    hasher.update(b"|");
    hasher.update(ordinal.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn estimate_tokens(text: &str) -> usize {
    text.split_whitespace().count().max(1)
}
