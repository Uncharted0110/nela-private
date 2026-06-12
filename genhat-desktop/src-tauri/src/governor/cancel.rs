//! Per-request cancellation token backed by Arc<AtomicBool>.
//!
//! Clone to share across threads; call `cancel()` from any context.
//! The inference loop polls `is_cancelled()` at token boundaries.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Lightweight, cheaply-cloneable cancellation token.
///
/// Designed to be placed in `TaskRequest::cancel_token` and shared with any
/// polling loop that should stop when the user issues a new request.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    inner: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Signal cancellation. Idempotent; safe to call from any thread.
    pub fn cancel(&self) {
        self.inner.store(true, Ordering::Release);
    }

    /// Returns `true` if cancellation has been signalled.
    pub fn is_cancelled(&self) -> bool {
        self.inner.load(Ordering::Acquire)
    }

    /// Reset the token for reuse before a new request.
    pub fn reset(&self) {
        self.inner.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_roundtrip() {
        let tok = CancellationToken::new();
        assert!(!tok.is_cancelled());
        tok.cancel();
        assert!(tok.is_cancelled());
        tok.reset();
        assert!(!tok.is_cancelled());
    }

    #[test]
    fn clone_shares_state() {
        let tok = CancellationToken::new();
        let clone = tok.clone();
        tok.cancel();
        assert!(clone.is_cancelled());
    }
}
