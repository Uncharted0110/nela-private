/**
 * Parse artifact plan JSON from model output.
 * HTML section plans often include long strings with raw newlines — we repair
 * those before parsing and salvage partial plans when the stream truncates.
 */

/** Walk string literals and escape raw control characters for JSON.parse. */
export function escapeControlCharsInJsonStrings(json: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const c = json[i];

    if (escaped) {
      result += c;
      escaped = false;
      continue;
    }

    if (inString && c === "\\") {
      result += c;
      escaped = true;
      continue;
    }

    if (c === '"') {
      inString = !inString;
      result += c;
      continue;
    }

    if (inString) {
      const code = c.charCodeAt(0);
      if (c === "\n") {
        result += "\\n";
        continue;
      }
      if (c === "\r") {
        result += "\\r";
        continue;
      }
      if (c === "\t") {
        result += "\\t";
        continue;
      }
      if (code < 0x20) {
        continue;
      }
    }

    result += c;
  }

  return result;
}

/** Remove thinking tags, fences, and prose before the JSON object. */
export function stripArtifactModelOutput(raw: string): string {
  let text = raw.trim();
  text = text.replace(/```json\s*/gi, "");
  text = text.replace(/```\s*/g, "");
  text = text.replace(/[\s\S]*?<\/think>/gi, "");
  text = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  text = text.replace(/<redacted[^>]*>[\s\S]*?<\/redacted[^>]*>/gi, "");

  const start = text.indexOf("{");
  if (start > 0) {
    text = text.slice(start);
  }
  return text.trim();
}

/** Extract the outermost `{ ... }` object respecting JSON string boundaries. */
export function extractBalancedJsonObject(raw: string): string | null {
  const text = stripArtifactModelOutput(raw);

  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/** Close an unterminated string / array / object (truncated model output). */
export function closeTruncatedJson(json: string): string {
  let inString = false;
  let escaped = false;
  const closers: string[] = [];

  for (let i = 0; i < json.length; i++) {
    const c = json[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{") closers.push("}");
    else if (c === "[") closers.push("]");
    else if (c === "}" || c === "]") {
      if (closers.length > 0) closers.pop();
    }
  }

  let result = json;
  if (inString) result += '"';
  while (closers.length > 0) {
    result += closers.pop();
  }
  return result;
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function parseJsonCandidates(raw: string): Record<string, unknown> | null {
  const stripped = stripArtifactModelOutput(raw);
  const balanced = extractBalancedJsonObject(stripped);
  const base = balanced ?? stripped;

  const candidates = [
    base,
    escapeControlCharsInJsonStrings(base),
    closeTruncatedJson(base),
    closeTruncatedJson(escapeControlCharsInJsonStrings(base)),
  ];

  for (const text of candidates) {
    const parsed = tryParseObject(text);
    if (parsed) return parsed;
  }

  return null;
}

function readJsonStringField(text: string, field: string): string | null {
  const re = new RegExp(
    `"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
    "i"
  );
  const match = re.exec(text);
  if (!match?.[1]) return null;
  return match[1]
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** Salvage section objects from truncated / invalid JSON. */
export function extractSectionsFromBrokenJson(raw: string): Record<string, unknown>[] {
  const text = stripArtifactModelOutput(raw);
  const sections: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  const marker = /"kind"\s*:\s*"(HERO|INFO_BAR|GRID|SPLIT|STATS|QUOTES|FAQ|CTA|TEXT)"/gi;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(text)) !== null) {
    let start = match.index;
    while (start > 0 && text[start] !== "{") start--;

    const slice = extractBalancedJsonObject(text.slice(start));
    if (!slice) continue;

    const candidates = [slice, escapeControlCharsInJsonStrings(slice)];
    for (const candidate of candidates) {
      const obj = tryParseObject(candidate);
      if (obj?.kind && !seen.has(slice)) {
        seen.add(slice);
        sections.push(obj);
        break;
      }
    }
  }

  return sections;
}

/** Last-resort extractor for legacy raw-HTML JSON plans. */
export function extractHtmlPlanFallback(raw: string): Record<string, unknown> | null {
  const text = extractBalancedJsonObject(raw) ?? stripArtifactModelOutput(raw);
  const htmlMarker = /"html"\s*:\s*"/i.exec(text);
  if (!htmlMarker || htmlMarker.index === undefined) return null;

  let i = htmlMarker.index + htmlMarker[0].length;
  let html = "";
  let escaped = false;

  while (i < text.length) {
    const c = text[i];

    if (escaped) {
      if (c === "n") html += "\n";
      else if (c === "r") html += "\r";
      else if (c === "t") html += "\t";
      else if (c === '"') html += '"';
      else if (c === "\\") html += "\\";
      else html += c;
      escaped = false;
      i++;
      continue;
    }

    if (c === "\\") {
      escaped = true;
      i++;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "," || text[j] === "}") break;
      html += c;
      i++;
      continue;
    }

    html += c;
    i++;
  }

  if (!html.trim()) return null;

  const plan: Record<string, unknown> = { html };

  const nameMatch = /"output_name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i.exec(text);
  if (nameMatch?.[1]) {
    plan.output_name = nameMatch[1].replace(/\\"/g, '"');
  }

  return plan;
}

/** Salvage a structured HTML plan (title + sections) from broken output. */
export function extractStructuredHtmlPlanFallback(
  raw: string
): Record<string, unknown> | null {
  const text = stripArtifactModelOutput(raw);
  if (!text.includes("{")) return null;

  const title = readJsonStringField(text, "title");
  const tagline = readJsonStringField(text, "tagline");
  const theme = readJsonStringField(text, "theme");
  const archetype = readJsonStringField(text, "archetype");
  const output_name = readJsonStringField(text, "output_name");
  const sections = extractSectionsFromBrokenJson(text);

  if (!title && sections.length === 0) return null;

  const plan: Record<string, unknown> = {};
  if (title) plan.title = title;
  if (tagline) plan.tagline = tagline;
  if (theme) plan.theme = theme;
  if (archetype) plan.archetype = archetype;
  if (output_name) plan.output_name = output_name;
  if (sections.length > 0) plan.sections = sections;

  return plan;
}

export interface HtmlPlanParseFallback {
  prompt: string;
  archetype: string;
  theme: string;
}

/** Parse an HTML page plan — never throws; returns a renderable plan. */
export function parseHtmlPlanJson(
  raw: string,
  fallback: HtmlPlanParseFallback
): Record<string, unknown> {
  const direct = parseJsonCandidates(raw);
  if (direct) return direct;

  const structured = extractStructuredHtmlPlanFallback(raw);
  if (structured) return structured;

  const legacy = extractHtmlPlanFallback(raw);
  if (legacy) return legacy;

  if (raw.trim().length > 0) {
    console.warn(
      "HTML plan JSON parse failed; using empty section plan. Output preview:",
      raw.slice(0, 400)
    );
  }

  return {
    title: fallback.prompt.trim().slice(0, 120) || "Generated Page",
    archetype: fallback.archetype,
    theme: fallback.theme,
    sections: [],
  };
}

/** Parse an artifact plan object from raw model output. */
export function parseArtifactPlanJson(raw: string): Record<string, unknown> {
  const parsed = parseJsonCandidates(raw);
  if (parsed) return parsed;

  const structured = extractStructuredHtmlPlanFallback(raw);
  if (structured) return structured;

  const htmlFallback = extractHtmlPlanFallback(raw);
  if (htmlFallback) return htmlFallback;

  throw new Error("No valid JSON object found in model output.");
}
