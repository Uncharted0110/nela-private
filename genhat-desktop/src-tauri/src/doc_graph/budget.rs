//! Host-aware CPU budget for doc-graph indexing.
//!
//! Sized from [`HostProfile`] (physical cores) and [`Governor`] battery/thermal
//! state so Pass 1 never saturates the machine. Never uses Rayon's global pool.

use crate::governor::{probe_on_battery, HostProfile};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Hard ceiling — a 16-core box still stays interactive.
pub const MAX_INDEXER_THREADS: usize = 4;
/// Env override for debugging (`NELA_DOC_GRAPH_THREADS=N`, clamped 1..=4).
pub const ENV_THREADS: &str = "NELA_DOC_GRAPH_THREADS";

/// Last budget used by Pass 1/2 (for bench / UI diagnostics).
static LAST_PASS1_THREADS: AtomicUsize = AtomicUsize::new(0);
static LAST_PHYSICAL: AtomicUsize = AtomicUsize::new(0);

/// CPU budget for doc-graph parse workers and FastEmbed/ORT intra-op threads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexerBudget {
    pub physical_cores: usize,
    pub logical_cores: usize,
    pub on_battery: bool,
    pub thermal: bool,
    /// Private Rayon pool size for Pass 1.
    pub pass1_threads: usize,
    /// Pass 2 is at most 2, and never above Pass 1.
    pub pass2_threads: usize,
    /// FastEmbed / ORT `intra_threads`.
    pub embed_threads: usize,
}

impl IndexerBudget {
    /// Probe the live host + battery. Thermal defaults to false (no global flag).
    pub fn detect() -> Self {
        Self::from_host(&HostProfile::detect(), probe_on_battery(), false)
    }

    /// Derive a budget from an already-probed [`HostProfile`].
    pub fn from_host(host: &HostProfile, on_battery: bool, thermal: bool) -> Self {
        Self::from_parts(
            host.physical_cores,
            host.logical_cores,
            on_battery,
            thermal,
            env_thread_override(),
        )
    }

    /// Pure function used by unit tests (`HostProfile::synthetic` + flags).
    pub fn from_parts(
        physical_cores: usize,
        logical_cores: usize,
        on_battery: bool,
        thermal: bool,
        env_override: Option<usize>,
    ) -> Self {
        let physical_cores = physical_cores.max(1);
        let logical_cores = logical_cores.max(1);

        let pass1_threads = if let Some(n) = env_override {
            n.clamp(1, MAX_INDEXER_THREADS)
        } else if on_battery || thermal {
            1
        } else {
            let tier = match physical_cores {
                1..=4 => 1,
                5..=11 => 2,
                n => (n / 4).min(MAX_INDEXER_THREADS),
            };
            let leave_free = if physical_cores > 2 { 2 } else { 0 };
            let by_leave = physical_cores.saturating_sub(leave_free).max(1);
            tier.min(by_leave).min(MAX_INDEXER_THREADS).max(1)
        };

        let embed_threads = if on_battery || thermal || physical_cores <= 4 {
            1
        } else {
            2.min(pass1_threads)
        };

        let budget = Self {
            physical_cores,
            logical_cores,
            on_battery,
            thermal,
            pass1_threads,
            pass2_threads: pass1_threads.min(2),
            embed_threads,
        };
        LAST_PASS1_THREADS.store(budget.pass1_threads, Ordering::Relaxed);
        LAST_PHYSICAL.store(budget.physical_cores, Ordering::Relaxed);
        budget
    }

    pub fn last_pass1_threads() -> usize {
        LAST_PASS1_THREADS.load(Ordering::Relaxed)
    }

    pub fn last_physical_cores() -> usize {
        LAST_PHYSICAL.load(Ordering::Relaxed)
    }

    pub fn progress_label(&self) -> String {
        format!(
            "workers={} / physical={}{}",
            self.pass1_threads,
            self.physical_cores,
            if self.on_battery {
                " battery"
            } else if self.thermal {
                " thermal"
            } else {
                ""
            }
        )
    }
}

fn env_thread_override() -> Option<usize> {
    let raw = std::env::var(ENV_THREADS).ok()?;
    let n: usize = raw.trim().parse().ok()?;
    Some(n)
}

