//! FileIndexer sidecar host — configure roots, spawn long-lived indexer, surface status.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const MODEL_DIR_NAME: &str = "models--Qdrant--all-MiniLM-L6-v2-onnx";
const CONFIG_FILE: &str = "config.json";
const ROOTS_FILE: &str = "roots.txt";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexerConfig {
    pub setup_done: bool,
    pub mode: String,
    pub roots: Vec<String>,
}

impl Default for FileIndexerConfig {
    fn default() -> Self {
        Self {
            setup_done: false,
            mode: "default".into(),
            roots: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexerModelInfo {
    pub id: String,
    pub name: String,
    pub present: bool,
    pub cache_dir: String,
    pub model_dir: String,
    pub size_mb: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexerStatus {
    pub phase: String,
    pub files_total: usize,
    pub files_embedded: usize,
    pub embed_done: usize,
    pub embed_total: usize,
    pub message: String,
    pub running: bool,
    pub setup_done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexerHit {
    pub path: String,
    pub score: f64,
    pub fields: Vec<String>,
}

pub struct FileIndexerState {
    inner: Mutex<FileIndexerInner>,
    pending: Mutex<HashMap<u64, SyncSender<Result<Vec<FileIndexerHit>, String>>>>,
    next_search_id: AtomicU64,
}

struct FileIndexerInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    status: FileIndexerStatus,
    data_dir: PathBuf,
}

impl FileIndexerState {
    pub fn new(data_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&data_dir);
        let cfg = load_config(&data_dir).unwrap_or_default();
        Self {
            inner: Mutex::new(FileIndexerInner {
                child: None,
                stdin: None,
                status: FileIndexerStatus {
                    phase: if cfg.setup_done {
                        "idle".into()
                    } else {
                        "needs_setup".into()
                    },
                    setup_done: cfg.setup_done,
                    ..Default::default()
                },
                data_dir,
            }),
            pending: Mutex::new(HashMap::new()),
            next_search_id: AtomicU64::new(1),
        }
    }
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CONFIG_FILE)
}

fn roots_path(data_dir: &Path) -> PathBuf {
    data_dir.join(ROOTS_FILE)
}

fn load_config(data_dir: &Path) -> Result<FileIndexerConfig, String> {
    let path = config_path(data_dir);
    if path.exists() {
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        return serde_json::from_str(&raw).map_err(|e| e.to_string());
    }

    // Installer may write roots.txt (+ optional mode.txt) without config.json.
    let roots_file = roots_path(data_dir);
    if roots_file.exists() {
        let roots: Vec<String> = std::fs::read_to_string(&roots_file)
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        if !roots.is_empty() {
            let mode = std::fs::read_to_string(data_dir.join("mode.txt"))
                .unwrap_or_else(|_| "custom".into())
                .trim()
                .to_string();
            let cfg = FileIndexerConfig {
                setup_done: true,
                mode: if mode.is_empty() { "custom".into() } else { mode },
                roots,
            };
            // Persist canonical config for the app going forward.
            let _ = save_config(data_dir, &cfg);
            return Ok(cfg);
        }
    }

    Ok(FileIndexerConfig::default())
}

fn save_config(data_dir: &Path, cfg: &FileIndexerConfig) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_path(data_dir), raw).map_err(|e| e.to_string())?;
    let roots_body = cfg.roots.join("\n");
    std::fs::write(roots_path(data_dir), roots_body).map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve fastembed cache parent (contains `models--Qdrant--…`).
///
/// Install layout (preferred):
///   `{GENHAT_MODEL_PATH|INSTDIR/models}/fileindexer/models--Qdrant--all-MiniLM-L6-v2-onnx/`
///
/// Dev fallback: `C:\Users\assas\CODEBASES` if the model was dropped there for local testing.
pub fn resolve_cache_dir(app_data_dir: &Path) -> PathBuf {
    if let Ok(val) = std::env::var("FILEINDEXER_CACHE_DIR") {
        let p = PathBuf::from(val);
        if p.is_dir() {
            return p;
        }
    }

    // Same models root the rest of NELA uses (installer puts models under INSTDIR\models,
    // and main.rs may remap to a writable user models dir via GENHAT_MODEL_PATH).
    let models_root = crate::paths::resolve_models_dir();
    let installed = models_root.join("fileindexer");
    if model_onnx_present(&installed) || installed.is_dir() {
        let _ = std::fs::create_dir_all(&installed);
        return installed;
    }

    // Dev convenience: model dropped next to CODEBASES workspace.
    let codebase_cache = PathBuf::from(r"C:\Users\assas\CODEBASES");
    if model_onnx_present(&codebase_cache) {
        return codebase_cache;
    }

    // Fresh install / first configure: create the canonical install-relative path.
    let _ = std::fs::create_dir_all(&installed);
    if installed.exists() {
        return installed;
    }

    let local = app_data_dir.join("fileindexer").join("models");
    let _ = std::fs::create_dir_all(&local);
    local
}

fn model_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join(MODEL_DIR_NAME)
}

