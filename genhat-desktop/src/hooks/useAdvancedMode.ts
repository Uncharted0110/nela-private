import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "nela:ux:advancedMode:v1";
const EVENT_NAME = "nela:advanced-mode-changed";

/** Read the current advanced-mode flag from localStorage (default: false = simple mode). */
export function getAdvancedMode(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Set the advanced-mode flag and broadcast the change to all hook instances. */
export function setAdvancedMode(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
  } catch {
    /* ignore storage errors (private mode, etc.) */
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: value }));
}

/**
 * React hook for advanced mode.
 * `advanced` is the current value; `setAdvanced` updates it everywhere.
 * Defaults to FALSE — non-technical "simple" mode is the default experience.
 */
export function useAdvancedMode(): { advanced: boolean; setAdvanced: (v: boolean) => void } {
  const [advanced, setAdvancedState] = useState<boolean>(() => getAdvancedMode());

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      setAdvancedState(Boolean(detail));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setAdvancedState(e.newValue === "true");
    };
    window.addEventListener(EVENT_NAME, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setAdvanced = useCallback((v: boolean) => setAdvancedMode(v), []);
  return { advanced, setAdvanced };
}
