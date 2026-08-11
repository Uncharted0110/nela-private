//! Path-keyed fingerprint manifest for incremental doc-graph sync.
//!
//! On each scan we compare discovered files against stored `(size, mtime)` and
//! only re-parse / re-index paths that are new or changed. Deleted paths are
//! purged from the graph + Tantivy.
//!
//! Schema v2 adds per-file extraction quality so incomplete / pre-v2 PDFs are
//! automatically re-parsed on the next directory sync.

use crate::doc_graph::errors::EngineError;
use crate::doc_graph::parsers::traits::ExtractionStats;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const MANIFEST_FILE: &str = "file_manifest.bin";
/// Bump when ingest semantics change enough that stored fingerprints must re-parse.
pub const MANIFEST_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileFingerprint {
    pub size: u64,
    pub mtime_secs: u64,
    /// Fraction of pages successfully extracted (1.0 = complete / non-PDF).
    #[serde(default = "default_quality")]
    pub extracted_quality_ratio: f32,
    #[serde(default)]
    pub pages_ok: u32,
    #[serde(default)]
    pub pages_total: u32,
    /// True when any page failed or page count looks incomplete.
    #[serde(default)]
    pub incomplete: bool,
}

fn default_quality() -> f32 {
    1.0
}

impl PartialEq for FileFingerprint {
    /// Unchanged detection uses size + mtime; quality is handled by `needs_reparse`.
    fn eq(&self, other: &Self) -> bool {
        self.size == other.size && self.mtime_secs == other.mtime_secs
    }
}

impl Eq for FileFingerprint {}

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
            extracted_quality_ratio: 1.0,
            pages_ok: 0,
            pages_total: 0,
            incomplete: false,
        })
    }

    pub fn from_path_with_extraction(path: &Path, stats: &ExtractionStats) -> Option<Self> {
        let mut fp = Self::from_path(path)?;
        fp.pages_ok = stats.pages_ok;
        fp.pages_total = stats.pages_total;
        fp.extracted_quality_ratio = stats.quality_ratio();
        fp.incomplete = stats.incomplete();
        Some(fp)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexManifest {
    /// Manifest layout version (v2 = quality tracking + zero-loss ingest).
    #[serde(default)]
    pub schema_version: u32,
    /// Canonical root last synced (usually $HOME).
    pub root: String,
    /// Absolute path string → fingerprint at last successful index.
    pub files: HashMap<String, FileFingerprint>,
}

impl Default for IndexManifest {
    fn default() -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            root: String::new(),
            files: HashMap::new(),
        }
    }
}

/// Legacy v1 layout (size + mtime only) for migration.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexManifestV1 {
    root: String,
    files: HashMap<String, FileFingerprintV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileFingerprintV1 {
    size: u64,
    mtime_secs: u64,
}

impl IndexManifest {
    pub fn load(data_dir: &Path) -> Result<Self, EngineError> {
        let path = data_dir.join(MANIFEST_FILE);
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = std::fs::read(&path)?;
        if let Ok(mut m) = bincode::deserialize::<Self>(&bytes) {
            if m.schema_version == 0 {
                // Deserialized with default 0 from missing field — treat as pre-v2.
                m.schema_version = 0;
            }
            return Ok(m);
        }
        if let Ok(old) = bincode::deserialize::<IndexManifestV1>(&bytes) {
            let files = old
                .files
                .into_iter()
                .map(|(k, v)| {
                    (
                        k,
                        FileFingerprint {
                            size: v.size,
                            mtime_secs: v.mtime_secs,
                            extracted_quality_ratio: 0.0,
                            pages_ok: 0,
                            pages_total: 0,
                            incomplete: true,
                        },
                    )
                })
                .collect();
            return Ok(Self {
                schema_version: 0,
                root: old.root,
                files,
            });
        }
        log::warn!("doc_graph manifest corrupt or unknown version; starting fresh");
        Ok(Self::default())
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), EngineError> {
        let path = data_dir.join(MANIFEST_FILE);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut to_save = self.clone();
        to_save.schema_version = MANIFEST_SCHEMA_VERSION;
        let bytes =
            bincode::serialize(&to_save).map_err(|e| EngineError::Serde(e.to_string()))?;
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

    /// Whether a stored entry must be re-parsed (schema / incomplete pages).
    pub fn needs_reparse(&self, path: &Path) -> bool {
        let is_pdf = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|e| e.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false);

        if self.schema_version < MANIFEST_SCHEMA_VERSION && is_pdf {
            return true;
        }

        if !is_pdf {
            return false;
        }

        match self.files.get(&Self::key(path)) {
            Some(stored) => stored.incomplete,
            None => false,
        }
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
            Some(fp) if manifest.matches(path, &fp) && !manifest.needs_reparse(path) => {
                unchanged += 1
            }
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
