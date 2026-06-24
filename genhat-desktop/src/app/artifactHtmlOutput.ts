/**
 * Extract and validate raw HTML from model output for /html artifacts.
 * HTML is emitted as a full document (not JSON) to avoid escaping/truncation issues.
 */

import {
  extractHtmlPlanFallback,
  parseArtifactPlanJson,
} from "./artifactPlanJson";

const MIN_HTML_CHARS = 400;
const MIN_VISIBLE_TEXT_CHARS = 120;

export function slugifyArtifactName(text: string): string {
  const slug = text
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return slug || "nela_html";
}

function stripModelPreamble(raw: string): string {
  let text = raw.trim();
  text = text.replace(/[\s\S]*?<\/think>/gi, "");
  text = text.replace(/^```(?:html)?\s*/i, "");
  text = text.replace(/\s*```$/i, "");
  return text.trim();
}

function visibleTextLength(html: string): number {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/** Pull the best HTML document string from model output (raw HTML or legacy JSON). */
export function extractRawHtmlFromModelOutput(raw: string): string {
  const cleaned = stripModelPreamble(raw);

  // Legacy JSON plans — keep supporting them if the model still emits JSON.
  if (cleaned.startsWith("{") || cleaned.includes('"html"')) {
    try {
      const plan = parseArtifactPlanJson(raw);
      const html = plan.html;
      if (typeof html === "string" && html.trim().length > 0) {
        return html.trim();
      }
    } catch {
      const fallback = extractHtmlPlanFallback(raw);
      if (fallback && typeof fallback.html === "string" && fallback.html.trim()) {
        return fallback.html.trim();
      }
    }
  }

  const doctypeIdx = cleaned.search(/<!DOCTYPE\s+html/i);
  const htmlIdx = cleaned.search(/<html[\s>]/i);
  const start =
    doctypeIdx >= 0 ? doctypeIdx : htmlIdx >= 0 ? htmlIdx : cleaned.indexOf("<");

  if (start < 0) {
    return cleaned;
  }

  let html = cleaned.slice(start);
  const closeMatch = /<\/html>\s*/i.exec(html);
  if (closeMatch && closeMatch.index !== undefined) {
    html = html.slice(0, closeMatch.index + closeMatch[0].length);
  }

  return html.trim();
}

export function validateHtmlArtifact(html: string): void {
  const trimmed = html.trim();
  if (trimmed.length < MIN_HTML_CHARS) {
    throw new Error(
      "Generated HTML was empty or truncated. Try again, shorten the prompt, or use a model with a larger output limit."
    );
  }

  const visible = visibleTextLength(trimmed);
  if (visible < MIN_VISIBLE_TEXT_CHARS) {
    throw new Error(
      "Generated HTML has almost no visible content. Try again with a more capable model."
    );
  }

  if (!/<body[\s>]/i.test(trimmed) && !/<main[\s>]/i.test(trimmed)) {
    throw new Error(
      "Generated HTML is missing body content. Try again."
    );
  }
}

export function parseHtmlArtifactOutput(
  raw: string,
  topic: string
): { html: string; output_name: string } {
  const html = extractRawHtmlFromModelOutput(raw);
  validateHtmlArtifact(html);

  let output_name = slugifyArtifactName(topic);

  if (raw.trim().startsWith("{") || raw.includes('"output_name"')) {
    try {
      const plan = parseArtifactPlanJson(raw);
      if (typeof plan.output_name === "string" && plan.output_name.trim()) {
        output_name = slugifyArtifactName(plan.output_name);
      }
    } catch {
      // ignore — slug from topic is fine
    }
  }

  return { html, output_name };
}
