//! Thermal & power governor — the "no space heater" mandate (revamp.md §3).
//!
//! Centrally tracks:
//!   - Battery / AC power state (best-effort, fails open → AC assumed)
//!   - Thermal pressure flag (set externally when sustained high temps detected)
//!
//! Provides:
//!   - `inference_threads()` — safe thread count for the current state
//!   - `indexer_duty_cycle()` — DutyCycleGuard configured for current state
//!   - `on_battery()` — direct battery check
//!
//! ## Module layout
//! - `cancel` — per-request `CancellationToken`
//! - `duty`   — `DutyCycleGuard` for background loops

pub mod cancel;
pub mod duty;

pub use cancel::CancellationToken;
pub use duty::DutyCycleGuard;

use std::sync::atomic::{AtomicBool, Ordering};

/// Hard cap: never use more than this many inference threads regardless of
/// physical core count. Leaves cores for the OS/UI and stays below thermal
/// throttle threshold.
pub const MAX_INFERENCE_THREADS: usize = 8;

/// Idle timeout (seconds) after which the active SLM is evicted from memory.
/// After eviction, idle RAM drops to < 150 MB (revamp.md §3.1 / §6.2).
pub const IDLE_EVICT_SECS: u64 = 180;

/// Central thermal and power governor.
///
/// Stored as `Arc<Governor>` in Tauri app state so every subsystem can read
/// current power/thermal conditions without additional IPC.
#[derive(Debug)]
pub struct Governor {
    /// True when the system is running on battery power.
    battery: AtomicBool,
    /// True when sustained thermal pressure has been flagged.
    thermal_pressure: AtomicBool,
}

impl Default for Governor {
    fn default() -> Self {
        Self::new()
    }
}

impl Governor {
    /// Create a new governor. Detects current battery state at construction.
    pub fn new() -> Self {
        let battery = detect_battery();
        let gov = Self {
            battery: AtomicBool::new(battery),
            thermal_pressure: AtomicBool::new(false),
        };
        log::info!(
            "Governor initialized: on_battery={}, max_inference_threads={}",
            battery,
            gov.inference_threads()
        );
        gov
    }

    /// Refresh the battery state. Call periodically from the lifecycle loop.
    pub fn refresh(&self) {
        let b = detect_battery();
        self.battery.store(b, Ordering::Relaxed);
    }

    /// Returns `true` when running on battery power.
    pub fn on_battery(&self) -> bool {
        self.battery.load(Ordering::Relaxed)
    }

    /// Returns `true` when thermal pressure is detected.
    pub fn thermal_pressure(&self) -> bool {
        self.thermal_pressure.load(Ordering::Relaxed)
    }

    /// Set or clear the thermal pressure flag.
    pub fn set_thermal_pressure(&self, v: bool) {
        self.thermal_pressure.store(v, Ordering::Relaxed);
    }

    /// Safe inference thread count for the current power/thermal state.
    ///
    /// | Condition           | Threads              |
    /// |---------------------|----------------------|
    /// | AC power, cool      | min(cores - 1, 8)    |
    /// | Battery or thermal  | min(cores / 2, 8)    |
    pub fn inference_threads(&self) -> usize {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);

        if self.on_battery() || self.thermal_pressure() {
            (cores / 2).max(1).min(MAX_INFERENCE_THREADS)
        } else {
            cores.saturating_sub(1).max(1).min(MAX_INFERENCE_THREADS)
        }
    }

    /// Build a `DutyCycleGuard` tuned for the current power state.
    pub fn indexer_duty_cycle(&self) -> DutyCycleGuard {
        if self.on_battery() {
            DutyCycleGuard::battery()
        } else {
            DutyCycleGuard::ac_power()
        }
    }
}

// ── Battery detection (best-effort, fails open → AC assumed) ─────────────────

fn detect_battery() -> bool {
    #[cfg(target_os = "linux")]
    return detect_battery_linux();

    #[cfg(target_os = "macos")]
    return detect_battery_macos();

    #[cfg(windows)]
    return detect_battery_windows();

    #[allow(unreachable_code)]
    false
}

#[cfg(target_os = "linux")]
fn detect_battery_linux() -> bool {
    // Check ACPI AC adapter: `online=1` means AC power (not on battery).
    let ac_paths = [
        "/sys/class/power_supply/AC/online",
        "/sys/class/power_supply/ACAD/online",
        "/sys/class/power_supply/AC0/online",
    ];
    for path in &ac_paths {
        if let Ok(s) = std::fs::read_to_string(path) {
            return s.trim() == "0"; // 0 = AC offline = on battery
        }
    }
    // Fallback: look for any BAT* with status=Discharging.
    if let Ok(entries) = std::fs::read_dir("/sys/class/power_supply") {
        for entry in entries.flatten() {
            let status_path = entry.path().join("status");
            if let Ok(s) = std::fs::read_to_string(status_path) {
                if s.trim().eq_ignore_ascii_case("Discharging") {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn detect_battery_macos() -> bool {
    // `pmset -g batt` prints "Now drawing from 'Battery Power'" when on battery.
    match std::process::Command::new("pmset")
        .args(["-g", "batt"])
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout).contains("Battery Power"),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn detect_battery_windows() -> bool {
    // Use PowerShell — avoids winapi dependency.
    // BatteryStatus 2 = AC Power; anything else = on battery / unknown.
    match std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-WmiObject -Class Win32_Battery | Select-Object -First 1 -ExpandProperty BatteryStatus) 2>$null",
        ])
        .output()
    {
        Ok(output) => {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // Empty string → no battery found → assume AC power.
            !s.is_empty() && s != "2"
        }
        Err(_) => false,
    }
}

/// Managed state wrapper for use with Tauri's state system.
pub struct GovernorState(pub std::sync::Arc<Governor>);
