/**
 * Extract and validate raw HTML from model output for /html artifacts.
 * HTML is emitted as a full document (not JSON) to avoid escaping/truncation issues.
 */

import {
  extractHtmlPlanFallback,
  parseArtifactPlanJson,
} from "./artifactPlanJson";
import {
  deriveArtifactFilename,
  extractWorkbookFilename,
} from "./artifactFilename";

const MIN_HTML_CHARS = 400;
const MIN_VISIBLE_TEXT_CHARS = 120;
const MIN_PRESENTATION_HTML_CHARS = 800;
const MIN_PRESENTATION_VISIBLE_CHARS = 250;

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
  // Prefer fenced HTML blocks when present (models often wrap output).
  const fence =
    text.match(/```(?:html|HTML)\s*([\s\S]*?)```/) ||
    text.match(/```\s*(<!DOCTYPE[\s\S]*?|[\s\S]*?<html[\s\S]*?)```/i);
  if (fence?.[1]) {
    text = fence[1].trim();
  } else {
    text = text.replace(/^```(?:html)?\s*/i, "");
    text = text.replace(/\s*```$/i, "");
  }
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

/** True when the model returned a structured slide plan instead of HTML. */
export function looksLikePresentationJsonPlan(raw: string): boolean {
  const cleaned = stripModelPreamble(raw).trim();
  if (!cleaned.includes("slides")) return false;
  // Fast path: starts like JSON
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    try {
      const obj = JSON.parse(cleaned) as Record<string, unknown>;
      return Array.isArray(obj.slides) && obj.slides.length > 0;
    } catch {
      // fall through to loose check
    }
  }
  try {
    const plan = parseArtifactPlanJson(raw);
    return Array.isArray(plan.slides) && plan.slides.length > 0;
  } catch {
    return /"slides"\s*:\s*\[/.test(cleaned);
  }
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
  const bodyIdx = cleaned.search(/<body[\s>]/i);
  const start =
    doctypeIdx >= 0
      ? doctypeIdx
      : htmlIdx >= 0
        ? htmlIdx
        : bodyIdx >= 0
          ? bodyIdx
          : cleaned.search(/<(?:div|section|main|article|header)[\s>]/i);

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

/** Minor repairs only — close obvious truncations; wrap fragments if needed. */
export function lightRepairPresentationHtml(
  html: string,
  fallbackTitle = "Presentation"
): string {
  let out = html.trim();
  if (!out) return out;

  // Model returned a fragment (slides/divs/headings) without a document shell.
  const hasBody = /<body[\s>]/i.test(out);
  const hasHtml = /<html[\s>]/i.test(out);
  const hasFragment =
    /<(?:div|section|main|article|header|style|script|head|h[1-6]|p|ul|ol|table|nav|footer)[\s>]/i.test(
      out
    );

  if (!hasBody && !hasHtml && hasFragment) {
    const safeTitle = fallbackTitle
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    out = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeTitle}</title>
</head>
<body>
${out}
</body>
</html>`;
  } else if (hasHtml && !hasBody && hasFragment) {
    // <html>…content… without <body> — wrap inner content lightly.
    if (/<\/head>/i.test(out)) {
      out = out.replace(/<\/head>/i, `</head>\n<body>`).replace(/<\/html>/i, `</body>\n</html>`);
      if (!/<\/body>/i.test(out)) {
        out = out.replace(/<\/html>/i, `</body>\n</html>`);
      }
    } else {
      out = out.replace(
        /<html([^>]*)>/i,
        `<html$1><head><meta charset="UTF-8" /><title>${fallbackTitle.replace(/[<>&"]/g, "")}</title></head><body>`
      );
      if (!/<\/body>/i.test(out)) {
        out = out.replace(/<\/html>/i, `</body></html>`);
        if (!/<\/html>/i.test(out)) out += `\n</body>\n</html>`;
      }
    }
  }

  if (!/<!DOCTYPE\s+html/i.test(out) && /<html[\s>]/i.test(out)) {
    out = `<!DOCTYPE html>\n${out}`;
  }

  if (/<html[\s>]/i.test(out) && !/<\/html>/i.test(out)) {
    if (/<body[\s>]/i.test(out) && !/<\/body>/i.test(out)) {
      out += "\n</body>";
    }
    out += "\n</html>";
  }

  // Help iframe preview scale if the model forgot a viewport meta.
  if (/<head[\s>]/i.test(out) && !/<meta[^>]+viewport/i.test(out)) {
    out = out.replace(
      /<head([^>]*)>/i,
      `<head$1>\n<meta charset="UTF-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1.0" />`
    );
  }

  return out;
}

function extractTitleFromHtml(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return null;
  const title = m[1].replace(/\s+/g, " ").trim();
  return title || null;
}

function countSlideMarkers(html: string): number {
  const patterns = [
    /class\s*=\s*["'][^"']*\bslide\b/gi,
    /data-slide\s*=/gi,
    /class\s*=\s*["'][^"']*\bdeck-slide\b/gi,
    /class\s*=\s*["'][^"']*\bppt-slide\b/gi,
    /id\s*=\s*["']slide[-_]?\d+/gi,
  ];
  let max = 0;
  for (const re of patterns) {
    const n = (html.match(re) || []).length;
    if (n > max) max = n;
  }
  if (max < 2) {
    const sections = (html.match(/<section[\s>]/gi) || []).length;
    if (sections > max) max = sections;
  }
  if (max < 2) {
    // Many freeform decks use article/div panes with role or aria labels.
    const panes = (
      html.match(
        /<(?:div|article)[^>]*(?:aria-label\s*=\s*["'][^"']*slide|role\s*=\s*["'](?:region|group))/gi
      ) || []
    ).length;
    if (panes > max) max = panes;
  }
  return max;
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

  if (
    !/<body[\s>]/i.test(trimmed) &&
    !/<main[\s>]/i.test(trimmed) &&
    !/<(?:div|section|article|header)[\s>]/i.test(trimmed)
  ) {
    throw new Error(
      "Generated HTML is missing body content. Try again."
    );
  }
}

export function validatePresentationHtmlArtifact(html: string): void {
  validateHtmlArtifact(html);
  const trimmed = html.trim();
  if (trimmed.length < MIN_PRESENTATION_HTML_CHARS) {
    throw new Error(
      "Presentation HTML looks truncated. Try again with a larger output limit."
    );
  }
  if (visibleTextLength(trimmed) < MIN_PRESENTATION_VISIBLE_CHARS) {
    throw new Error(
      "Presentation has too little visible content. Try again and ask for denser slides."
    );
  }
  if (isShellOnlyOrTruncatedPresentationHtml(trimmed)) {
    throw new Error(
      "Presentation HTML was truncated (styles without slide content). Try again."
    );
  }
  // Prefer multi-slide markers, but allow rich freeform HTML without them
  // (preview still works). Only reject clearly non-deck stubs.
  const slides = countSlideMarkers(trimmed);
  if (slides < 2 && visibleTextLength(trimmed) < 900) {
    throw new Error(
      "Presentation HTML does not look like a multi-slide deck. Try again."
    );
  }
}

/**
 * Free/fast models often burn tokens on CSS and never emit slides → blank black page.
 * Detect stylesheet-heavy / content-empty shells.
 */
export function isShellOnlyOrTruncatedPresentationHtml(html: string): boolean {
  const trimmed = html.trim();
  if (!trimmed) return true;

  // Unclosed <style> (truncated mid-CSS) — matches the blank black WW2 artifact.
  if (/<style[\s>]/i.test(trimmed) && !/<\/style>/i.test(trimmed)) return true;

  const styleBlocks = trimmed.match(/<style[\s\S]*?<\/style>/gi) || [];
  const styleLen = styleBlocks.reduce((n, s) => n + s.length, 0);
  const visible = visibleTextLength(trimmed);
  const slideEls = countSlideMarkers(trimmed);

  if (styleLen > 1500 && visible < 300) return true;
  if (styleLen > 2500 && visible < 600) return true;
  if (
    slideEls === 0 &&
    /background:\s*linear-gradient/i.test(trimmed) &&
    visible < 400
  ) {
    return true;
  }
  if (slideEls > 0 && visible < 250) return true;

  return false;
}

/** True when the model returned a structured HTML section plan instead of freeform HTML. */
export function looksLikeHtmlPageJsonPlan(raw: string): boolean {
  const cleaned = stripModelPreamble(raw).trim();
  if (!cleaned.includes("sections")) return false;
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    try {
      const obj = JSON.parse(cleaned) as Record<string, unknown>;
      return Array.isArray(obj.sections);
    } catch {
      /* fall through */
    }
  }
  return /"sections"\s*:\s*\[/.test(cleaned) && /"archetype"\s*:/.test(cleaned);
}

export function parseHtmlArtifactOutput(
  raw: string,
  topic: string
): { html: string; output_name: string; title: string } {
  if (looksLikeHtmlPageJsonPlan(raw)) {
    throw new Error("MODEL_RETURNED_JSON_HTML_PLAN");
  }

  const extracted = extractRawHtmlFromModelOutput(raw);
  // Same shell repair as presentations — models often emit <head>/<h1> fragments
  // without a <body>, which used to fail validation as "missing body content".
  const html = lightRepairPresentationHtml(extracted, topic);
  validateHtmlArtifact(html);

  const fromTitle = extractTitleFromHtml(html);
  const title = fromTitle || topic.trim().slice(0, 120) || "Generated Page";
  let output_name = deriveArtifactFilename({
    llmName: extractWorkbookFilename(raw),
    htmlTitle: fromTitle,
    topic,
    fallback: "webpage",
  });

  if (raw.trim().startsWith("{") || raw.includes('"output_name"')) {
    try {
      const plan = parseArtifactPlanJson(raw);
      if (typeof plan.output_name === "string" && plan.output_name.trim()) {
        output_name = deriveArtifactFilename({
          llmName: plan.output_name,
          htmlTitle: fromTitle,
          topic,
          fallback: "webpage",
        });
      }
    } catch {
      // ignore — slug from topic is fine
    }
  }

  return { html, output_name, title };
}

/** Cloud freeform PPT: extract HTML, light-repair, validate as a deck. */
export function parsePresentationHtmlArtifactOutput(
  raw: string,
  topic: string
): { html: string; output_name: string; title: string } {
  if (looksLikePresentationJsonPlan(raw)) {
    throw new Error("MODEL_RETURNED_JSON_SLIDE_PLAN");
  }

  const extracted = extractRawHtmlFromModelOutput(raw);
  const html = lightRepairPresentationHtml(extracted, topic);
  validatePresentationHtmlArtifact(html);

  const fromTitle = extractTitleFromHtml(html);
  const title = fromTitle || topic.trim().slice(0, 120) || "Presentation";
  const output_name = deriveArtifactFilename({
    llmName: extractWorkbookFilename(raw),
    htmlTitle: fromTitle,
    topic,
    fallback: "presentation",
  });

  return { html, output_name, title };
}
