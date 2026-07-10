//! Cross-platform path normalization for the ambient indexer.
//!
//! SQLite keys must be stable across crawls, the filesystem watcher, and search so
//! deletion sync and stale pruning work on both Linux and Windows.

use std::path::{Component, Path, PathBuf};

/// Strip the Windows `\\?\` extended-length prefix when present.
fn strip_extended_prefix(s: &str) -> &str {
    s.strip_prefix(r"\\?\").unwrap_or(s)
}

/// Canonical-ish path string used as the database key and in search results.
///
/// - Resolves symlinks when the path exists (`canonicalize`).
/// - Uses `/` separators everywhere (valid on Windows for `std::fs`).
/// - Lowercases on Windows (case-insensitive filesystem).
pub fn normalize_index_path(path: &Path) -> String {
    let resolved: PathBuf = if path.exists() {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    } else {
        path.to_path_buf()
    };

    let mut s = strip_extended_prefix(&resolved.to_string_lossy()).replace('\\', "/");

    // Collapse duplicate slashes (except leading // for UNC).
    while s.contains("//") {
        s = s.replace("//", "/");
    }

    // Drop trailing slash on directories for a stable key.
    if s.len() > 1 {
        s = s.trim_end_matches('/').to_string();
    }

    #[cfg(windows)]
    {
        s = s.to_lowercase();
    }

    s
}

/// True when `child` is the same path as, or nested under, `parent`.
pub fn is_path_under(child: &Path, parent: &Path) -> bool {
    let child_key = normalize_index_path(child);
    let parent_key = normalize_index_path(parent);

    if child_key == parent_key {
        return true;
    }

    let prefix = if parent_key.ends_with('/') {
        parent_key
    } else {
        format!("{parent_key}/")
    };
    child_key.starts_with(&prefix)
}

/// Check whether a path still exists on disk (handles normalized `/` keys on Windows).
pub fn index_path_exists(path_key: &str) -> bool {
    Path::new(path_key).exists()
}

/// Collect crawl/watch roots: home (recursive) plus workspaces outside home.
pub fn collect_index_roots(home_dir: &Path, workspace_paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    if home_dir.exists() {
        roots.push(home_dir.to_path_buf());
    }

    for ws in workspace_paths {
        if !ws.exists() {
            continue;
        }
        if home_dir.exists() && is_path_under(ws, home_dir) {
            continue;
        }
        roots.push(ws.clone());
    }

    roots
}

/// Remove a path from a deletion-sync set, accounting for legacy (non-normalized) keys.
pub fn remove_from_path_set(set: &mut std::collections::HashSet<String>, path: &Path) {
    let normalized = normalize_index_path(path);
    set.remove(&normalized);
    let legacy = path.to_string_lossy().into_owned();
    set.remove(&legacy);
    #[cfg(windows)]
    {
        set.remove(&legacy.to_lowercase());
        set.remove(&legacy.replace('/', "\\"));
        set.remove(&legacy.replace('/', "\\").to_lowercase());
    }
}

/// Delete stale DB rows for both normalized and legacy spellings of a path.
pub fn delete_index_paths(db: &crate::indexer::db::IndexerDb, path: &Path) {
    let normalized = normalize_index_path(path);
    db.delete(&normalized).ok();
    let legacy = path.to_string_lossy().into_owned();
    if legacy != normalized {
        db.delete(&legacy).ok();
    }
    #[cfg(windows)]
    {
        let lower = legacy.to_lowercase();
        if lower != normalized && lower != legacy {
            db.delete(&lower).ok();
        }
    }
}

/// Walk path components and return true if any segment is blacklisted.
pub(crate) fn is_blacklisted(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(name) => name
            .to_str()
            .map(|s| BLACKLIST.iter().any(|b| s.eq_ignore_ascii_case(b)))
            .unwrap_or(false),
        _ => false,
    })
}

const BLACKLIST: &[&str] = &[
    // VCS / package managers / build output (all platforms)
    ".git",
    "node_modules",
    "target",
    ".cache",
    "cache",
    "dist",
    "build",
    ".squad_cache",
    "venv",
    ".venv",
    "env",
    ".env",
    // Linux
    "lost+found",
    // macOS (harmless on Linux/Windows)
    "Library",
    // Windows system / profile junctions & caches
    "AppData",
    "Application Data",
    "Local Settings",
    "Cookies",
    "Recent",
    "NetHood",
    "PrintHood",
    "SendTo",
    "Templates",
    "Start Menu",
    "System Volume Information",
    "$RECYCLE.BIN",
    // Trash folders
    "Trash",
    ".Trash",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn normalize_uses_forward_slashes() {
        let dir = std::env::temp_dir().join("nela_indexer_path_test");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "hello").unwrap();

        let key = normalize_index_path(&file);
        assert!(key.contains('/'));
        assert!(!key.contains('\\'));
        assert!(
            key.ends_with("sample.txt") || key.to_lowercase().ends_with("sample.txt")
        );

        fs::remove_file(&file).ok();
        fs::remove_dir(&dir).ok();
    }

    #[test]
    fn is_path_under_detects_nested_paths() {
        let home = Path::new("/home/user");
        let nested = Path::new("/home/user/Documents/report.pdf");
        assert!(is_path_under(nested, home));
        assert!(!is_path_under(home, nested));
    }

    #[test]
    fn blacklisted_segments_are_skipped() {
        assert!(is_blacklisted(Path::new("/home/user/node_modules/pkg/index.js")));
        assert!(is_blacklisted(Path::new("C:/Users/foo/AppData/Local/Temp/x")));
        assert!(!is_blacklisted(Path::new("/home/user/Documents/report.pdf")));
    }
}
