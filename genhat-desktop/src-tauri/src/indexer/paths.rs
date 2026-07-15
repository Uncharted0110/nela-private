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

/// User-facing folders we index by default (not the entire home directory).
fn default_user_folders(home_dir: &Path) -> Vec<PathBuf> {
    const CANDIDATES: &[&str] = &[
        "Documents",
        "Desktop",
        "Downloads",
        "documents",
        "desktop",
        "downloads",
    ];

    let mut out = Vec::new();
    for name in CANDIDATES {
        let p = home_dir.join(name);
        if p.exists() && !out.iter().any(|existing: &PathBuf| existing == &p) {
            out.push(p);
        }
    }
    out
}

/// Collect crawl/watch roots: Documents, Desktop, Downloads under home, plus workspaces
/// outside home. Deliberately excludes the full home tree (avoids indexing dev packages).
///
/// Each root is walked **recursively** — e.g. `~/Documents/Work/2024/resume.pdf` is indexed.
/// Subtrees under blacklisted segments (`node_modules`, `.git`, …) are skipped.
pub fn collect_index_roots(home_dir: &Path, workspace_paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = default_user_folders(home_dir);

    if roots.is_empty() && home_dir.exists() {
        // Fallback when standard folders are missing (minimal home layout).
        roots.push(home_dir.to_path_buf());
    }

    for ws in workspace_paths {
        if !ws.exists() {
            continue;
        }
        if home_dir.exists() && is_path_under(ws, home_dir) {
            // Already covered when under Documents/Desktop/Downloads; still add if under
            // a non-default folder inside home (e.g. ~/Projects).
            if default_user_folders(home_dir)
                .iter()
                .any(|root| is_path_under(ws, root))
            {
                continue;
            }
        }
        if !roots.iter().any(|r| is_path_under(ws, r) || is_path_under(r, ws)) {
            roots.push(ws.clone());
        }
    }

    roots
}

/// True when an indexed path lies under any of the active crawl roots.
pub fn is_under_index_roots(path_key: &str, roots: &[PathBuf]) -> bool {
    let path = Path::new(path_key);
    roots.iter().any(|root| is_path_under(path, root))
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

/// Paths that should never rank highly even if still present in a legacy index.
pub fn is_low_value_path(path_key: &str) -> bool {
    let lower = path_key.to_lowercase().replace('\\', "/");
    const BAD_FRAGMENTS: &[&str] = &[
        "/site-packages/",
        "/dist-packages/",
        "/lib/python",
        "/.local/lib/",
        "/__pycache__/",
        "/node_modules/",
        "/.git/",
        "/target/",
        "/.cargo/registry/",
        "/.rustup/",
        "/miniconda/",
        "/anaconda/",
        "/.conda/",
        "/.pyenv/",
        "/go/pkg/",
        "/.gradle/",
        "/.m2/",
        "/.npm/",
        "/venv/",
        "/.venv/",
    ];
    BAD_FRAGMENTS.iter().any(|frag| lower.contains(frag))
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
    // Python / ML package trees
    "site-packages",
    "dist-packages",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".tox",
    "miniconda3",
    "anaconda3",
    ".conda",
    ".pyenv",
    // Rust / Go / Java tooling
    ".cargo",
    ".rustup",
    "go",
    ".gradle",
    ".m2",
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

    #[test]
    fn low_value_detects_site_packages() {
        assert!(is_low_value_path(
            "/home/user/.local/lib/python3.12/site-packages/torch/autograd/__init__.py"
        ));
        assert!(!is_low_value_path("/home/user/Documents/resume.pdf"));
    }

    #[test]
    fn collect_roots_uses_existing_user_folders() {
        let dir = std::env::temp_dir().join("nela_indexer_roots_test");
        let docs = dir.join("Documents");
        fs::create_dir_all(&docs).unwrap();
        let roots = collect_index_roots(&dir, &[]);
        assert!(roots.iter().any(|p| p.ends_with("Documents")));
        fs::remove_dir_all(&dir).ok();
    }
}
