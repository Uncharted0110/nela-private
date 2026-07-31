/**
 * Build a clean web search query from user input (strips slash commands, etc.).
 */

const SLASH_PREFIX = /^\/[a-zA-Z][a-zA-Z0-9_-]*\s*/;

/** Remove leading slash commands like `/web /excel` from the search query. */
export function extractWebSearchQuery(text: string): string {
  let q = text.trim();
  while (SLASH_PREFIX.test(q)) {
    q = q.replace(SLASH_PREFIX, "").trim();
  }
  return q.slice(0, 150);
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

  if (schemaId === "spreadsheet_synthesis") {
    return { fetchContent: true, maxResults: smallCtx ? 2 : 3 };
  }
  if (schemaId === "presentation_synthesis") {
    return { fetchContent: true, maxResults: smallCtx ? 2 : 3 };
  }
  return { fetchContent: true, maxResults: smallCtx ? 2 : 3 };
}

/** Max chars to keep from web formatted context for artifact plans. */
export function webContextCharLimit(contextWindowTokens: number): number {
  if (contextWindowTokens <= 4096) return 3500;
  if (contextWindowTokens <= 8192) return 7000;
  return 12000;
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
