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
 * Coalesce UI work to at most once per `intervalMs` (plus one trailing flush).
 * Use for expensive live previews (multi-sheet CSV parse/render) that would
 * freeze the page if run every animation frame.
 */
export function createThrottledFlusher(
  flush: () => void,
  intervalMs: number
): {
  push: () => void;
  flushNow: () => void;
} {
  let pending = false;
  let timer = 0;
  let last = 0;

  const run = () => {
    timer = 0;
    pending = false;
    last = Date.now();
    flush();
  };

  const flushNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    if (!pending) return;
    run();
  };

  const push = () => {
    pending = true;
    if (timer) return;
    const wait = Math.max(0, intervalMs - (Date.now() - last));
    timer = window.setTimeout(run, wait) as unknown as number;
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
