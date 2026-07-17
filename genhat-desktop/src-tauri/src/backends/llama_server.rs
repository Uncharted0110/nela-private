//! llama-server backend in **router mode**.
//!
//! One long-lived `llama-server` parent process hosts all `llama_server` models via
//! `--models-preset` + `--models-max`. Clients select a model with the OpenAI
//! `"model"` field (GenHat model id). `start()` loads a model; `stop()` unloads it
//! without killing the parent (parent dies only on `shutdown_router()` / app exit).

use crate::backends::ModelBackend;
use crate::governor::HostProfile;
use crate::registry::types::{
    ModelDef, ModelHandle, ModelHandle::Process, ProcessHandle, TaskRequest, TaskResponse,
};
use async_trait::async_trait;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

/// Kill any stale llama-server processes from previous app runs.
/// Called at startup to reclaim GPU/memory resources leaked by zombie processes.
#[cfg(unix)]
pub fn kill_stale_llama_servers() {
    // Get our own PID so we don't kill our own children (they haven't been spawned yet at startup)
    let my_pid = std::process::id();

    // Find all llama-server processes owned by the current user
    let output = match Command::new("pgrep").args(["-f", "llama-server"]).output() {
        Ok(o) => o,
        Err(_) => return, // pgrep not available, skip cleanup
    };

    let pids: Vec<u32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .filter(|&pid| pid != my_pid)
        .collect();

    if pids.is_empty() {
        return;
    }

    log::info!(
        "Found {} stale llama-server process(es) from previous runs; killing them",
        pids.len()
    );

    for pid in &pids {
        unsafe {
            libc::kill(*pid as i32, libc::SIGKILL);
        }
    }

    // Give the OS a moment to reap
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Count how many are still alive (UE state processes can't be killed)
    let still_alive: Vec<&u32> = pids
        .iter()
        .filter(|&&pid| unsafe { libc::kill(pid as i32, 0) } == 0)
        .collect();

    if still_alive.is_empty() {
        log::info!("All stale llama-server processes cleaned up");
    } else {
        log::warn!(
            "{} llama-server process(es) are in uninterruptible state and cannot be killed. \
             A reboot may be required to reclaim Metal GPU resources: PIDs {:?}",
            still_alive.len(),
            still_alive
        );
    }
}

#[cfg(not(unix))]
pub fn kill_stale_llama_servers() {
    // No-op on non-Unix platforms; Windows uses taskkill in stop()
}

#[derive(Debug)]
pub struct LlamaServerBackend;

impl LlamaServerBackend {
    pub fn new() -> Self {
        Self
    }
}

/// Resolve the llama-server executable path.
/// Uses the shared `paths::resolve_bundled_binary` helper which checks both
/// dev locations (ancestor walk) and production Tauri resource directories.
fn http_client_with_timeout(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

// ── Shared router singleton ──────────────────────────────────────────────────

struct SharedRouter {
    child: Child,
    pid: u32,
    port: u16,
    http_client: reqwest::Client,
    preset_path: PathBuf,
    preset_hash: u64,
    /// Model ids currently tracked as loaded by GenHat (best-effort).
    loaded: HashSet<String>,
}

static ROUTER: Mutex<Option<SharedRouter>> = Mutex::new(None);
static KNOWN_DEFS: Mutex<Vec<ModelDef>> = Mutex::new(Vec::new());

/// Publish the full set of known model defs so the router preset stays complete.
pub fn update_known_defs(defs: Vec<ModelDef>) {
    if let Ok(mut g) = KNOWN_DEFS.lock() {
        *g = defs;
    }
}

fn known_defs_snapshot() -> Vec<ModelDef> {
    KNOWN_DEFS.lock().map(|g| g.clone()).unwrap_or_default()
}

/// Port of the shared router, if running.
pub fn router_port() -> Option<u16> {
    ROUTER.lock().ok().and_then(|g| g.as_ref().map(|r| r.port))
}

fn resolve_llama_exe() -> Result<PathBuf, String> {
    let os_folder = crate::paths::llama_os_folder();

    let exe_names: Vec<&str> = if cfg!(windows) {
        vec!["llama-server.exe"]
    } else if cfg!(target_os = "macos") {
        vec![
            "llama-server",
            "llama-server-macos",
            "llama-server-macos-arm64",
        ]
    } else {
        vec!["llama-server"]
    };

    crate::paths::resolve_bundled_binary(os_folder, &exe_names)
        .map_err(|e| format!("llama-server not found. {e}"))
}

fn lower_process_priority(child: &Child) {
    let gov = crate::governor::Governor::new();
    if !(gov.on_battery() || gov.thermal_pressure()) {
        log::info!(
            "Keeping llama-server pid={} at normal priority (AC/cool)",
            child.id()
        );
        return;
    }

    let pid = child.id();

    #[cfg(unix)]
    {
        let ret = unsafe { libc::setpriority(libc::PRIO_PROCESS as _, pid as _, 10) };
        if ret == 0 {
            log::info!("Set llama-server pid={pid} priority to nice=10 (battery/thermal)");
        } else {
            log::warn!(
                "Failed to lower llama-server priority for pid={pid}: {}",
                std::io::Error::last_os_error()
            );
        }
    }

    #[cfg(windows)]
    {
        let script = format!(
            "$p = Get-Process -Id {pid} -ErrorAction SilentlyContinue; if ($p) {{ $p.PriorityClass = 'BelowNormal' }}"
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        crate::windows_spawn::hide_console_std(&mut cmd);
        if let Err(e) = cmd.output() {
            log::warn!("Failed to lower llama-server priority for pid={pid} on Windows: {e}");
        }
    }
}

fn attach_log_pipes(child: &mut Child, log_path: &Path) {
    let pid = child.id();
    if let Some(stdout) = child.stdout.take() {
        let lp = log_path.to_path_buf();
        std::thread::spawn(move || {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&lp) {
                for line in BufReader::new(stdout).lines().flatten() {
                    let _ = writeln!(f, "[stdout][pid={pid}] {line}");
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let lp = log_path.to_path_buf();
        std::thread::spawn(move || {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&lp) {
                for line in BufReader::new(stderr).lines().flatten() {
                    if line.contains("system_info") || line.contains("load_backend") {
                        log::info!("llama-server cpu/backend: {line}");
                    }
                    let _ = writeln!(f, "[stderr][pid={pid}] {line}");
                }
            }
        });
    }
}

fn spawn_router_process(preset_path: &Path, port: u16) -> Result<Child, String> {
    let exe = resolve_llama_exe()?;
    let work_dir = exe
        .parent()
        .ok_or_else(|| "llama-server exe has no parent dir".to_string())?;

    let host = HostProfile::detect();
    let gov = crate::governor::Governor::new();
    let threads = host.inference_threads(gov.on_battery(), gov.thermal_pressure());
    let models_max = host.models_max();
    let use_no_mmap = host.prefer_no_mmap();
    let parallel = crate::backends::llama_router_preset::LLAMA_ROUTER_PARALLEL_SLOTS;

    let log_path = std::env::temp_dir().join(format!("genhat-llama-router-{port}.log"));
    if let Ok(mut log_file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let _ = writeln!(log_file, "--- llama-server router start (port {port}) ---");
        let _ = writeln!(log_file, "exe: {}", exe.display());
        let _ = writeln!(log_file, "preset: {}", preset_path.display());
        let _ = writeln!(log_file, "models-max: {models_max}");
        let _ = writeln!(log_file, "parallel: {parallel}");
    }

    let mut args = vec![
        "--models-preset".to_string(),
        preset_path.to_string_lossy().to_string(),
        "--models-max".to_string(),
        models_max.to_string(),
        "--port".to_string(),
        port.to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--threads".to_string(),
        threads.to_string(),
        "--threads-batch".to_string(),
        threads.to_string(),
        "--parallel".to_string(),
        parallel.to_string(),
        // GenHat assigns id_slot per chat/workspace — do not auto-match by prompt similarity.
        "--slot-prompt-similarity".to_string(),
        "0".to_string(),
        "-fit".to_string(),
        "off".to_string(),
        // Jinja chat templates are required for OpenAI-style tools / tool_calls.
        "--jinja".to_string(),
    ];
    if use_no_mmap {
        args.push("--no-mmap".to_string());
    }

    let mut spawn_cmd = Command::new(&exe);
    // Isolate from ~/.cache/llama.cpp so only GenHat presets are exposed.
    let isolated_cache = std::env::temp_dir().join("genhat-llama-cache");
    let _ = std::fs::create_dir_all(&isolated_cache);
    spawn_cmd
        .args(&args)
        .current_dir(work_dir)
        .env("LLAMA_CACHE", &isolated_cache)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    crate::windows_spawn::hide_console_std(&mut spawn_cmd);

    let mut child = spawn_cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn llama-server router: {e}"))?;

    lower_process_priority(&child);
    attach_log_pipes(&mut child, &log_path);

    log::info!(
        "llama-server router spawned: pid={}, port={}, models_max={}, parallel={}, threads={}, preset={}",
        child.id(),
        port,
        models_max,
        parallel,
        threads,
        preset_path.display()
    );
    log::info!(
        "llama-server router cmd: {} {}",
        exe.display(),
        args.join(" ")
    );
    Ok(child)
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let mut taskkill_cmd = Command::new("taskkill");
        taskkill_cmd.args(["/F", "/PID", &pid.to_string()]);
        crate::windows_spawn::hide_console_std(&mut taskkill_cmd);
        let _ = taskkill_cmd.output();
    }
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(300));
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

/// Tear down the shared router parent (app shutdown / forced restart).
pub async fn shutdown_router() {
    let mut guard = match ROUTER.lock() {
        Ok(g) => g,
        Err(e) => {
            log::warn!("Router lock poisoned on shutdown: {e}");
            return;
        }
    };
    if let Some(mut router) = guard.take() {
        log::info!("Shutting down llama-server router pid={}", router.pid);
        let _ = router.child.kill();
        let _ = router.child.wait();
        kill_pid(router.pid);
    }
}

async fn ensure_router(models_dir: &Path, force_restart: bool) -> Result<(u16, reqwest::Client, u32, PathBuf), String> {
    let mut defs = known_defs_snapshot();
    if defs.is_empty() {
        defs = crate::config::load_model_definitions().unwrap_or_default();
    }
    let (preset_path, preset_hash) =
        crate::backends::llama_router_preset::write_preset(&defs, models_dir)?;

    {
        let guard = ROUTER.lock().map_err(|e| format!("Router lock poisoned: {e}"))?;
        if let Some(router) = guard.as_ref() {
            let alive = {
                #[cfg(unix)]
                {
                    unsafe { libc::kill(router.pid as i32, 0) == 0 }
                }
                #[cfg(windows)]
                {
                    true // best-effort; health check below
                }
            };
            if alive && !force_restart && router.preset_hash == preset_hash {
                return Ok((
                    router.port,
                    router.http_client.clone(),
                    router.pid,
                    router.preset_path.clone(),
                ));
            }
        }
    }

    // Restart if needed
    {
        let mut guard = ROUTER.lock().map_err(|e| format!("Router lock poisoned: {e}"))?;
        if let Some(mut old) = guard.take() {
            log::info!(
                "Restarting llama-server router (force={force_restart}, preset_changed={})",
                old.preset_hash != preset_hash
            );
            let _ = old.child.kill();
            let _ = old.child.wait();
            kill_pid(old.pid);
        }
    }

    let port = portpicker::pick_unused_port().ok_or("No free port available for router")?;
    let mut child = spawn_router_process(&preset_path, port)?;
    let pid = child.id();
    let http_client = reqwest::Client::builder()
        .pool_max_idle_per_host(4)
        .tcp_keepalive(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Failed to create router HTTP client: {e}"))?;

    if let Err(e) = wait_for_ready(port, pid, 120).await {
        let _ = child.kill();
        kill_pid(pid);
        return Err(e);
    }

    let client_clone = http_client.clone();
    let mut guard = ROUTER.lock().map_err(|e| format!("Router lock poisoned: {e}"))?;
    *guard = Some(SharedRouter {
        child,
        pid,
        port,
        http_client,
        preset_path: preset_path.clone(),
        preset_hash,
        loaded: HashSet::new(),
    });

    Ok((port, client_clone, pid, preset_path))
}

async fn router_load_model(port: u16, client: &reqwest::Client, model_id: &str) -> Result<(), String> {
    // Prefer explicit load; fall back to autoload on first inference if endpoint fails.
    let url = format!("http://127.0.0.1:{port}/models/load");
    let body = serde_json::json!({ "model": model_id });
    match client.post(&url).json(&body).send().await {
        Ok(resp) if resp.status().is_success() => {
            log::info!("Router loaded model '{model_id}' via /models/load");
            Ok(())
        }
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            // Autoload may still work on first chat request.
            log::warn!(
                "/models/load for '{model_id}' returned {status}: {text}; relying on autoload"
            );
            Ok(())
        }
        Err(e) => {
            log::warn!("/models/load for '{model_id}' failed: {e}; relying on autoload");
            Ok(())
        }
    }
}

async fn router_unload_model(port: u16, client: &reqwest::Client, model_id: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/models/unload");
    let body = serde_json::json!({ "model": model_id });
    match client.post(&url).json(&body).send().await {
        Ok(resp) if resp.status().is_success() => {
            log::info!("Router unloaded model '{model_id}'");
            Ok(())
        }
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            log::warn!("/models/unload for '{model_id}' returned {status}: {text}");
            Ok(())
        }
        Err(e) => {
            log::warn!("/models/unload for '{model_id}' failed: {e}");
            Ok(())
        }
    }
}

fn mark_loaded(model_id: &str, loaded: bool) {
    if let Ok(mut guard) = ROUTER.lock() {
        if let Some(router) = guard.as_mut() {
            if loaded {
                router.loaded.insert(model_id.to_string());
            } else {
                router.loaded.remove(model_id);
            }
        }
    }
}

fn request_model_id(request: &TaskRequest) -> String {
    request
        .extra
        .get("router_model")
        .cloned()
        .or_else(|| request.model_override.clone())
        .unwrap_or_else(|| "local".to_string())
}

/// Wait for llama-server to become ready by polling its /health endpoint.
/// Also monitors whether the process is still alive — exits early if it crashes
/// or appears stuck (zero RSS after a grace period, indicating a Metal GPU hang).
async fn wait_for_ready(port: u16, pid: u32, timeout_secs: u64) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();
    let start_time = Instant::now();
    let deadline = start_time + std::time::Duration::from_secs(timeout_secs);

    // Grace period before we start checking if the process is stuck (no RSS).
    // Metal GPU init can take a few seconds even on a healthy start.
    let stuck_check_after = std::time::Duration::from_secs(15);

    // Adaptive poll backoff: start fast (50ms), ramp up to 500ms.
    // This keeps cold-start latency low while reducing CPU churn once the
    // model is actually loading memory.
    let poll_delays_ms: &[u64] = &[50, 100, 200, 500];
    let mut poll_step: usize = 0;

    loop {
        if Instant::now() > deadline {
            // Timeout — kill the process since it's likely stuck
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            return Err(format!(
                "llama-server on port {port} did not become ready within {timeout_secs}s"
            ));
        }

        // Check if the process has exited (crashed on startup).
        // Use waitpid(WNOHANG) to detect zombies that kill(pid,0) misses.
        #[cfg(unix)]
        {
            let mut status: libc::c_int = 0;
            let ret = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
            if ret > 0 {
                // Process has exited — it's a zombie we just reaped
                let log_path = std::env::temp_dir().join(format!("genhat-llama-server-{port}.log"));
                let hint = if log_path.exists() {
                    format!(" Check log: {}", log_path.display())
                } else {
                    String::new()
                };
                return Err(format!(
                    "llama-server (pid={pid}) crashed before becoming ready.{hint}"
                ));
            } else if ret < 0 {
                // ECHILD — not our child or already reaped; fall back to kill check
                let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
                if !alive {
                    let log_path = std::env::temp_dir().join(format!("genhat-llama-server-{port}.log"));
                    let hint = if log_path.exists() {
                        format!(" Check log: {}", log_path.display())
                    } else {
                        String::new()
                    };
                    return Err(format!(
                        "llama-server (pid={pid}) crashed before becoming ready.{hint}"
                    ));
                }
            }
            // ret == 0 means process is still running — continue polling

            // Detect stuck processes (e.g. hung in Metal GPU init): after the grace
            // period, check if the process has any resident memory. A stuck process
            // will have near-zero RSS because it never got past initialization.
            if start_time.elapsed() > stuck_check_after {
                if let Ok(rss) = get_process_rss(pid) {
                    // A model that's actually loading will have at least a few MB of RSS.
                    // Stuck processes typically show 0 or near-0 (just the process table entry).
                    if rss < 1024 {
                        log::warn!(
                            "llama-server pid={pid} appears stuck (RSS={rss} KB after {:?}); killing",
                            start_time.elapsed()
                        );
                        unsafe {
                            libc::kill(pid as i32, libc::SIGKILL);
                        }
                        return Err(format!(
                            "llama-server (pid={pid}) appears stuck during initialization (RSS={rss} KB). \
                             This is usually caused by stale processes holding Metal GPU resources. \
                             Try restarting the app or rebooting if the problem persists."
                        ));
                    }
                }
            }
        }

        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                log::info!("llama-server on port {port} is ready");
                return Ok(());
            }
            _ => {
                let delay_ms = poll_delays_ms[poll_step.min(poll_delays_ms.len() - 1)];
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                if poll_step < poll_delays_ms.len() - 1 {
                    poll_step += 1;
                }
            }
        }
    }
}

