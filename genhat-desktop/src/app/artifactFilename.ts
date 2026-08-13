/**
 * Short, human file stems for HTML / CSV / PPT artifacts.
 * Never persist the raw user prompt as the download name.
 */

const INSTRUCTION_PREFIX =
  /^(?:i want you to|i want|i'd like you to|i would like you to|please|can you|could you|would you)\s+/i;

const INSTRUCTION_VERBS =
  /\b(?:design|create|make|generate|build|write|plan|include|add|put|have|give|show|list|let me know|if you have any questions)\b/gi;

const STOPWORDS = new Set(
  (
    "a an the to for of in on at and or but if so as is be will from with into over about " +
    "which that this those these you your me my i we our them their it its too also just " +
    "all any some more than then when where how what who whom whose"
  ).split(" ")
);

const PROMPT_OPENERS =
  /^(i want|i need|please|can you|could you|would you|create|make|generate|design|plan|write|build|help me)\b/i;

export function slugifyArtifactFilename(text: string, fallback = "artifact"): string {
  const slug = (text || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return slug || fallback;
}

/** True when text is the user's request, not a document title. */
export function looksLikeUserPrompt(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return true;
  if (t.length > 56) return true;
  if (t.includes("?")) return true;
  if (PROMPT_OPENERS.test(t)) return true;
  if (t.split(/\s+/).length > 8) return true;
  return false;
}

/** Pull a short topic phrase from a long user request. */
export function synthesizeFilenameFromTopic(
  topic: string,
  fallback = "artifact"
): string {
  let t = (topic || "").trim();
  t = t.replace(INSTRUCTION_PREFIX, "");
  t = t.replace(INSTRUCTION_VERBS, " ");
  t = t.replace(/[?!.]+/g, " ");
  const words = t
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(
      (w) =>
        (w.length > 1 || /^\d+$/.test(w)) && !STOPWORDS.has(w.toLowerCase())
    );
  return slugifyArtifactFilename(words.slice(0, 7).join(" "), fallback);
}

export function deriveArtifactFilename(opts: {
  llmName?: string | null;
  htmlTitle?: string | null;
  topic?: string | null;
  fallback?: string;
}): string {
  const fallback = opts.fallback || "artifact";
  const candidates = [opts.llmName, opts.htmlTitle];
  for (const c of candidates) {
    const raw = (c || "").trim();
    if (!raw || looksLikeUserPrompt(raw)) continue;
    return slugifyArtifactFilename(raw, fallback);
  }
  const topic = (opts.topic || "").trim();
  if (topic && !looksLikeUserPrompt(topic)) {
    return slugifyArtifactFilename(topic, fallback);
  }
  if (topic) return synthesizeFilenameFromTopic(topic, fallback);
  return fallback;
}

/** First `filename="..."` on a nela-artifact tag, if the model set one. */
export function extractWorkbookFilename(raw: string): string | undefined {
  const m = /<nela-artifact\b[^>]*\bfilename\s*=\s*["']([^"']+)["']/i.exec(
    raw || ""
  );
  const name = m?.[1]?.trim();
  if (!name || looksLikeUserPrompt(name)) return undefined;
  return name;
}
