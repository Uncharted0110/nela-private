/**
 * Low-end / performance UI prefs.
 * Persisted in localStorage; applied as `data-nela-perf="low"` on <html>.
 */

const STORAGE_KEY = "nela.performanceMode";

export type PerformanceMode = "auto" | "low" | "full";

function readStored(): PerformanceMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "low" || v === "full" || v === "auto") return v;
  } catch {
    /* ignore */
  }
  return "auto";
}

/** Heuristic: weak CPU/RAM or OS reduced-motion → prefer low. */
export function detectLowEndDevice(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return true;
    }
  } catch {
    /* ignore */
  }
  const nav = navigator as Navigator & { deviceMemory?: number; hardwareConcurrency?: number };
  const cores = nav.hardwareConcurrency ?? 8;
  const mem = nav.deviceMemory; // Chrome only; GiB
  if (cores > 0 && cores <= 4) return true;
  if (typeof mem === "number" && mem > 0 && mem <= 4) return true;
  return false;
}

export function resolvePerformanceLow(mode: PerformanceMode = readStored()): boolean {
  if (mode === "low") return true;
  if (mode === "full") return false;
  return detectLowEndDevice();
}

export function applyPerformanceDom(mode?: PerformanceMode): boolean {
  const low = resolvePerformanceLow(mode ?? readStored());
  if (typeof document !== "undefined") {
    document.documentElement.dataset.nelaPerf = low ? "low" : "full";
  }
  return low;
}

export function getStoredPerformanceMode(): PerformanceMode {
  return readStored();
}

export function setStoredPerformanceMode(mode: PerformanceMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  applyPerformanceDom(mode);
}