/// Get the resident set size (RSS) of a process in KB.
#[cfg(unix)]
fn get_process_rss(pid: u32) -> Result<u64, String> {
    // On macOS, use `ps -o rss= -p <pid>` to get RSS in KB
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .map_err(|e| format!("Failed to run ps: {e}"))?;
    
    let rss_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    rss_str.parse::<u64>().map_err(|e| format!("Failed to parse RSS '{rss_str}': {e}"))
}

#[async_trait]
impl ModelBackend for LlamaServerBackend {
    async fn start(&self, def: &ModelDef, models_dir: &Path) -> Result<ModelHandle, String> {
        let model_path = models_dir.join(&def.model_file);
        if !model_path.exists() {
            return Err(format!("Model file not found: {}", model_path.display()));
        }

        // Keep this model in the known-defs set used for preset generation.
        {
            let mut defs = known_defs_snapshot();
            if let Some(slot) = defs.iter_mut().find(|d| d.id == def.id) {
                *slot = def.clone();
            } else {
                defs.push(def.clone());
            }
            update_known_defs(defs);
        }

        let (port, http_client, pid, _preset) = ensure_router(models_dir, false).await?;
        router_load_model(port, &http_client, &def.id).await?;
        mark_loaded(&def.id, true);

        let work_dir = resolve_llama_exe()?
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| models_dir.to_path_buf());

