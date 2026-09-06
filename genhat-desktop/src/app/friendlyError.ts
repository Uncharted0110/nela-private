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

  // Already one of our classified / COPY lines — keep the full next-step text.
  const classifiedPassthrough = classifyArtifactFailure(text);
  if (classifiedPassthrough && isOurArtifactCopy(text)) {
    return classifiedPassthrough;
  }
  if (looksAlreadyFriendly(lower) && !looksTechnical(text)) {
    // Prefer full message when it already includes a next step.
    if (hasNextStep(lower) && text.length < 320) {
      return text;
    }
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
    lower.includes("nela_gmail_oauth_client_id") ||
    lower.includes("nela_google_connector_client_id") ||
    (lower.includes("gmail") && lower.includes(".env"))
  ) {
    return "Gmail isn't available in this copy of NELA. Update the app and try Connect again.";
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

  if (
    lower.includes("still starting your request") ||
    lower.includes("cold start or model fallback")
  ) {
    return COPY.errorCloudBusy;
  }

  if (lower.includes("stopped sending tokens")) {
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

  const artifactMsg = classifyArtifactFailure(text);
  if (artifactMsg) return artifactMsg;

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

/**
 * Map artifact/HTML/CSV failure strings to specific user-facing copy.
 * Returns null when the text is not an artifact failure (e.g. chat that
 * merely mentions the word "artifact").
 */
export function classifyArtifactFailure(
  raw: string | undefined | null
): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  if (isOurArtifactCopy(text)) {
    return text;
  }

  // Spreadsheet / CSV first (more specific than generic truncated).
  if (
    lower.includes("streamed csv") ||
    lower.includes("spreadsheet plan") ||
    lower.includes("excel sheet") ||
    (lower.includes("workbook") &&
      (lower.includes("empty") ||
        lower.includes("fail") ||
        lower.includes("truncat") ||
        lower.includes("invalid") ||
        lower.includes("parse"))) ||
    (lower.includes("csv") &&
      (lower.includes("empty") ||
        lower.includes("header") ||
        lower.includes("fail") ||
        lower.includes("truncat") ||
        lower.includes("invalid") ||
        lower.includes("no rows")))
  ) {
    return COPY.errorArtifactSpreadsheet;
  }

  // Preview ready but save/validation failed.
  if (
    lower.includes("preview is ready but saving failed") ||
    lower.includes("couldn't save the file") ||
    lower.includes("saving failed") ||
    (lower.includes("save") &&
      lower.includes("fail") &&
      (lower.includes("html") ||
        lower.includes("file") ||
        lower.includes("artifact") ||
        lower.includes("preview")))
  ) {
    return COPY.errorArtifactSave;
  }

  // Truncated / cut off mid-generation.
  if (
    lower.includes("truncated") ||
    lower.includes("cut off") ||
    lower.includes("styles without slide") ||
    lower.includes("couldn't finish the presentation") ||
    lower.includes("output limit") ||
    lower.includes("larger output") ||
    (lower.includes("generated html") && lower.includes("empty or truncated")) ||
    (lower.includes("presentation html") &&
      (lower.includes("truncated") || lower.includes("looks truncated")))
  ) {
    return COPY.errorArtifactTruncated;
  }

  // Empty / almost no usable content.
  if (
    lower.includes("almost no visible content") ||
    lower.includes("too little visible content") ||
    lower.includes("missing body content") ||
    lower.includes("does not look like a multi-slide") ||
    (lower.includes("generated html") &&
      (lower.includes("empty") || lower.includes("no visible"))) ||
    (lower.includes("presentation html") && lower.includes("too little"))
  ) {
    return COPY.errorArtifactEmpty;
  }

  // Explicit artifact pipeline failures (not mere mention of the word).
  if (
    lower.includes("generated html") ||
    lower.includes("presentation html") ||
    lower.includes("nela-artifact") ||
    lower.includes("streamed artifact") ||
    lower.includes("artifact save") ||
    lower.includes("couldn't finish that file") ||
    lower.includes("couldn't finish the file") ||
    lower.includes("model returned an empty") ||
    lower.includes("model did not return valid")
  ) {
    return COPY.errorArtifact;
  }

  return null;
}

/** Convenience for catch blocks. */
export function friendlyErrorFromUnknown(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return COPY.errorCancelled;
  }
  return friendlyError(err instanceof Error ? err.message : String(err));
}

/**
 * Banner text for an Error-stage artifact message.
 * Short classified errors show once; long optimistic prose gets a truncated banner
 * instead of remapping the whole essay via `includes("artifact")`.
 */
export function artifactErrorBannerText(content: string | undefined | null): string {
  const t = (content ?? "").trim();
  if (!t) return COPY.errorArtifact;
  if (t.length < 280 && !/\n\n/.test(t)) {
    return classifyArtifactFailure(t) ?? friendlyError(t);
  }
  // Long model prose left on an Error stage (legacy / edge) → honest truncated banner.
  return COPY.errorArtifactTruncated;
}

function isOurArtifactCopy(text: string): boolean {
  return (
    text === COPY.errorArtifact ||
    text === COPY.errorArtifactTruncated ||
    text === COPY.errorArtifactEmpty ||
    text === COPY.errorArtifactSave ||
    text === COPY.errorArtifactSpreadsheet
  );
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
    lower.startsWith("that file was cut off") ||
    lower.startsWith("i couldn't build usable") ||
    lower.startsWith("a preview is ready") ||
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

function hasNextStep(lower: string): boolean {
  return (
    lower.includes("try again") ||
    lower.includes("ask me") ||
    lower.includes("sign in") ||
    lower.includes("check ") ||
    lower.includes("upgrade") ||
    lower.includes("buy ") ||
    lower.includes("open ") ||
    lower.includes("wait ") ||
    lower.includes("choose ") ||
    lower.includes("close other") ||
    lower.includes("continue") ||
    lower.includes("review it")
  );
}

function ensureNextStep(message: string): string {
  const lower = message.toLowerCase();
  if (hasNextStep(lower)) {
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
