//! Device-agnostic host capability probing.
//!
//! All inference tuning knobs (threads, memory budget, mmap/mlock, batch sizes)
//! are derived from measured hardware here — never from machine-specific constants
//! baked for one laptop.

use std::sync::OnceLock;

/// Snapshot of host resources used to size llama.cpp / process-manager policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostProfile {
    pub physical_cores: usize,
    pub logical_cores: usize,
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
}

impl HostProfile {
    /// Probe the running machine once and cache the core topology.
    /// RAM is re-read on each call so budgets track current free memory.
    pub fn detect() -> Self {
        let (physical, logical) = CORE_TOPOLOGY.get_or_init(probe_core_topology);
        let (total_ram_mb, available_ram_mb) = probe_ram_mb();
        Self {
            physical_cores: (*physical).max(1),
            logical_cores: (*logical).max(1),
            total_ram_mb,
            available_ram_mb,
        }
    }

    /// Construct a profile for unit tests (skips OS probing).
    pub fn synthetic(
        physical_cores: usize,
        logical_cores: usize,
        total_ram_mb: u64,
        available_ram_mb: u64,
    ) -> Self {
        Self {
            physical_cores: physical_cores.max(1),
            logical_cores: logical_cores.max(1),
            total_ram_mb,
            available_ram_mb,
        }
    }

    /// Inference worker count for llama.cpp `--threads` / `--threads-batch`.
    ///
    /// Rules (same on every device):
    /// - Never exceed **physical** cores (avoids SMT/hyperthread thrash).
    /// - Never exceed logical cores (sanity).
    /// - AC/cool: leave 1 physical core for OS/UI when the machine has >2 cores.
    /// - Battery/thermal: half of physical cores.
    pub fn inference_threads(&self, on_battery: bool, thermal_pressure: bool) -> usize {
        let ceiling = self
            .physical_cores
            .min(self.logical_cores)
            .max(1);

        if on_battery || thermal_pressure {
            (ceiling / 2).max(1)
        } else if ceiling <= 2 {
            ceiling
        } else {
            ceiling - 1
        }
    }

    /// Model-resident memory budget in MB. `0` = unlimited.
    ///
    /// Scales headroom with total RAM (25%, clamped). Machines with ≥32 GB
    /// get unlimited so warm previous / multi-model pipelines can co-reside.
    pub fn memory_budget_mb(&self) -> u32 {
        if self.total_ram_mb == 0 {
            return 0;
        }
        if self.total_ram_mb >= 32 * 1024 {
            return 0;
        }
        // 25% for OS + Electron + sidecars, clamped to [1.5 GB, 6 GB].
        let headroom = ((self.total_ram_mb * 25) / 100).clamp(1536, 6144);
        self.total_ram_mb
            .saturating_sub(headroom)
            .max(1024) as u32
    }

    /// Prefer `--no-mmap` when the host is memory-constrained.
    ///
    /// Triggered when total RAM ≤16 GB **or** less than ~40% of RAM is free
    /// (avoids page-cache thrash on busy mid-size machines).
    pub fn prefer_no_mmap(&self) -> bool {
        if self.total_ram_mb == 0 {
            return false;
        }
        if self.total_ram_mb <= 16 * 1024 {
            return true;
        }
        let free_ratio = self.available_ram_mb as f64 / self.total_ram_mb as f64;
        free_ratio < 0.40
    }

    /// Whether `--mlock` is safe. Locking the whole model on tiny hosts
    /// starves the OS and forces swap for everything else.
    pub fn prefer_mlock(&self) -> bool {
        self.total_ram_mb > 8 * 1024
    }

    /// Default `(batch_size, ubatch_size)` for prompt prefill.
    ///
    /// Scales with RAM so low-memory devices keep peak KV/activation under control.
    pub fn default_batch_sizes(&self) -> (u32, u32) {
        let batch = if self.total_ram_mb <= 8 * 1024 {
            256
        } else if self.total_ram_mb <= 16 * 1024 {
            512
        } else {
            1024
        };
        (batch, batch)
    }

    /// Max models the llama-server router may keep resident (`--models-max`).
    ///
    /// Cap is 3 so a few chat/embed/helper weights can co-reside without unbounded RAM.
    /// - ≤16 GB → 1 (anti-swap; chat↔embed may unload/reload)
    /// - ≤32 GB → 2
    /// - \>32 GB → 3
    pub fn models_max(&self) -> u32 {
        if self.total_ram_mb <= 16 * 1024 {
            1
        } else if self.total_ram_mb <= 32 * 1024 {
            2
        } else {
            3
        }
    }
}

static CORE_TOPOLOGY: OnceLock<(usize, usize)> = OnceLock::new();

fn probe_core_topology() -> (usize, usize) {
    let logical = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .max(1);

    let physical = probe_physical_cores().unwrap_or_else(|| {
        // SMT estimate when topology APIs are unavailable.
        (logical / 2).max(1)
    });

    // Physical can never exceed logical; clamp if a bogus probe appears.
    let physical = physical.min(logical).max(1);
    log::info!("Host topology: physical_cores={physical}, logical_cores={logical}");
    (physical, logical)
}

