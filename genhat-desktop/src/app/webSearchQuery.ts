/**
 * Build a clean web search query from user input (strips slash commands, etc.).
 */

import { ARTIFACT_WEB_MAX_RESULTS } from "./send/webSearchLimits";

const SLASH_PREFIX = /^\/[a-zA-Z][a-zA-Z0-9_-]*\s*/;
const LEAD_IN =
  /^(?:can you|could you|would you|please|hey|hi|hello)[,!]?\s+/i;
const GENERATE_LEAD =
  /^(?:generate|create|make|build|write|design|draft)\s+(?:a|an|the|me\s+a|me\s+an)?\s*/i;
const TRAILING_CHATTER =
  /\s*(?:let me know if you want(?:\s+any)?\s+more details|any more details|thanks|thank you)[.!]?\s*$/i;

/** Remove leading slash commands like `/web /excel` from the search query. */
export function extractWebSearchQuery(text: string): string {
  let q = text.trim();
  while (SLASH_PREFIX.test(q)) {
    q = q.replace(SLASH_PREFIX, "").trim();
  }
  q = q.replace(LEAD_IN, "").replace(GENERATE_LEAD, "").replace(TRAILING_CHATTER, "").trim();
  // Prefer the subject after "about …" when present (common artifact phrasing).
  const about = q.match(/\babout\s+(.+?)(?:\s*[?.!]|$)/i);
  if (about?.[1]?.trim()) {
    q = about[1].trim();
  }
  // Drop leftover "webpage" / "presentation" framing words.
  q = q
    .replace(/\b(?:a|an|the)\s+(?:webpage|web page|website|page|presentation|deck|spreadsheet)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return q.slice(0, 120);
}

/**
 * Web query for a single presentation / PPT slide about a topic.
 * Reuses extractWebSearchQuery cleanup, then adds fact-oriented framing
 * (same spirit as presentation_synthesis grounding).
 */
export function slideTopicWebQuery(topic: string): string {
  const cleaned =
    extractWebSearchQuery(`about ${topic}`.trim()).trim() || topic.trim();
  // Keep it a short keyword query; research profile fetches full pages.
  return `${cleaned} key facts history`.slice(0, 120);
}

/** Prefer full-page fetch when web is combined with artifact generation. */
export function webSearchOptionsForArtifact(
  schemaId: string,
  contextWindowTokens = 4096
): {
  fetchContent: boolean;
  maxResults: number;
} {
  const smallCtx = contextWindowTokens <= 4096;
  const maxResults = smallCtx ? 3 : ARTIFACT_WEB_MAX_RESULTS;

  if (
    schemaId === "spreadsheet_synthesis" ||
    schemaId === "presentation_synthesis" ||
    schemaId === "html_synthesis"
  ) {
    return { fetchContent: true, maxResults };
  }
  return { fetchContent: true, maxResults };
}

/** Max chars to keep from web formatted context for artifact plans. */
export function webContextCharLimit(contextWindowTokens: number): number {
  if (contextWindowTokens <= 4096) return 4500;
  if (contextWindowTokens <= 8192) return 10000;
  // Cloud / large-context models can absorb multi-facet research.
  return 28000;
}

/** Strict grounding for spreadsheets / numeric artifacts. */
export function webArtifactGroundingPreamble(): string {
  return (
    "VERIFIED WEB SOURCES (source of truth for this artifact):\n" +
    "- Use ONLY facts explicitly stated in the excerpts below.\n" +
    "- Do NOT invent, estimate, or guess numbers, names, dates, or rankings.\n" +
    "- If sources conflict or omit data, leave cells blank or note \"unverified\" — do not fabricate.\n" +
    "- For tables/lists: copy values exactly as written in the source text.\n\n"
  );
}

/** Presentation grounding: user topic wins; web is supporting research only. */
export function webPresentationGroundingPreamble(): string {
  return (
    "WEB RESEARCH (supporting context only — not the assignment):\n" +
    "- The USER REQUEST is the subject of the deck. Do not switch topics.\n" +
    "- Use these excerpts for accurate dates, names, places, and figures when they match that subject.\n" +
    "- IGNORE classroom worksheets, craft/card projects, Teachers Pay Teachers listings, " +
    "shopping pages, lesson-plan products, or anything that is not about the user's requested subject.\n" +
    "- If web results are off-topic, discard them and rely on accurate general knowledge of the subject.\n\n"
  );
}

/** Local Doc Graph / attached-file grounding for artifacts. */
export function localArtifactGroundingPreamble(): string {
  return (
    "LOCAL FILE SOURCES (source of truth for this artifact):\n" +
    "- Use ONLY facts explicitly stated in the excerpts / document text below.\n" +
    "- Do NOT invent, estimate, or guess numbers, names, dates, or claims absent from these sources.\n" +
    "- If sources omit a detail the user asked for, note that it was not found in the files — do not fabricate.\n\n"
  );
}
