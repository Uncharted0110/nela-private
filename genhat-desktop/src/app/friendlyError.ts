import { COPY } from "./copy";

/**
 * Convert raw backend/error strings into calm, non-technical messages.
 * Keep the original text for Advanced mode / logs (caller decides).
 */
export function friendlyError(raw: string | undefined | null): string {
  const text = (raw ?? "").trim();
  if (!text) return COPY.errorGeneric;

  const lower = text.toLowerCase();

  // Already friendly (from Rust cloud client / COPY) — pass through.
  if (
    lower.startsWith("we couldn't") ||
    lower.startsWith("something went wrong") ||
    lower.startsWith("please sign in") ||
    lower.startsWith("you're not signed") ||
    lower.startsWith("your nela cloud session") ||
    lower.startsWith("that email or password") ||
    lower.startsWith("an account with that email") ||
    lower.startsWith("that sign-in") ||
    lower.startsWith("that took too long") ||
    lower.startsWith("too many requests") ||
    lower.startsWith("nela cloud is having") ||
    lower.startsWith("nela is still") ||
    lower.startsWith("your computer ran low") ||
    lower.startsWith("your plan doesn't") ||
    lower.startsWith("check your internet") ||
    lower.includes("please try again")
  ) {
    // Strip technical suffixes if a friendly sentence was prefixed.
    const firstSentence = text.split(/(?<=\.)\s+/)[0] ?? text;
    if (!looksTechnical(firstSentence)) return firstSentence;
  }

  if (
    lower.includes("error sending request") ||
    lower.includes("connection refused") ||
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("dns") ||
    lower.includes("unreachable") ||
    lower.includes("device auth") ||
    lower.includes("localhost") ||
    lower.includes("tcp connect") ||
    (lower.includes("timed out") && lower.includes("url"))
  ) {
    return COPY.errorCloudUnreachable;
  }

  if (
    lower.includes("not be loaded") ||
    lower.includes("model may not") ||
    lower.includes("no model") ||
    lower.includes("failed to start") ||
    lower.includes("not running") ||
    lower.includes("loading")
  ) {
    return COPY.errorNotReady;
  }

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return COPY.errorTimeout;
  }

  if (lower.includes("out of memory") || lower.includes("oom") || /\bmemory\b/.test(lower)) {
    return COPY.errorMemory;
  }

  if (
    lower.includes("invalid credentials") ||
    lower.includes("wrong password") ||
    lower.includes("unauthorized") ||
    lower.includes("401")
  ) {
    return COPY.errorAuthCredentials;
  }

  if (lower.includes("session expired") || lower.includes("refresh_token") || lower.includes("sign in again")) {
    return COPY.errorSessionExpired;
  }

  if (
    lower.includes("generated html") ||
    lower.includes("presentation html") ||
    lower.includes("missing body") ||
    lower.includes("multi-slide deck") ||
    lower.includes("too little visible content") ||
    lower.includes("styles without slide") ||
    lower.includes("couldn't finish the presentation")
  ) {
    // Keep a short, accurate message — not a billing/plan false positive.
    const cleaned = text
      .replace(/^couldn't finish the presentation:\s*/i, "")
      .replace(/^failed to compile\/execute artifact plan:\s*/i, "")
      .trim();
    return cleaned || "The presentation HTML came back incomplete. Please try again.";
  }

  if (
    lower.includes("quota") ||
    lower.includes("entitlement") ||
    /\b(subscription|billing)\s+plan\b/.test(lower) ||
    /\byour plan\b/.test(lower) ||
    /\bplan (limit|does not|doesn't|upgrade)\b/.test(lower)
  ) {
    return COPY.errorPlan;
  }

  if (lower.includes("failed to open") && lower.includes("browser")) {
    return COPY.errorOpenBrowser;
  }

  if (lower.includes("not signed in")) {
    return COPY.errorNotSignedIn;
  }

  return COPY.errorGeneric;
}

function looksTechnical(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("http://") ||
    lower.includes("https://") ||
    lower.includes("localhost") ||
    lower.includes("status") ||
    lower.includes("error sending") ||
    /\{.*\}/.test(text) ||
    /\b[A-Z_]{4,}\b/.test(text) // ERROR_CODE style
  );
}
