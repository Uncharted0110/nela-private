pub mod crawler;
pub mod db;
pub mod watcher;

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
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    pub cancel_token: CancellationToken,
}

impl AmbientIndexer {
    /// Start the database connection, background crawler, and file system watcher.
    pub fn start(
        app_cache_dir: &Path,
        home_dir: PathBuf,
        governor: Arc<Governor>,
        workspace_paths: Vec<PathBuf>,
    ) -> Result<Arc<Self>, String> {
        let db_path = app_cache_dir.join("nela_indexer.db");
        let db = IndexerDb::open(&db_path)?;
        let cancel_token = CancellationToken::new();

        // 1. Start background crawler thread
        let db_crawler = db.clone();
        let gov_crawler = governor.clone();
        let cancel_crawler = cancel_token.clone();
        let home_crawler = home_dir.clone();
        let ws_crawler = workspace_paths.clone();
        std::thread::spawn(move || {
            crawler::run_crawler(home_crawler, ws_crawler, db_crawler, gov_crawler, cancel_crawler);
        });

        // 2. Start file watcher
        let watcher = watcher::start_watcher(
            home_dir,
            db.clone(),
            governor.clone(),
            cancel_token.clone(),
            workspace_paths,
        )?;

        Ok(Arc::new(Self {
            db,
            governor,
            watcher: Mutex::new(Some(watcher)),
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
        *watcher_guard = None; // Dropping the RecommendedWatcher stops all watches
        log::info!("Ambient indexer stopped.");
    }
}

/// Managed state wrapper for Tauri.
pub struct AmbientIndexerState(pub Arc<AmbientIndexer>);