/// Drop this thread's OS scheduling priority so the UI / compositor wins.
pub fn lower_current_thread_priority() {
    #[cfg(unix)]
    unsafe {
        libc::nice(10);
    }
    #[cfg(windows)]
    unsafe {
        const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentThread() -> *mut core::ffi::c_void;
    fn SetThreadPriority(thread: *mut core::ffi::c_void, n_priority: i32) -> i32;
}

/// Private Pass 1 pool — never `build_global()`.
pub fn build_pass1_pool(
    budget: &IndexerBudget,
) -> Result<rayon::ThreadPool, rayon::ThreadPoolBuildError> {
    rayon::ThreadPoolBuilder::new()
        .num_threads(budget.pass1_threads.max(1))
        .thread_name(|i| format!("doc-graph-p1-{i}"))
        .start_handler(|_| lower_current_thread_priority())
        .build()
}

/// Private Pass 2 pool — never `build_global()`.
pub fn build_pass2_pool(
    budget: &IndexerBudget,
) -> Result<rayon::ThreadPool, rayon::ThreadPoolBuildError> {
    rayon::ThreadPoolBuilder::new()
        .num_threads(budget.pass2_threads.max(1))
        .thread_name(|i| format!("doc-graph-p2-{i}"))
        .start_handler(|_| lower_current_thread_priority())
        .build()
}

/// Map `items` on the pool **without** recruiting the caller as an extra worker.
///
/// `ThreadPool::install` would add the calling thread and exceed the budget
/// (2 pool threads + caller = 3). `in_place_scope` keeps concurrency at
/// `num_threads`.
pub fn in_place_map<T, R, F>(pool: &rayon::ThreadPool, items: &[T], f: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync,
{
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    let n = items.len();
    let f = &f;
    pool.in_place_scope(|scope| {
        for item in items {
            let tx = tx.clone();
            scope.spawn(move |_| {
                let _ = tx.send(f(item));
            });
        }
    });
    drop(tx);
    rx.iter().take(n).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::governor::HostProfile;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    fn budget(physical: usize, battery: bool, thermal: bool) -> IndexerBudget {
        let host = HostProfile::synthetic(physical, physical * 2, 16_000, 8_000);
        IndexerBudget::from_parts(
            host.physical_cores,
            host.logical_cores,
            battery,
            thermal,
            None,
        )
    }

    #[test]
    fn dual_core_stays_at_one() {
        let b = budget(2, false, false);
        assert_eq!(b.pass1_threads, 1);
        assert_eq!(b.pass2_threads, 1);
        assert_eq!(b.embed_threads, 1);
    }

    #[test]
    fn quad_core_stays_at_one() {
        let b = budget(4, false, false);
        assert_eq!(b.pass1_threads, 1);
        assert_eq!(b.embed_threads, 1);
        assert!(b.physical_cores - b.pass1_threads >= 2);
    }

    #[test]
    fn eight_core_uses_two() {
        let b = budget(8, false, false);
        assert_eq!(b.pass1_threads, 2);
        assert_eq!(b.pass2_threads, 2);
        assert_eq!(b.embed_threads, 2);
        assert!(b.physical_cores - b.pass1_threads >= 2);
    }

    #[test]
    fn sixteen_core_hard_caps_at_four() {
        let b = budget(16, false, false);
        assert_eq!(b.pass1_threads, 4);
        assert_eq!(b.embed_threads, 2);
        assert!(b.physical_cores - b.pass1_threads >= 2);
    }

    #[test]
    fn twelve_core_uses_quarter() {
        let b = budget(12, false, false);
        assert_eq!(b.pass1_threads, 3);
    }

    #[test]
    fn battery_and_thermal_force_one() {
        assert_eq!(budget(8, true, false).pass1_threads, 1);
        assert_eq!(budget(16, false, true).pass1_threads, 1);
        assert_eq!(budget(8, true, false).embed_threads, 1);
        assert_eq!(budget(16, false, true).embed_threads, 1);
    }

    #[test]
    fn env_override_clamped_to_hard_cap() {
        let host = HostProfile::synthetic(16, 32, 32_000, 16_000);
        let b = IndexerBudget::from_parts(
            host.physical_cores,
            host.logical_cores,
            false,
            false,
            Some(99),
        );
        assert_eq!(b.pass1_threads, MAX_INDEXER_THREADS);
        let b1 = IndexerBudget::from_parts(
            host.physical_cores,
            host.logical_cores,
            true,
            false,
            Some(1),
        );
        assert_eq!(b1.pass1_threads, 1);
    }

    #[test]
    fn private_pool_caps_inflight_and_joins() {
        let b = budget(8, false, false);
        assert_eq!(b.pass1_threads, 2);
        let pool = build_pass1_pool(&b).expect("pass1 pool");
        let peak = Arc::new(AtomicUsize::new(0));
        let live = Arc::new(AtomicUsize::new(0));
        let items: Vec<u8> = (0..8).collect();
        in_place_map(&pool, &items, |_| {
            let n = live.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(n, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(80));
            live.fetch_sub(1, Ordering::SeqCst);
        });
        assert!(
            peak.load(Ordering::SeqCst) <= b.pass1_threads,
            "peak {} exceeded budget {}",
            peak.load(Ordering::SeqCst),
            b.pass1_threads
        );
        assert_eq!(live.load(Ordering::SeqCst), 0, "workers must be joined");
    }
}
