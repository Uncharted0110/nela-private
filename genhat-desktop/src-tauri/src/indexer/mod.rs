pub mod crawler;
pub mod db;
pub mod disk;
pub mod paths;
pub mod query;
pub mod watcher;
pub mod rank;

pub use rank::{search_ranked, RankedFileRecord};

use crate::governor::{CancellationToken, Governor};
use db::{FileRecord, IndexerDb};
use notify::RecommendedWatcher;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// The Ambient Indexer orchestrator.
///
/// Runs background crawling and file system watching, and exposes search capabilities.
pub struct AmbientIndexer {
    pub db: IndexerDb,
    pub governor: Arc<Governor>,
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    pub cancel_token: CancellationToken,
}

impl AmbientIndexer {
    /// Start the database connection, background crawler, and file system watcher.
    ///
    /// Returns immediately after opening the DB. Crawling and filesystem watch
    /// registration run on background threads so Tauri `setup()` is not blocked
    /// (recursive watches on a large home directory can take minutes on Linux).
    pub fn start(
        app_cache_dir: &Path,
        home_dir: PathBuf,
        governor: Arc<Governor>,
        workspace_paths: Vec<PathBuf>,
    ) -> Result<Arc<Self>, String> {
        let db_path = app_cache_dir.join("nela_indexer.db");
        let db = IndexerDb::open(&db_path)?;
        let cancel_token = CancellationToken::new();
        let watcher_slot: Arc<Mutex<Option<RecommendedWatcher>>> =
            Arc::new(Mutex::new(None));

        // Ambient crawl/watch disabled — FileIndexer owns folder indexing.
        // Keep the DB open so legacy search/content commands can still read
        // whatever was indexed previously (or return empty).
        let _ = (home_dir, workspace_paths, governor.clone());
        log::info!(
            "Ambient indexer DB ready (background crawl/watch disabled; FileIndexer handles indexing)."
        );

        Ok(Arc::new(Self {
            db,
            governor,
            watcher: watcher_slot,
            cancel_token,
        }))
    }

    /// Query the indexer database.
    pub fn search(&self, query: &str) -> Result<Vec<FileRecord>, String> {
        self.db.search(query)
    }

    /// Stop the background watcher and crawler.
    pub fn stop(&self) {
        self.cancel_token.cancel();
        let mut watcher_guard = self.watcher.lock().unwrap();
        *watcher_guard = None;
        log::info!("Ambient indexer stopped.");
    }
}

/// Managed state wrapper for Tauri.
pub struct AmbientIndexerState(pub Arc<AmbientIndexer>);
