pub mod crawler;
pub mod db;
pub mod paths;
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

        // 1. Background crawler
        let db_crawler = db.clone();
        let gov_crawler = governor.clone();
        let cancel_crawler = cancel_token.clone();
        let home_crawler = home_dir.clone();
        let ws_crawler = workspace_paths.clone();
        std::thread::spawn(move || {
            crawler::run_crawler(home_crawler, ws_crawler, db_crawler, gov_crawler, cancel_crawler);
        });

        // 2. Background watcher registration (recursive home watch is slow; must not block UI)
        let watcher_slot_bg = watcher_slot.clone();
        let db_watcher = db.clone();
        let gov_watcher = governor.clone();
        let cancel_watcher = cancel_token.clone();
        let home_watcher = home_dir;
        let ws_watcher = workspace_paths;
        std::thread::spawn(move || {
            log::info!("Registering ambient filesystem watches in background...");
            match watcher::start_watcher(
                home_watcher,
                db_watcher,
                gov_watcher,
                cancel_watcher,
                ws_watcher,
            ) {
                Ok(w) => {
                    *watcher_slot_bg.lock().unwrap() = Some(w);
                    log::info!("Ambient filesystem watches registered.");
                }
                Err(e) => {
                    log::error!(
                        "Failed to start ambient filesystem watcher: {e} (crawl will still run)"
                    );
                }
            }
        });

        log::info!("Ambient indexer started (crawl and watches running in background).");

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
