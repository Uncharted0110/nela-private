import { COPY } from "./copy";

/**
 * Convert raw backend/error strings into calm, non-technical messages.
 * Keep the original text for Advanced mode / logs (caller decides).
 */
export function friendlyError(raw: string | undefined | null): string {
  const text = (raw ?? "").toLowerCase();
  if (!text) return COPY.errorGeneric;

  if (
    text.includes("not be loaded") ||
    text.includes("model may not") ||
    text.includes("no model") ||
    text.includes("failed to start") ||
    text.includes("not running") ||
    text.includes("loading")
  ) {
    return COPY.errorNotReady;
  }
  if (text.includes("timeout") || text.includes("timed out")) {
    return "That took too long. Please try again.";
  }
  if (text.includes("out of memory") || text.includes("oom") || text.includes("memory")) {
    return "Your computer ran low on memory. Try a smaller model or close other apps.";
  }
  return COPY.errorGeneric;
}