        Ok(ModelHandle::Process(ProcessHandle {
            child: None, // parent owned by ROUTER singleton
            pid,
            port: Some(port),
            started_at: Instant::now(),
            work_dir,
            http_client: Some(http_client),
            router_model_id: Some(def.id.clone()),
        }))
    }

    async fn is_healthy(&self, handle: &ModelHandle) -> bool {
        match handle {
            Process(ph) => {
                if let Some(port) = ph.port {
                    let url = format!("http://127.0.0.1:{port}/health");
                    reqwest::get(&url)
                        .await
                        .map(|r| r.status().is_success())
                        .unwrap_or(false)
                } else {
                    false
                }
            }
            _ => false,
        }
    }

    async fn execute(
        &self,
        handle: &ModelHandle,
        request: &TaskRequest,
        _models_dir: &Path,
    ) -> Result<TaskResponse, String> {
        let (port, persistent_client) = match handle {
            Process(ph) => (
                ph.port.ok_or("llama-server has no port assigned")?,
                ph.http_client.as_ref(),
            ),
            _ => return Err("LlamaServerBackend requires a ProcessHandle".into()),
        };

        // ── Embedding requests go to /v1/embeddings ──
        if request.task_type == crate::registry::types::TaskType::Embed {
            return self.execute_embedding(port, request, persistent_client).await;
        }

        // ── Classification requests get a short completion and parse the label ──
        if request.task_type == crate::registry::types::TaskType::Classify {
            return self.execute_classification(port, request, persistent_client).await;
        }

        let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
        let model_name = request_model_id(request);

        // Build the chat messages. The task type determines the system prompt.
        let system_prompt = match &request.task_type {
            crate::registry::types::TaskType::Summarize => {
                "You are a helpful assistant that creates concise summaries."
            }
            crate::registry::types::TaskType::Mindmap => {
                "You are a helpful assistant that generates structured mindmaps in markdown format."
            }
            crate::registry::types::TaskType::Enrich => {
                "You are a helpful assistant. Generate a brief contextual description (50-100 tokens) for the following text chunk to improve its searchability."
            }
            crate::registry::types::TaskType::Grade => {
                "You are a relevance grading assistant. Rate the relevance of the provided context to the query on a scale of 1-5. Respond with only the number."
            }
            crate::registry::types::TaskType::Hyde => {
                "You are a helpful assistant. Generate a hypothetical answer to the following question that could appear in a document."
            }
            crate::registry::types::TaskType::PodcastScript => {
                "You are a creative podcast scriptwriter. Generate engaging, natural-sounding dialogue based on the provided content."
            }
            crate::registry::types::TaskType::VisionChat => {
                "You are a helpful vision assistant that can describe and analyze images."
            }
            _ => "You are a helpful assistant.",
        };

        // Build the user message - handle vision requests with images
        let user_message = if request.task_type == crate::registry::types::TaskType::VisionChat {
            if let (Some(image_base64), Some(image_mime)) = (
                request.extra.get("image_base64"),
                request.extra.get("image_mime"),
            ) {
                serde_json::json!({
                    "role": "user",
                    "content": [
                        { "type": "text", "text": &request.input },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:{};base64,{}", image_mime, image_base64)
                            }
                        }
                    ]
                })
            } else {
                serde_json::json!({ "role": "user", "content": &request.input })
            }
        } else {
            serde_json::json!({ "role": "user", "content": &request.input })
        };

        let mut body = serde_json::json!({
            "model": model_name,
            "messages": [
                { "role": "system", "content": system_prompt },
                user_message
            ],
            "cache_prompt": true,
            "stream": false
        });

        if let Some(slot) = request.extra.get("id_slot") {
            if let Ok(n) = slot.parse::<i64>() {
                body["id_slot"] = serde_json::json!(n);
            }
        }

        if let Some(grammar) = request.extra.get("grammar") {
            if !grammar.is_empty() {
                body["grammar"] = serde_json::json!(grammar);
            }
        }

        if let Some(mt) = request.extra.get("max_tokens") {
            if let Ok(n) = mt.parse::<u32>() {
                body["max_tokens"] = serde_json::json!(n);
            }
        }

        if let Some(t) = request.extra.get("temperature") {
            if let Ok(v) = t.parse::<f64>() {
                body["temperature"] = serde_json::json!(v);
            }
        }

        match request.task_type {
            crate::registry::types::TaskType::Chat => {
                let enable_thinking = request
                    .extra
                    .get("enable_thinking")
                    .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
                    .unwrap_or_else(|| {
                        !request
                            .extra
                            .get("disable_thinking")
                            .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
                            .unwrap_or(true)
                    });

                if enable_thinking {
                    body["reasoning_format"] = serde_json::json!("deepseek");
                    body["reasoning_budget"] = serde_json::json!(-1);
                    body["chat_template_kwargs"] = serde_json::json!({"enable_thinking": true});
                } else {
                    body["reasoning_format"] = serde_json::json!("none");
                    body["reasoning_budget"] = serde_json::json!(0);
                    body["chat_template_kwargs"] = serde_json::json!({"enable_thinking": false});
                }
            }
            _ => {
                body["reasoning_format"] = serde_json::json!("none");
                body["reasoning_budget"] = serde_json::json!(0);
                body["chat_template_kwargs"] = serde_json::json!({"enable_thinking": false});
            }
        }

        let timeout_secs = match request.task_type {
            crate::registry::types::TaskType::Classify => 30,
            crate::registry::types::TaskType::Grade => 45,
            crate::registry::types::TaskType::Enrich
            | crate::registry::types::TaskType::Hyde => 120,
            crate::registry::types::TaskType::Summarize
            | crate::registry::types::TaskType::Mindmap
            | crate::registry::types::TaskType::PodcastScript => 180,
            _ => 90,
        };
        let owned_client;
        let client: &reqwest::Client = if let Some(c) = persistent_client {
            c
        } else {
            owned_client = http_client_with_timeout(timeout_secs)?;
            &owned_client
        };
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    format!(
                        "Request timed out after {}s. The model may be too slow for this task type ({:?}). \
                         Consider using a faster model or increasing the timeout.",
                        timeout_secs, request.task_type
                    )
                } else if e.is_connect() {
                    format!(
                        "Failed to connect to llama-server at port {}. The server may have crashed.",
                        port
                    )
                } else {
                    format!("HTTP request to llama-server failed: {e}")
                }
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("llama-server returned {status}: {text}"));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse llama-server response: {e}"))?;

        let content = json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();

        if request.task_type == crate::registry::types::TaskType::Chat {
            let reasoning = json["choices"][0]["message"]["reasoning_content"]
                .as_str()
                .map(|s| s.to_string());

            if reasoning.is_some() && !reasoning.as_ref().unwrap().is_empty() {
                return Ok(TaskResponse::ChatWithThinking { content, reasoning });
            }
        }

        Ok(TaskResponse::Text(content))
    }

    async fn stop(&self, handle: &ModelHandle) -> Result<(), String> {
        match handle {
            Process(ph) => {
                if let Some(model_id) = &ph.router_model_id {
                    if let (Some(port), Some(client)) = (ph.port, ph.http_client.as_ref()) {
                        router_unload_model(port, client, model_id).await?;
                    }
                    mark_loaded(model_id, false);
                    log::info!(
                        "Unloaded router model '{model_id}' (parent pid={} stays up)",
                        ph.pid
                    );
                    return Ok(());
                }

                // Legacy / non-router owned process
                log::info!("Stopping llama-server pid={}", ph.pid);
                kill_pid(ph.pid);
                Ok(())
            }
            _ => Err("LlamaServerBackend requires a ProcessHandle".into()),
        }
    }
}


