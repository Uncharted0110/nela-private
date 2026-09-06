//! Merge / remove File Indexer roots without wiping user-chosen folders.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("fileindexer"))
        .map_err(|e| e.to_string())
}

fn read_roots(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .ok()
        .map(|content| {
            content
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn write_roots(cfg: &Path, roots: &[String]) -> Result<(), String> {
    fs::create_dir_all(cfg).map_err(|e| e.to_string())?;
    fs::write(cfg.join("roots.txt"), roots.join("\n") + "\n").map_err(|e| e.to_string())?;
    Ok(())
}

/// Add `root` to `roots.txt` if missing. Does not remove existing roots.
pub fn merge_root(app: &AppHandle, root: &str) -> Result<(), String> {
    let cleaned = root.trim();
    if cleaned.is_empty() {
        return Err("Mirror root is empty.".to_string());
    }
    if !Path::new(cleaned).is_dir() {
        return Err(format!("Not a valid folder: {cleaned}"));
    }
    let cfg = config_dir(app)?;
    let mut roots = read_roots(&cfg.join("roots.txt"));
    if !roots.iter().any(|r| r == cleaned) {
        roots.push(cleaned.to_string());
        write_roots(&cfg, &roots)?;
    }
    // Ensure mode exists so File Indexer treats setup as complete.
    let mode_path = cfg.join("mode.txt");
    if !mode_path.exists() {
        fs::write(&mode_path, "custom").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remove `root` from `roots.txt` if present.
pub fn remove_root(app: &AppHandle, root: &str) -> Result<(), String> {
    let cleaned = root.trim();
    let cfg = config_dir(app)?;
    let roots: Vec<String> = read_roots(&cfg.join("roots.txt"))
        .into_iter()
        .filter(|r| r != cleaned)
        .collect();
    write_roots(&cfg, &roots)
}