fn model_onnx_present(cache_dir: &Path) -> bool {
    let root = model_dir(cache_dir);
    let snapshots = root.join("snapshots");
    if !snapshots.is_dir() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(&snapshots) else {
        return false;
    };
    for entry in entries.flatten() {
        let onnx = entry.path().join("model.onnx");
        if onnx.is_file() {
            if let Ok(meta) = std::fs::metadata(&onnx) {
                if meta.len() > 1_000_000 {
                    return true;
                }
            }
        }
    }
    false
}

fn model_size_mb(cache_dir: &Path) -> u64 {
    let root = model_dir(cache_dir);
    let mut total = 0u64;
    fn walk(path: &Path, total: &mut u64) {
        let Ok(rd) = std::fs::read_dir(path) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, total);
            } else if let Ok(m) = e.metadata() {
                *total += m.len();
            }
        }
    }
    walk(&root, &mut total);
    total / (1024 * 1024)
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

/// Default FileIndexer roots: the signed-in user's home directory only.
/// Never indexes OS roots (`/` / drive letters) — those can contain sensitive system data.
fn default_user_roots() -> Vec<String> {
    user_home_dir()
        .map(|home| vec![home.to_string_lossy().to_string()])
        .unwrap_or_default()
}

fn path_is_under_or_equal(path: &Path, ancestor: &Path) -> bool {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let ancestor = ancestor.canonicalize().unwrap_or_else(|_| ancestor.to_path_buf());
    path == ancestor || path.starts_with(&ancestor)
}

fn resolve_sidecar_binary() -> Result<PathBuf, String> {
    if let Ok(val) = std::env::var("FILEINDEXER_SIDECAR") {
        let p = PathBuf::from(val);
        if p.is_file() {
            return Ok(p);
        }
    }

    let mut candidates = vec![
        PathBuf::from(r"C:\Users\assas\CODEBASES\FileIndexer\target\release\fileindexer_sidecar.exe"),
        PathBuf::from(r"C:\Users\assas\CODEBASES\FileIndexer\target\debug\fileindexer_sidecar.exe"),
    ];

    if let Ok(target_dir) = std::env::var("CARGO_TARGET_DIR") {
        candidates.push(PathBuf::from(&target_dir).join("release").join("fileindexer_sidecar.exe"));
        candidates.push(PathBuf::from(&target_dir).join("debug").join("fileindexer_sidecar.exe"));
        candidates.push(PathBuf::from(&target_dir).join("release").join("fileindexer_sidecar"));
        candidates.push(PathBuf::from(&target_dir).join("debug").join("fileindexer_sidecar"));
    }

    // Next to the running NELA binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("fileindexer_sidecar.exe"));
            candidates.push(dir.join("fileindexer_sidecar"));
        }
    }

    for c in candidates {
        if c.is_file() {
            return Ok(c);
        }
    }

    Err(
        "fileindexer_sidecar not found. Build it with: cargo build --release --bin fileindexer_sidecar (in FileIndexer), or set FILEINDEXER_SIDECAR"
            .into(),
    )
}

fn stop_child(inner: &mut FileIndexerInner) {
    if let Some(mut stdin) = inner.stdin.take() {
        let _ = writeln!(stdin, r#"{{"cmd":"shutdown"}}"#);
        let _ = stdin.flush();
    }
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    inner.status.running = false;
}

fn fail_pending(state: &FileIndexerState, err: &str) {
    if let Ok(mut pending) = state.pending.lock() {
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(err.to_string()));
        }
    }
}

