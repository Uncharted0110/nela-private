//! Path-keyed fingerprint manifest for incremental doc-graph sync.
//!
//! On each scan we compare discovered files against stored `(size, mtime)` and
//! only re-parse / re-index paths that are new or changed. Deleted paths are
//! purged from the graph + Tantivy.

use crate::doc_graph::errors::EngineError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const MANIFEST_FILE: &str = "file_manifest.bin";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileFingerprint {
    pub size: u64,
    pub mtime_secs: u64,
}

impl FileFingerprint {
    pub fn from_path(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        let mtime_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Some(Self {
            size: meta.len(),
            mtime_secs,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IndexManifest {
    /// Canonical root last synced (usually $HOME).
    pub root: String,
    /// Absolute path string → fingerprint at last successful index.
    pub files: HashMap<String, FileFingerprint>,
}

impl IndexManifest {
    pub fn load(data_dir: &Path) -> Result<Self, EngineError> {
        let path = data_dir.join(MANIFEST_FILE);
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = std::fs::read(&path)?;
        bincode::deserialize(&bytes).map_err(|e| EngineError::Serde(e.to_string()))
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), EngineError> {
        let path = data_dir.join(MANIFEST_FILE);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = bincode::serialize(self).map_err(|e| EngineError::Serde(e.to_string()))?;
        std::fs::write(path, bytes)?;
        Ok(())
    }

    pub fn key(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    pub fn upsert(&mut self, path: &Path, fp: FileFingerprint) {
        self.files.insert(Self::key(path), fp);
    }

    pub fn remove(&mut self, path: &Path) {
        self.files.remove(&Self::key(path));
    }

    pub fn matches(&self, path: &Path, fp: &FileFingerprint) -> bool {
        self.files
            .get(&Self::key(path))
            .map(|stored| stored == fp)
            .unwrap_or(false)
    }
}

/// Classify discovered paths against the manifest.
pub struct SyncPlan {
    pub to_index: Vec<PathBuf>,
    pub to_remove: Vec<PathBuf>,
    pub unchanged: usize,
}

pub fn plan_sync(discovered: &[PathBuf], manifest: &IndexManifest) -> SyncPlan {
    let mut to_index = Vec::new();
    let mut unchanged = 0usize;
    let mut seen = std::collections::HashSet::new();

    for path in discovered {
        let key = IndexManifest::key(path);
        seen.insert(key.clone());
        match FileFingerprint::from_path(path) {
            Some(fp) if manifest.matches(path, &fp) => unchanged += 1,
            Some(_) | None => to_index.push(path.clone()),
        }
    }

    let to_remove: Vec<PathBuf> = manifest
        .files
        .keys()
        .filter(|k| !seen.contains(*k))
        .map(PathBuf::from)
        .collect();

    SyncPlan {
        to_index,
        to_remove,
        unchanged,
    }
}
