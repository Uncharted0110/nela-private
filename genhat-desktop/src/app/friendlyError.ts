import { COPY } from "./copy";

/**
 * Convert raw backend/error strings into calm, non-technical messages
 * with a clear next step. Keep the original text for Advanced mode / logs
 * (caller decides).
 */
export function friendlyError(raw: string | undefined | null): string {
  const text = (raw ?? "").trim();
  if (!text) return COPY.errorGeneric;

  const lower = text.toLowerCase();

  // Already friendly (from Rust cloud client / COPY) — pass through first sentence.
  if (looksAlreadyFriendly(lower) && !looksTechnical(text)) {
    const firstSentence = text.split(/(?<=\.)\s+/)[0] ?? text;
    if (!looksTechnical(firstSentence)) return ensureNextStep(firstSentence);
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
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    (lower.includes("timed out") && lower.includes("url"))
  ) {
    return COPY.errorCloudUnreachable;
  }

  if (
    lower.includes("fast_quota") ||
    lower.includes("fast free") ||
    lower.includes("fast limit") ||
    (lower.includes("fast") && lower.includes("limit reached"))
  ) {
    return COPY.errorFastQuota;
  }

  if (
    lower.includes("quota_exhausted") ||
    lower.includes("credit balance exhausted") ||
    (lower.includes("credits") && lower.includes("exhaust")) ||
    (lower.includes("balance") && lower.includes("empty"))
  ) {
    return COPY.errorCreditsEmpty;
  }

  if (
    lower.includes("upgrade_required") ||
    lower.includes("upgrade to premium") ||
    lower.includes("buy a credit pack") ||
    lower.includes("smart and deep")
  ) {
    return COPY.errorUpgradeRequired;
  }

  if (
    lower.includes("cloud_busy") ||
    lower.includes("cloud is busy") ||
    lower.includes("openrouter_failed") ||
    lower.includes("openrouter_not_configured") ||
    lower.includes("no openrouter") ||
    lower.includes("provider key")
  ) {
    return COPY.errorCloudBusy;
  }

  if (
    lower.includes("rate_limited") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  ) {
    return COPY.errorRateLimited;
  }

  if (
    lower.includes("not be loaded") ||
    lower.includes("model may not") ||
    lower.includes("no model") ||
    lower.includes("failed to start") ||
    lower.includes("not running") ||
    lower.includes("llama") ||
    (lower.includes("loading") && lower.includes("model"))
  ) {
    return COPY.errorNotReady;
  }

  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    return COPY.errorTimeout;
  }

  if (lower.includes("out of memory") || lower.includes("oom") || /\bmemory\b/.test(lower)) {
    return COPY.errorMemory;
  }

  if (
    lower.includes("invalid_credentials") ||
    lower.includes("invalid credentials") ||
    lower.includes("wrong password") ||
    lower.includes("unauthorized") ||
    lower.includes("401")
  ) {
    return COPY.errorAuthCredentials;
  }

  if (
    lower.includes("email_already") ||
    lower.includes("already exists") ||
    lower.includes("already registered")
  ) {
    return COPY.errorEmailExists;
  }

  if (
    lower.includes("email_not_verified") ||
    lower.includes("verify your email") ||
    lower.includes("verification link")
  ) {
    return "Verify your email before signing in. Check your inbox for the link, then try again.";
  }

  if (
    lower.includes("session expired") ||
    lower.includes("refresh_token") ||
    lower.includes("refresh token") ||
    lower.includes("sign in again")
  ) {
    return COPY.errorSessionExpired;
  }

  if (
    lower.includes("device_code") ||
    lower.includes("device code") ||
    lower.includes("link device") ||
    lower.includes("pairing")
  ) {
    return COPY.errorDeviceLink;
  }

  if (
    lower.includes("razorpay") ||
    lower.includes("checkout") ||
    lower.includes("billing") ||
    lower.includes("payment")
  ) {
    return COPY.errorBilling;
  }

  if (
    lower.includes("generated html") ||
    lower.includes("presentation html") ||
    lower.includes("missing body") ||
    lower.includes("multi-slide deck") ||
    lower.includes("too little visible content") ||
    lower.includes("styles without slide") ||
    lower.includes("couldn't finish the presentation") ||
    lower.includes("artifact") ||
    lower.includes("spreadsheet") ||
    lower.includes("workbook") ||
    lower.includes("csv")
  ) {
    return COPY.errorArtifact;
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

  if (lower.includes("not signed in") || lower.includes("please sign in")) {
    return COPY.errorNotSignedIn;
  }

  if (
    lower.includes("web search") ||
    lower.includes("search failed") ||
    lower.includes("duckduckgo")
  ) {
    return COPY.errorWebSearch;
  }

  if (
    lower.includes("failed to load") ||
    lower.includes("failed to render") ||
    lower.includes("failed to parse") ||
    lower.includes("failed to read")
  ) {
    return COPY.errorFileLoad;
  }

  if (looksTechnical(text) || /\b[A-Z_]{4,}\b/.test(text) || lower.includes("api ")) {
    return COPY.errorGeneric;
  }

  // Short plain text that isn't scary — keep it, ensure a next step.
  if (text.length < 160 && !looksTechnical(text)) {
    return ensureNextStep(text);
  }

  return COPY.errorGeneric;
}

/** Convenience for catch blocks. */
export function friendlyErrorFromUnknown(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return COPY.errorCancelled;
  }
  return friendlyError(err instanceof Error ? err.message : String(err));
}

function looksAlreadyFriendly(lower: string): boolean {
  return (
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
    lower.startsWith("nela cloud is busy") ||
    lower.startsWith("nela is still") ||
    lower.startsWith("your computer ran low") ||
    lower.startsWith("your plan doesn't") ||
    lower.startsWith("check your internet") ||
    lower.startsWith("cloud is busy") ||
    lower.startsWith("credit balance") ||
    lower.startsWith("buy a credit") ||
    lower.startsWith("upgrade to") ||
    lower.includes("please try again") ||
    lower.includes("open cloud settings") ||
    lower.includes("sign in again")
  );
}

function ensureNextStep(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("try again") ||
    lower.includes("sign in") ||
    lower.includes("check ") ||
    lower.includes("upgrade") ||
    lower.includes("buy ") ||
    lower.includes("open ") ||
    lower.includes("wait ") ||
    lower.includes("choose ") ||
    lower.includes("close other")
  ) {
    return message;
  }
  return `${message.replace(/\.*\s*$/, "")}. Please try again.`;
}

function looksTechnical(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("http://") ||
    lower.includes("https://") ||
    lower.includes("localhost") ||
    lower.includes("status") ||
    lower.includes("error sending") ||
    lower.includes("stack") ||
    lower.includes("at object.") ||
    lower.includes("prisma") ||
    lower.includes("sql") ||
    /\{.*\}/.test(text) ||
    /\b[A-Z_]{4,}\b/.test(text) ||
    /\berror:\s/i.test(text) ||
    /\b(errno|econn|enotfound)\b/i.test(text)
  );
}
