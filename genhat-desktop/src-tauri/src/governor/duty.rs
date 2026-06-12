//! Duty-cycle governor for background tasks.
//!
//! Enforces a work/sleep pulse so background workers never sustain 100% on a
//! single core. Callers call `checkpoint()` at regular intervals inside their
//! processing loop.
//!
//! ## Duty cycles
//!
//! | Power state | Work window | Sleep window |
//! |-------------|-------------|--------------|
//! | AC power    | 200 ms      | 50 ms        |
//! | Battery     | 100 ms      | 100 ms        |

use std::time::{Duration, Instant};

/// A duty-cycle guard for background processing loops.
pub struct DutyCycleGuard {
    work: Duration,
    sleep: Duration,
    last: Instant,
}

impl DutyCycleGuard {
    /// AC-power duty cycle: 200 ms work / 50 ms sleep.
    /// Bounds a background core to ~80% of one core.
    pub fn ac_power() -> Self {
        Self {
            work: Duration::from_millis(200),
            sleep: Duration::from_millis(50),
            last: Instant::now(),
        }
    }

    /// Battery duty cycle: 100 ms work / 100 ms sleep.
    /// Reduces power consumption by halving the duty cycle.
    pub fn battery() -> Self {
        Self {
            work: Duration::from_millis(100),
            sleep: Duration::from_millis(100),
            last: Instant::now(),
        }
    }

    /// Async checkpoint for use inside `async` processing loops.
    ///
    /// Sleeps for the configured `sleep` duration once `work` time has elapsed.
    pub async fn checkpoint(&mut self) {
        if self.last.elapsed() >= self.work {
            tokio::time::sleep(self.sleep).await;
            self.last = Instant::now();
        }
    }

    /// Synchronous checkpoint for use in `std::thread`-based loops.
    pub fn checkpoint_sync(&mut self) {
        if self.last.elapsed() >= self.work {
            std::thread::sleep(self.sleep);
            self.last = Instant::now();
        }
    }
}
