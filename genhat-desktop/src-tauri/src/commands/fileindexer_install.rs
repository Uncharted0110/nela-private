//! FileIndexer install-time setup — mirrors the Windows NSIS wizard output.
//!
//! Writes `mode.txt`, `roots.txt`, and `model_path.txt` under
//! `{app_data}/fileindexer/`, and can download the MiniLM ONNX zip into
//! `{models}/fileindexer/` (writable user models dir on Linux).

use serde::Serialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use zip::ZipArchive;

const FILEINDEXER_MODEL_DRIVE_ID: &str = "1YwMBKe7do-tfEULZCWWicg2NEJAnOTou";
const MODEL_MARKER: &str = "models--Qdrant--all-MiniLM-L6-v2-onnx/snapshots";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexerSetupStatus {
    pub needed: bool,
    pub show_wizard: bool,
    pub mode: Option<String>,
    pub roots: Vec<String>,
    pub model_present: bool,
    pub model_dir: String,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("fileindexer"))
        .map_err(|e| e.to_string())
}

fn fileindexer_model_dir() -> PathBuf {
    super::models::get_models_dir().join("fileindexer")
}

fn read_text(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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

fn model_present(model_dir: &Path) -> bool {
    model_dir.join(MODEL_MARKER).exists()
}

pub fn setup_status(app: &AppHandle) -> Result<FileIndexerSetupStatus, String> {
    let cfg = config_dir(app)?;
    let mode_path = cfg.join("mode.txt");
    let needed = !mode_path.exists();
    let model_dir = fileindexer_model_dir();

    Ok(FileIndexerSetupStatus {
        show_wizard: needed && cfg!(all(target_os = "linux", not(debug_assertions))),
        needed,
        mode: read_text(&mode_path),
        roots: read_roots(&cfg.join("roots.txt")),
        model_present: model_present(&model_dir),
        model_dir: model_dir.display().to_string(),
    })
}

fn is_mount_candidate(mount_point: &str, fstype: &str) -> bool {
    if mount_point.starts_with("/proc")
        || mount_point.starts_with("/sys")
        || mount_point.starts_with("/dev")
        || mount_point.starts_with("/run/user")
    {
        return false;
    }

    let useful_fs = matches!(
        fstype,
        "ext4" | "ext3" | "ext2" | "btrfs" | "xfs" | "fuseblk" | "ntfs" | "vfat" | "exfat"
    );

    useful_fs
        && (mount_point == "/"
            || mount_point.starts_with("/home/")
            || mount_point.starts_with("/media/")
            || mount_point.starts_with("/mnt/")
            || mount_point.starts_with("/run/media/"))
}

fn collect_default_linux_roots() -> Vec<String> {
    let mut roots = Vec::new();

    if let Ok(home) = std::env::var("HOME") {
        let home_path = PathBuf::from(&home);
        if home_path.is_dir() {
            roots.push(home);
        }
    }

    if let Ok(content) = fs::read_to_string("/proc/mounts") {
        for line in content.lines() {
            let mut parts = line.split_whitespace();
            let _device = parts.next();
            let mount_point = parts.next().unwrap_or("");
            let fstype = parts.next().unwrap_or("");
            if is_mount_candidate(mount_point, fstype) {
                roots.push(mount_point.to_string());
            }
        }
    }

    roots.sort();
    roots.dedup();
    roots
}

#[cfg(windows)]
fn collect_default_windows_roots() -> Vec<String> {
    (b'A'..=b'Z')
        .filter_map(|letter| {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                Some(drive)
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
pub fn fileindexer_get_setup_status(app: AppHandle) -> Result<FileIndexerSetupStatus, String> {
    setup_status(&app)
}

#[tauri::command]
pub fn fileindexer_list_default_roots() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        return Ok(collect_default_windows_roots());
    }
    #[cfg(not(windows))]
    {
        Ok(collect_default_linux_roots())
    }
}

#[tauri::command]
pub fn fileindexer_save_setup(
    app: AppHandle,
    mode: String,
    roots: Vec<String>,
) -> Result<(), String> {
    if mode != "default" && mode != "custom" {
        return Err("mode must be 'default' or 'custom'".to_string());
    }

    let cleaned: Vec<String> = roots
        .into_iter()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .collect();

    if cleaned.is_empty() {
        return Err("Select at least one folder to index.".to_string());
    }

    for root in &cleaned {
        if !Path::new(root).is_dir() {
            return Err(format!("Not a valid folder: {root}"));
        }
    }

    let cfg = config_dir(&app)?;
    fs::create_dir_all(&cfg).map_err(|e| e.to_string())?;

    let model_dir = fileindexer_model_dir();
    fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;

    fs::write(cfg.join("mode.txt"), &mode).map_err(|e| e.to_string())?;
    fs::write(
        cfg.join("roots.txt"),
        cleaned.join("\n") + "\n",
    )
    .map_err(|e| e.to_string())?;
    fs::write(
        cfg.join("model_path.txt"),
        model_dir.display().to_string(),
    )
    .map_err(|e| e.to_string())?;

    log::info!(
        "FileIndexer setup saved (mode={mode}, {} roots, model_dir={})",
        cleaned.len(),
        model_dir.display()
    );
    Ok(())
}

fn model_download_url() -> String {
    if let Ok(url) = std::env::var("FILEINDEXER_MODEL_ZIP_URL") {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    format!(
        "https://drive.usercontent.google.com/download?id={FILEINDEXER_MODEL_DRIVE_ID}&export=download&confirm=t"
    )
}

fn is_zip_file(path: &Path) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut header = [0u8; 4];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    Ok(header[0] == b'P' && header[1] == b'K')
}

fn flatten_model_wrapper(dest: &Path) -> Result<(), String> {
    let marker = dest.join(MODEL_MARKER);
    if marker.exists() {
        return Ok(());
    }

    let entries = fs::read_dir(dest).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let inner_marker = entry.path().join(MODEL_MARKER);
        if inner_marker.exists() {
            for child in fs::read_dir(entry.path()).map_err(|e| e.to_string())? {
                let child = child.map_err(|e| e.to_string())?;
                let target = dest.join(child.file_name());
                if target.exists() {
                    continue;
                }
                fs::rename(child.path(), &target).map_err(|e| e.to_string())?;
            }
            let _ = fs::remove_dir_all(entry.path());
            return Ok(());
        }
    }
    Ok(())
}

fn extract_model_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let out_path = entry
            .enclosed_name()
            .ok_or_else(|| format!("Invalid zip entry at index {i}"))?
            .to_path_buf();
        let target = dest.join(out_path);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = File::create(&target).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }

    flatten_model_wrapper(dest)?;
    if !dest.join(MODEL_MARKER).exists() {
        return Err(format!(
            "Downloaded zip did not contain {MODEL_MARKER}. FileIndexer will show model missing until fixed."
        ));
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileIndexerDownloadEvent {
    phase: String,
    message: String,
    progress: f64,
}

#[tauri::command]
pub async fn fileindexer_download_model(app: AppHandle) -> Result<(), String> {
    let model_dir = fileindexer_model_dir();
    if model_present(&model_dir) {
        return Ok(());
    }

    fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;

    let emit = |phase: &str, message: &str, progress: f64| {
        let _ = app.emit(
            "fileindexer-download-progress",
            FileIndexerDownloadEvent {
                phase: phase.to_string(),
                message: message.to_string(),
                progress,
            },
        );
    };

    emit("download", "Downloading FileIndexer embedding model…", 5.0);

    let url = model_download_url();
    let temp_zip = std::env::temp_dir().join("nela-fileindexer-minilm.zip");
    let _ = fs::remove_file(&temp_zip);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Model download request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Model download failed with HTTP {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Model download stream failed: {e}"))?;

    emit("download", "Saving model archive…", 55.0);
    fs::write(&temp_zip, &bytes).map_err(|e| e.to_string())?;

    if !is_zip_file(&temp_zip)? {
        let _ = fs::remove_file(&temp_zip);
        return Err("Model download did not produce a zip file.".to_string());
    }

    emit("extract", "Extracting embedding model…", 75.0);
    let extract_result = extract_model_zip(&temp_zip, &model_dir);
    let _ = fs::remove_file(&temp_zip);
    extract_result?;

    emit("done", "FileIndexer embedding model installed", 100.0);
    Ok(())
}
