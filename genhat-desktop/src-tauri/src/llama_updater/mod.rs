//! Background updater for official llama.cpp release binaries.
//!
//! On startup, checks the latest GitHub release and installs CPU builds into a
//! writable runtime directory that takes precedence over bundled binaries.

use crate::paths::{self, llama_os_folder};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{copy, BufReader};
use std::path::{Path, PathBuf};
use tar::Archive;
use zip::ZipArchive;

const GITHUB_LATEST_RELEASE: &str =
    "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
const USER_AGENT: &str = "GenHat-NELA-llama-updater";

#[derive(Debug, Serialize, Deserialize)]
struct RuntimeManifest {
    tag: String,
    asset_name: String,
    installed_at: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

/// Whether startup should attempt a background llama.cpp update.
pub fn is_auto_update_enabled() -> bool {
    if std::env::var_os("GENHAT_DISABLE_LLAMA_AUTO_UPDATE").is_some() {
        return false;
    }
    if cfg!(debug_assertions) {
        return std::env::var_os("GENHAT_ENABLE_LLAMA_AUTO_UPDATE").is_some();
    }
    true
}

pub fn parse_build_number(tag: &str) -> Option<u32> {
    tag.trim()
        .strip_prefix('b')
        .or_else(|| tag.trim().strip_prefix('B'))
        .and_then(|n| n.parse().ok())
}

pub fn target_asset_name(tag: &str) -> String {
    let tag = tag.trim();
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return format!("llama-{tag}-bin-ubuntu-x64.tar.gz");
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return format!("llama-{tag}-bin-ubuntu-arm64.tar.gz");
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return format!("llama-{tag}-bin-macos-arm64.tar.gz");
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return format!("llama-{tag}-bin-macos-x64.tar.gz");
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        return format!("llama-{tag}-bin-win-cpu-x64.zip");
    }
    #[cfg(all(windows, target_arch = "aarch64"))]
    {
        return format!("llama-{tag}-bin-win-cpu-arm64.zip");
    }
    #[cfg(not(any(
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(windows, target_arch = "x86_64"),
        all(windows, target_arch = "aarch64"),
    )))]
    {
        format!("llama-{tag}-unsupported")
    }
}

fn manifest_path(runtime_root: &Path) -> PathBuf {
    runtime_root.join("version.json")
}

fn read_manifest(runtime_root: &Path) -> Option<RuntimeManifest> {
    let raw = fs::read_to_string(manifest_path(runtime_root)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_manifest(runtime_root: &Path, manifest: &RuntimeManifest) -> Result<(), String> {
    fs::create_dir_all(runtime_root).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(manifest_path(runtime_root), json).map_err(|e| e.to_string())
}

fn is_newer_tag(latest: &str, installed: &str) -> bool {
    match (parse_build_number(latest), parse_build_number(installed)) {
        (Some(l), Some(i)) => l > i,
        _ => latest != installed,
    }
}

fn validate_download_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://github.com/ggml-org/llama.cpp/releases/download/") {
        return Err(format!("Refusing untrusted download URL: {url}"));
    }
    Ok(())
}

async fn fetch_latest_release(client: &reqwest::Client) -> Result<GithubRelease, String> {
    let response = client
        .get(GITHUB_LATEST_RELEASE)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub release check failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub release check failed with status {}",
            response.status()
        ));
    }

    response
        .json::<GithubRelease>()
        .await
        .map_err(|e| format!("Failed to parse GitHub release metadata: {e}"))
}

async fn download_file(client: &reqwest::Client, url: &str, dest: &Path) -> Result<(), String> {
    validate_download_url(url)?;

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status {}", response.status()));
    }

    let mut file = File::create(dest).map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {e}"))?;
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn extract_tar_gz(archive_path: &Path, extract_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(extract_dir).map_err(|e| e.to_string())?;
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let decoder = GzDecoder::new(BufReader::new(file));
    let mut archive = Archive::new(decoder);
    archive.unpack(extract_dir).map_err(|e| e.to_string())?;
    find_single_top_level_dir(extract_dir)
}

fn extract_zip(archive_path: &Path, extract_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(extract_dir).map_err(|e| e.to_string())?;
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        let out_path = extract_dir.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out_file = File::create(&out_path).map_err(|e| e.to_string())?;
        copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
    }

    find_single_top_level_dir(extract_dir)
}

fn find_single_top_level_dir(root: &Path) -> Result<PathBuf, String> {
    let mut dirs = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            dirs.push(entry.path());
        }
    }

    match dirs.len() {
        1 => Ok(dirs.remove(0)),
        0 => Err(format!(
            "Archive did not contain a top-level directory under {}",
            root.display()
        )),
        _ => Err(format!(
            "Archive contained multiple top-level directories under {}",
            root.display()
        )),
    }
}

fn remove_dir_best_effort(path: &Path) {
    if path.exists() {
        let _ = fs::remove_dir_all(path);
    }
}

