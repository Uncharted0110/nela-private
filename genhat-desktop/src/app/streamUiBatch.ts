/**
 * Batch rapid stream chunks into one paint per animation frame.
 * Prevents Zustand/React from drowning in per-token updates while still
 * flushing promptly when the stream finishes.
 */
export function createStreamChunkFlusher(flush: (batched: string) => void): {
  push: (chunk: string) => void;
  flushNow: () => void;
} {
  let pending = "";
  let raf = 0;

  const flushNow = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (!pending) return;
    const out = pending;
    pending = "";
    flush(out);
  };

  const push = (chunk: string) => {
    if (!chunk) return;
    pending += chunk;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!pending) return;
      const out = pending;
      pending = "";
      flush(out);
    });
  };

  return { push, flushNow };
}

/**
 * Coalesce rapid "latest value" updates (e.g. full thinking text) to one
 * paint per animation frame. Unlike chunk flushers, each push replaces
 * the pending value instead of appending.
 */
export function createLatestValueFlusher<T>(flush: (value: T) => void): {
  push: (value: T) => void;
  flushNow: () => void;
} {
  let pending: T | undefined;
  let hasPending = false;
  let raf = 0;

  const flushNow = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (!hasPending) return;
    const out = pending as T;
    hasPending = false;
    pending = undefined;
    flush(out);
  };

  const push = (value: T) => {
    pending = value;
    hasPending = true;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!hasPending) return;
      const out = pending as T;
      hasPending = false;
      pending = undefined;
      flush(out);
    });
  };

  return { push, flushNow };
}