// ── Embedding helper (outside the trait impl to keep it clean) ──
impl LlamaServerBackend {
    /// Classify a query using a DistilBERT-based router model.
    /// The model outputs a classification label as short text.
    async fn execute_classification(
        &self,
        port: u16,
        request: &TaskRequest,
        persistent_client: Option<&reqwest::Client>,
    ) -> Result<TaskResponse, String> {
        let url = format!("http://127.0.0.1:{port}/v1/chat/completions");

        let body = serde_json::json!({
            "model": request_model_id(request),
            "messages": [
                {
                    "role": "system",
                    "content": "You are a query classifier. Classify the user's query into exactly one of these categories: no_retrieval, simple_rag, multi_doc, summarization. Respond with only the category name."
                },
                {
                    "role": "user",
                    "content": &request.input
                }
            ],
            "cache_prompt": true,
            "stream": false,
            "temperature": 0.0,
            "max_tokens": 16
        });

        let owned_client;
        let client: &reqwest::Client = if let Some(c) = persistent_client {
            c
        } else {
            owned_client = http_client_with_timeout(15)?;
            &owned_client
        };
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Classification request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Classification endpoint returned {status}: {text}"));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse classification response: {e}"))?;

        let content = json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("simple_rag")
            .trim()
            .to_lowercase();

        // Parse the label and map to a confidence score
        let (label, confidence) = match content.as_str() {
            l if l.contains("no_retrieval") => ("no_retrieval".to_string(), 0.9),
            l if l.contains("simple_rag") => ("simple_rag".to_string(), 0.9),
            l if l.contains("multi_doc") => ("multi_doc".to_string(), 0.9),
            l if l.contains("summarization") => ("summarization".to_string(), 0.9),
            _ => ("simple_rag".to_string(), 0.5), // Default fallback
        };

        Ok(TaskResponse::Classification {
            label,
            confidence: confidence as f32,
        })
    }

    /// Call the /v1/embeddings endpoint on a llama-server running in --embedding mode.
    async fn execute_embedding(
        &self,
        port: u16,
        request: &TaskRequest,
        persistent_client: Option<&reqwest::Client>,
    ) -> Result<TaskResponse, String> {
        let url = format!("http://127.0.0.1:{port}/v1/embeddings");

        // Input is a JSON array of strings (from embed_request)
        let texts: Vec<String> = serde_json::from_str(&request.input)
            .unwrap_or_else(|_| vec![request.input.clone()]);

        let body = serde_json::json!({
            "model": request_model_id(request),
            "input": texts
        });

        let owned_client;
        let client: &reqwest::Client = if let Some(c) = persistent_client {
            c
        } else {
            owned_client = http_client_with_timeout(180)?;
            &owned_client
        };
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Embedding request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Embedding endpoint returned {status}: {text}"));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse embedding response: {e}"))?;

        // Parse the OpenAI-compatible response:
        // { "data": [ { "embedding": [f32...], "index": 0 }, ... ] }
        let data = json["data"]
            .as_array()
            .ok_or("Embedding response missing 'data' array")?;

        let mut embeddings: Vec<Vec<f32>> = Vec::with_capacity(data.len());
        for item in data {
            let embedding = item["embedding"]
                .as_array()
                .ok_or("Embedding item missing 'embedding' array")?;
            let vec: Vec<f32> = embedding
                .iter()
                .filter_map(|v| v.as_f64().map(|f| f as f32))
                .collect();
            embeddings.push(vec);
        }

        Ok(TaskResponse::Embeddings(embeddings))
    }
}