fn install_payload_dir(payload_dir: &Path, runtime_root: &Path) -> Result<(), String> {
    let os_folder = llama_os_folder();
    let dest = runtime_root.join(os_folder);
    remove_dir_best_effort(&dest);
    fs::create_dir_all(runtime_root).map_err(|e| e.to_string())?;
    fs::rename(payload_dir, &dest).or_else(|rename_err| {
        copy_dir_recursive(payload_dir, &dest)?;
        remove_dir_best_effort(payload_dir);
        if dest.exists() {
            Ok(())
        } else {
            Err(rename_err.to_string())
        }
    })?;
    ensure_tree_executable(&dest);
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_tree_executable(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            ensure_tree_executable(&path);
            continue;
        }
        let is_binary = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                !matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "so" | "dll" | "dylib" | "txt" | "md" | "json" | "license"
                )
            })
            .unwrap_or(true);
        if !is_binary {
            continue;
        }
        if let Ok(meta) = fs::metadata(&path) {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = meta.permissions();
            let mode = perms.mode();
            if mode & 0o111 == 0 {
                perms.set_mode(mode | 0o755);
                let _ = fs::set_permissions(&path, perms);
            }
        }
    }
}

#[cfg(not(unix))]
fn ensure_tree_executable(_root: &Path) {}

fn binaries_present_at(base: &Path) -> bool {
    let server = base.join(if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    });
    let cli = base.join(if cfg!(windows) {
        "llama-mtmd-cli.exe"
    } else {
        "llama-mtmd-cli"
    });
    server.is_file() && cli.is_file()
}

fn required_binaries_present(runtime_root: &Path) -> bool {
    binaries_present_at(&runtime_root.join(llama_os_folder()))
}

fn resolve_payload_root(payload_dir: &Path) -> Option<PathBuf> {
    if binaries_present_at(payload_dir) {
        return Some(payload_dir.to_path_buf());
    }
    let nested = payload_dir.join(llama_os_folder());
    if binaries_present_at(&nested) {
        return Some(nested);
    }
    None
}

fn sanitize_staging(runtime_root: &Path) -> PathBuf {
    let staging = runtime_root.join(".staging");
    remove_dir_best_effort(&staging);
    staging
}

/// Check GitHub for a newer llama.cpp build and install it into `runtime_root`.
pub async fn maybe_update_llama(runtime_root: &Path) -> Result<(), String> {
    if !is_auto_update_enabled() {
        log::info!("llama.cpp auto-update disabled for this session");
        return Ok(());
    }

    fs::create_dir_all(runtime_root).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;

    let release = fetch_latest_release(&client).await?;
    let latest_tag = release.tag_name.trim().to_string();
    let asset_name = target_asset_name(&latest_tag);

    if let Some(installed) = read_manifest(runtime_root) {
        if installed.tag == latest_tag && required_binaries_present(runtime_root) {
            log::info!(
                "llama.cpp runtime is already up to date ({})",
                latest_tag
            );
            return Ok(());
        }
        if !is_newer_tag(&latest_tag, &installed.tag)
            && required_binaries_present(runtime_root)
        {
            log::info!(
                "Installed llama.cpp build {} is newer or equal to latest {}; skipping",
                installed.tag,
                latest_tag
            );
            return Ok(());
        }
    }

    let asset = release
        .assets
        .into_iter()
        .find(|asset| asset.name == asset_name)
        .ok_or_else(|| {
            format!(
                "Release {} does not provide asset '{}' for this platform",
                latest_tag, asset_name
            )
        })?;

    log::info!(
        "Updating llama.cpp runtime: {} -> {}",
        read_manifest(runtime_root)
            .map(|m| m.tag)
            .unwrap_or_else(|| "bundled".to_string()),
        latest_tag
    );

    let staging = sanitize_staging(runtime_root);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let archive_path = staging.join(&asset.name);
    download_file(&client, &asset.browser_download_url, &archive_path).await?;

    let extract_dir = staging.join("extract");
    let payload_dir = if asset.name.ends_with(".tar.gz") {
        extract_tar_gz(&archive_path, &extract_dir)?
    } else if asset.name.ends_with(".zip") {
        extract_zip(&archive_path, &extract_dir)?
    } else {
        return Err(format!("Unsupported llama.cpp archive format: {}", asset.name));
    };

    let payload_root = resolve_payload_root(&payload_dir).ok_or_else(|| {
        format!(
            "Downloaded llama.cpp build {} did not contain llama-server binaries",
            latest_tag
        )
    })?;
    install_payload_dir(&payload_root, runtime_root)?;

    if !required_binaries_present(runtime_root) {
        return Err(format!(
            "Installed llama.cpp build {} is missing required binaries",
            latest_tag
        ));
    }

    let manifest = RuntimeManifest {
        tag: latest_tag.clone(),
        asset_name: asset.name,
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    write_manifest(runtime_root, &manifest)?;
    remove_dir_best_effort(&staging);

    log::info!("llama.cpp runtime updated to {}", latest_tag);
    Ok(())
}

/// Resolve the active llama.cpp bin root for diagnostics.
pub fn active_llama_bin_root() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("GENHAT_LLAMA_RUNTIME_DIR") {
        let custom = PathBuf::from(custom);
        if custom.is_dir() {
            return Some(custom);
        }
    }
    let server_name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    paths::candidate_bin_dirs()
        .into_iter()
        .find(|dir| dir.join(llama_os_folder()).join(server_name).exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_build_number_reads_b_tags() {
        assert_eq!(parse_build_number("b9670"), Some(9670));
        assert_eq!(parse_build_number("b12"), Some(12));
        assert_eq!(parse_build_number("nope"), None);
    }

    #[test]
    fn target_asset_name_matches_platform() {
        let name = target_asset_name("b9670");
        assert!(name.contains("b9670"));
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        assert_eq!(name, "llama-b9670-bin-ubuntu-x64.tar.gz");
        #[cfg(all(windows, target_arch = "x86_64"))]
        assert_eq!(name, "llama-b9670-bin-win-cpu-x64.zip");
    }
}