fn probe_ram_mb() -> (u64, u64) {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total = sys.total_memory() / (1024 * 1024);
    let available = sys.available_memory() / (1024 * 1024);
    (total, available)
}

fn probe_physical_cores() -> Option<usize> {
    #[cfg(target_os = "linux")]
    {
        return physical_cores_linux();
    }
    #[cfg(target_os = "macos")]
    {
        return physical_cores_macos();
    }
    #[cfg(windows)]
    {
        return physical_cores_windows();
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(target_os = "linux")]
fn physical_cores_linux() -> Option<usize> {
    use std::collections::HashSet;
    let cpu_root = std::path::Path::new("/sys/devices/system/cpu");
    let entries = std::fs::read_dir(cpu_root).ok()?;
    let mut cores = HashSet::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("cpu") || !name[3..].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let topo = entry.path().join("topology");
        let pkg = std::fs::read_to_string(topo.join("physical_package_id")).ok()?;
        let core = std::fs::read_to_string(topo.join("core_id")).ok()?;
        cores.insert((pkg.trim().to_string(), core.trim().to_string()));
    }
    if cores.is_empty() {
        None
    } else {
        Some(cores.len())
    }
}

#[cfg(target_os = "macos")]
fn physical_cores_macos() -> Option<usize> {
    let output = std::process::Command::new("sysctl")
        .args(["-n", "hw.physicalcpu"])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&output.stdout);
    s.trim().parse::<usize>().ok().filter(|&n| n > 0)
}

#[cfg(windows)]
fn physical_cores_windows() -> Option<usize> {
    // NumberOfCores is physical cores (not logical processors).
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
        ])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&output.stdout);
    s.trim().parse::<usize>().ok().filter(|&n| n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threads_scale_with_physical_cores_no_fixed_cap() {
        let small = HostProfile::synthetic(4, 8, 16 * 1024, 8 * 1024);
        assert_eq!(small.inference_threads(false, false), 3); // leave 1 for UI

        let mid = HostProfile::synthetic(12, 16, 16 * 1024, 8 * 1024);
        assert_eq!(mid.inference_threads(false, false), 11);

        let big = HostProfile::synthetic(32, 64, 64 * 1024, 48 * 1024);
        assert_eq!(big.inference_threads(false, false), 31);

        let tiny = HostProfile::synthetic(2, 4, 8 * 1024, 4 * 1024);
        assert_eq!(tiny.inference_threads(false, false), 2);
    }

    #[test]
    fn battery_halves_threads() {
        let host = HostProfile::synthetic(8, 16, 16 * 1024, 8 * 1024);
        assert_eq!(host.inference_threads(true, false), 4);
        assert_eq!(host.inference_threads(false, true), 4);
    }

    #[test]
    fn memory_budget_scales_and_unlocks_on_large_hosts() {
        let low = HostProfile::synthetic(4, 8, 8 * 1024, 4 * 1024);
        // headroom = max(1536, 25% of 8192=2048) = 2048 → budget 6144
        assert_eq!(low.memory_budget_mb(), 8 * 1024 - 2048);

        let mid = HostProfile::synthetic(8, 16, 16 * 1024, 8 * 1024);
        // 25% of 16384 = 4096 → budget 12288
        assert_eq!(mid.memory_budget_mb(), 16 * 1024 - 4096);

        let high = HostProfile::synthetic(16, 32, 32 * 1024, 24 * 1024);
        assert_eq!(high.memory_budget_mb(), 0);
    }

    #[test]
    fn batch_sizes_track_ram_tiers() {
        assert_eq!(
            HostProfile::synthetic(4, 4, 8 * 1024, 4 * 1024).default_batch_sizes(),
            (256, 256)
        );
        assert_eq!(
            HostProfile::synthetic(8, 16, 16 * 1024, 8 * 1024).default_batch_sizes(),
            (512, 512)
        );
        assert_eq!(
            HostProfile::synthetic(16, 32, 64 * 1024, 48 * 1024).default_batch_sizes(),
            (1024, 1024)
        );
    }

    #[test]
    fn mlock_disabled_on_tiny_hosts() {
        assert!(!HostProfile::synthetic(2, 4, 8 * 1024, 3 * 1024).prefer_mlock());
        assert!(HostProfile::synthetic(8, 16, 16 * 1024, 8 * 1024).prefer_mlock());
    }

    #[test]
    fn no_mmap_policy() {
        assert!(HostProfile::synthetic(4, 8, 16 * 1024, 10 * 1024).prefer_no_mmap());
        // 24GB total, 50% free → mmap ok
        assert!(!HostProfile::synthetic(8, 16, 24 * 1024, 12 * 1024).prefer_no_mmap());
        // 24GB total, 20% free → prefer no-mmap
        assert!(HostProfile::synthetic(8, 16, 24 * 1024, 4 * 1024).prefer_no_mmap());
    }

    #[test]
    fn models_max_by_ram_tier() {
        assert_eq!(
            HostProfile::synthetic(4, 8, 16 * 1024, 8 * 1024).models_max(),
            1
        );
        assert_eq!(
            HostProfile::synthetic(8, 16, 24 * 1024, 12 * 1024).models_max(),
            2
        );
        assert_eq!(
            HostProfile::synthetic(16, 32, 64 * 1024, 48 * 1024).models_max(),
            3
        );
    }
}
