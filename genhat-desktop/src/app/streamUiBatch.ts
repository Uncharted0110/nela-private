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