fn parse_search_hits(v: &serde_json::Value) -> Vec<FileIndexerHit> {
    v.get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    Some(FileIndexerHit {
                        path: item.get("path")?.as_str()?.to_string(),
                        score: item.get("score")?.as_f64().unwrap_or(0.0),
                        fields: item
                            .get("fields")
                            .and_then(|f| f.as_array())
                            .map(|fields| {
                                fields
                                    .iter()
                                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn spawn_sidecar(app: &AppHandle, state: &FileIndexerState) -> Result<(), String> {
    let data_dir = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.data_dir.clone()
    };
    let cfg = load_config(&data_dir)?;
    if !cfg.setup_done || cfg.roots.is_empty() {
        return Err("File indexing is not configured yet".into());
    }
    save_config(&data_dir, &cfg)?;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let cache_dir = resolve_cache_dir(&app_data);
    if !model_onnx_present(&cache_dir) {
        return Err(format!(
            "Embedding model missing under {}. Expected {MODEL_DIR_NAME}/snapshots/*/model.onnx",
            cache_dir.display()
        ));
    }

    let bin = resolve_sidecar_binary()?;

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    stop_child(&mut guard);
    fail_pending(state, "File indexer restarted");

    let mut cmd = Command::new(&bin);
    cmd.arg("--data-dir")
        .arg(&data_dir)
        .arg("--cache-dir")
        .arg(&cache_dir)
        .arg("--roots-file")
        .arg(roots_path(&data_dir))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {e}", bin.display()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout missing".to_string())?;
    let stderr = child.stderr.take();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "sidecar stdin missing".to_string())?;

    guard.child = Some(child);
    guard.stdin = Some(stdin);
    guard.status.running = true;
    guard.status.phase = "starting".into();
    guard.status.message = "Starting file indexer…".into();
    guard.status.setup_done = true;
    let initial = guard.status.clone();
    drop(guard);

    let _ = app.emit("fileindexer:status", &initial);

    let app_handle = app.clone();

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            match v.get("event").and_then(|e| e.as_str()) {
                Some("status") => {
                    let status = FileIndexerStatus {
                        phase: v
                            .get("phase")
                            .and_then(|x| x.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        files_total: v.get("files_total").and_then(|x| x.as_u64()).unwrap_or(0)
                            as usize,
                        files_embedded: v
                            .get("files_embedded")
                            .and_then(|x| x.as_u64())
                            .unwrap_or(0) as usize,
                        embed_done: v.get("embed_done").and_then(|x| x.as_u64()).unwrap_or(0)
                            as usize,
                        embed_total: v.get("embed_total").and_then(|x| x.as_u64()).unwrap_or(0)
                            as usize,
                        message: v
                            .get("message")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string(),
                        running: true,
                        setup_done: true,
                    };
                    if let Some(st) = app_handle.try_state::<FileIndexerState>() {
                        if let Ok(mut g) = st.inner.lock() {
                            g.status = status.clone();
                        }
                    }
                    let _ = app_handle.emit("fileindexer:status", &status);
                }
                Some("search_result") => {
                    let id = v.get("id").and_then(|x| x.as_u64());
                    let hits = parse_search_hits(&v);
                    if let (Some(id), Some(st)) = (id, app_handle.try_state::<FileIndexerState>()) {
                        if let Ok(mut pending) = st.pending.lock() {
                            if let Some(tx) = pending.remove(&id) {
                                let _ = tx.send(Ok(hits));
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        if let Some(st) = app_handle.try_state::<FileIndexerState>() {
            fail_pending(&st, "File indexer stopped");
            if let Ok(mut g) = st.inner.lock() {
                g.child = None;
                g.stdin = None;
                g.status.running = false;
                if g.status.phase != "ready" && g.status.phase != "error" {
                    g.status.phase = "stopped".into();
                    g.status.message = "File indexer stopped".into();
                }
                let final_status = g.status.clone();
                let _ = app_handle.emit("fileindexer:status", &final_status);
            }
        }
    });

    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                log::warn!("[fileindexer_sidecar] {line}");
            }
        });
    }

    Ok(())
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn fileindexer_get_setup(
    state: State<'_, FileIndexerState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let data_dir = state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .data_dir
        .clone();
    let cfg = load_config(&data_dir)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let cache_dir = resolve_cache_dir(&app_data);
    let model = FileIndexerModelInfo {
        id: "fileindexer-minilm-l6-v2q".into(),
        name: "all-MiniLM-L6-v2 (quantized ONNX)".into(),
        present: model_onnx_present(&cache_dir),
        cache_dir: cache_dir.display().to_string(),
        model_dir: model_dir(&cache_dir).display().to_string(),
        size_mb: model_size_mb(&cache_dir).max(87),
    };
    let status = state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .status
        .clone();
    Ok(serde_json::json!({
        "config": cfg,
        "model": model,
        "status": status,
        "defaultRoots": default_user_roots(),
    }))
}

#[tauri::command]
pub fn fileindexer_complete_setup(
    mode: String,
    roots: Vec<String>,
    state: State<'_, FileIndexerState>,
    app: AppHandle,
) -> Result<FileIndexerStatus, String> {
    if roots.is_empty() {
        return Err("Select at least one folder to index".into());
    }
    let home = user_home_dir().ok_or_else(|| {
        "Could not resolve your home folder. Set HOME (or USERPROFILE on Windows).".to_string()
    })?;
    for r in &roots {
        let path = PathBuf::from(r);
        if !path.is_dir() {
            return Err(format!("Not a valid folder: {r}"));
        }
        if !path_is_under_or_equal(&path, &home) {
            return Err(format!(
                "Only folders inside your home directory can be indexed (refused: {r})"
            ));
        }
    }
    let data_dir = state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .data_dir
        .clone();
    let cfg = FileIndexerConfig {
        setup_done: true,
        mode,
        roots,
    };
    save_config(&data_dir, &cfg)?;
    // Rebuild from the new root set (old index may contain paths outside the new selection).
    let index_path = data_dir.join("file_indexer_index.bin");
    let _ = std::fs::remove_file(&index_path);
    {
        let mut g = state.inner.lock().map_err(|e| e.to_string())?;
        g.status.setup_done = true;
        g.status.phase = "configured".into();
        g.status.message = "Folders saved — starting indexer…".into();
        g.status.files_total = 0;
        g.status.files_embedded = 0;
        g.status.embed_done = 0;
        g.status.embed_total = 0;
    }
    spawn_sidecar(&app, &*state)?;
    let status = state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .status
        .clone();
    Ok(status)
}

#[tauri::command]
pub fn fileindexer_get_status(state: State<'_, FileIndexerState>) -> Result<FileIndexerStatus, String> {
    Ok(state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .status
        .clone())
}

#[tauri::command]
pub fn fileindexer_start(state: State<'_, FileIndexerState>, app: AppHandle) -> Result<FileIndexerStatus, String> {
    spawn_sidecar(&app, &*state)?;
    Ok(state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .status
        .clone())
}

#[tauri::command]
pub fn fileindexer_stop(state: State<'_, FileIndexerState>) -> Result<FileIndexerStatus, String> {
    stop_managed(&*state)?;
    Ok(state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .status
        .clone())
}

#[tauri::command]
pub fn fileindexer_search(
    query: String,
    state: State<'_, FileIndexerState>,
) -> Result<Vec<FileIndexerHit>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let (tx, rx) = mpsc::sync_channel(1);
    let id = state.next_search_id.fetch_add(1, Ordering::Relaxed);

    state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, tx);

    {
        let mut g = state.inner.lock().map_err(|e| e.to_string())?;
        if !g.status.setup_done {
            if let Ok(mut pending) = state.pending.lock() {
                pending.remove(&id);
            }
            return Err("File indexing is not configured yet".into());
        }
        if g.status.phase != "ready" {
            if let Ok(mut pending) = state.pending.lock() {
                pending.remove(&id);
            }
            return Err(format!(
                "File indexer is not ready yet (status: {}). Wait until indexing finishes.",
                g.status.phase
            ));
        }
        let stdin = match g.stdin.as_mut() {
            Some(s) => s,
            None => {
                if let Ok(mut pending) = state.pending.lock() {
                    pending.remove(&id);
                }
                return Err("File indexer is not running".into());
            }
        };
        let payload = serde_json::json!({
            "cmd": "search",
            "query": q,
            "id": id,
        });
        if let Err(e) = writeln!(stdin, "{payload}").and_then(|_| stdin.flush()) {
            if let Ok(mut pending) = state.pending.lock() {
                pending.remove(&id);
            }
            return Err(format!("Failed to write search: {e}"));
        }
    }

    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(result) => result,
        Err(_) => {
            if let Ok(mut pending) = state.pending.lock() {
                pending.remove(&id);
            }
            Err("File search timed out".into())
        }
    }
}

pub fn try_autostart(app: &AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<FileIndexerState>()
        .ok_or_else(|| "FileIndexerState not managed".to_string())?;
    spawn_sidecar(app, &*state)
}

pub fn stop_managed(state: &FileIndexerState) -> Result<(), String> {
    fail_pending(state, "File indexer stopped");
    let mut g = state.inner.lock().map_err(|e| e.to_string())?;
    stop_child(&mut g);
    g.status.phase = "stopped".into();
    g.status.message = "Stopped".into();
    Ok(())
}

pub fn stop_from_app(app: &AppHandle) {
    if let Some(st) = app.try_state::<FileIndexerState>() {
        let _ = stop_managed(&*st);
    }
}
