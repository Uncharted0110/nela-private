/**
 * Presentation prompts — local JSON+GBNF; cloud streams freeform HTML.
 */

import { NELA_NUMERICAL_ACCURACY_RULES } from "./nelaSystemPrompt";

/** Local / constrained schema (used with GBNF on device). */
export const PRESENTATION_SCHEMA_STATIC = `You generate ONLY a JSON presentation plan. No markdown, no code fences, no commentary.

Schema:
{"slides":[{"title":"string","layout":"TITLE"|"SECTION"|"BULLET"|"TWO_COLUMN"|"IMAGE_LEFT"|"STAT"|"QUOTE"|"CARDS"|"COMPARISON"|"CENTERED","bullets":["string"],"notes":"string","left_title":"string","right_title":"string"}],"theme":"midnight"|"corporate"|"sunset"|"minimal"|"academic"|"cyber"|"ocean"|"forest"|"lavender"|"neon"|"rose"|"slate"}

Layouts (pick to fit content):
- TITLE: cover. bullets = subtitle + 1–2 concrete taglines.
- SECTION: section divider with 1–3 real intro lines.
- BULLET: 4–6 bullets, each 15–40 words with a claim + brief explanation or example.
- TWO_COLUMN / IMAGE_LEFT: 4–6 concrete points.
- STAT: bullets[0] = headline metric/fact; then 2–3 supporting specifics. Prefer STAT when the topic has numbers.
- QUOTE: takeaway + attribution/context.
- CARDS: 3–4 items as "Label: 1–2 sentence specifics".
- COMPARISON: 3–5 points per side; left_title/right_title must be real domain terms (e.g. Classical vs Quantum), never "Primary approach".
- CENTERED: 2–4 short paragraphs of real takeaways.
- IMAGE_LEFT: set image_index from the AVAILABLE IMAGES catalog when present.

Content rules:
- First slide TITLE; last slide CENTERED with a concrete takeaway about THIS topic.
- Slide 1–2 must DEFINE the topic (what it is / how it works). Later slides need named examples (algorithms, products, people, events, case studies — whatever fits).
- When statistics exist, include at least one STAT slide with real figures.
- Every bullet must be specifically about the user's topic. No vague fluff ("transformative potential", "continuous innovation") unless tied to a fact.
- Use ≥4 different layouts. Avoid Q&A / References / Final Thoughts unless asked.
- Theme must match the topic.

${NELA_NUMERICAL_ACCURACY_RULES}`;

/**
 * Cloud structured JSON for free/fast models — reliable content, desktop renders HTML.
 * Weaker models truncate freeform HTML mid-CSS and produce blank black pages.
 */
export const PRESENTATION_CLOUD_JSON_STATIC = `You generate ONLY a JSON presentation plan. No markdown, no code fences, no commentary.

Schema:
{"slides":[{"title":"string","layout":"TITLE"|"SECTION"|"BULLET"|"TWO_COLUMN"|"IMAGE_LEFT"|"STAT"|"QUOTE"|"CARDS"|"COMPARISON"|"CENTERED","bullets":["string"],"notes":"string","left_title":"string","right_title":"string","left":["string"],"right":["string"],"image_index":0}],"theme":"midnight"|"corporate"|"sunset"|"minimal"|"academic"|"cyber"|"ocean"|"forest"|"lavender"|"neon"|"rose"|"slate","output_name":"string"}

Content rules:
- Answer the USER'S REQUEST exactly. Never pivot to worksheets, crafts, card projects, or unrelated products.
- Pack each slide with concrete facts (names, dates, places, figures). Bullets should be 15–40 words when possible — not one-word stubs.
- First slide TITLE; later slides use varied layouts. Prefer 6–10 slides unless the user asked for a count.
- When statistics exist, include at least one STAT slide. When AVAILABLE IMAGES exist, use IMAGE_LEFT with image_index.
- Theme should fit the tone (somber history → midnight/rose; business → corporate).
- Set output_name to a short filename-friendly title.

${NELA_NUMERICAL_ACCURACY_RULES}`;

/**
 * Cloud freeform HTML for capable models (Smart/Deep on paid tiers).
 */
export const PRESENTATION_CLOUD_HTML_STATIC = `You generate a complete, self-contained HTML slide presentation wrapped in a NELA artifact tag.

OUTPUT FORMAT (mandatory):
1. BEFORE the tag: 2–4 sentences in plain text explaining the deck (never write the words "nela-artifact" here).
2. Then:
   <nela-artifact type="text/html" title="Short Deck Title">
3. Emit a complete HTML document starting with <!DOCTYPE html>.
4. Close with </nela-artifact>.
5. AFTER the tag: 2–4 sentences summarizing slide coverage and inviting edits.

CRITICAL CONTENT RULES:
- Do NOT return JSON (no {"slides":...}). HTML only inside the artifact tag.
- WRITE ORDER (mandatory to avoid blank decks): put the full <body> with ALL slide markup and text FIRST, then a compact <style>, then <script>. Never write a long stylesheet before slide content.
- Keep CSS under ~80 lines. Prefer simple layouts over elaborate gradients.
- Build a multi-slide deck with arrow-key / button navigation and a slide counter.
- Mark each slide with class="slide". First slide must include class="slide active" so something is visible immediately.
- Converter-friendly layout: each .slide is a 16:9 page (1280×720 or 1920×1080), box-sizing:border-box. Do not put a long scrolling document inside one slide. Size charts/SVG/canvas with explicit pixel width and height. Prefer solid fills or linear-gradient (radial gradients and CSS filters become images on export).
- Complete creative freedom on colors/fonts — but content first, polish second.
- Content must be RICH and specific. Prefer 6–10 slides unless the user asked for a count.
- When the topic has statistics, include STAT slides (headline metric + supporting bullets).
- Do NOT write Chart.js, Plotly, or hand-rolled echarts.init. When AVAILABLE CHARTS are listed, embed with <div data-nela-chart="nela-chart:0"></div> on relevant slides.
- When AVAILABLE IMAGES are listed, embed with <img src="nela-img:0"> on relevant slides (hero / IMAGE_LEFT style layouts). Never invent image URLs.
- Stay on the USER'S TOPIC. Ignore off-topic web results (worksheets, crafts, product listings).
- Set <title> to a short accurate deck title.
- No markdown fences around the HTML.

${NELA_NUMERICAL_ACCURACY_RULES}`;

export type PresentationSystemParts = {
  cacheable: string;
  dynamic: string;
};

export type CloudPresentationMode = "html" | "json" | "local";

export function buildPresentationSystemParts(options: {
  slideCountInstruction: string;
  sourceDocumentRules: string;
  /** @deprecated Prefer cloudMode */
  cloudFreeform?: boolean;
  cloudMode?: CloudPresentationMode;
  hasImages?: boolean;
  hasCharts?: boolean;
}): PresentationSystemParts {
  const mode: CloudPresentationMode =
    options.cloudMode ??
    (options.cloudFreeform ? "html" : "local");

  const imageHint = options.hasImages
    ? mode === "html"
      ? "- AVAILABLE IMAGES are listed in the user message — embed with <img src=\"nela-img:0\"> (etc) on 1–3 slides."
      : "- AVAILABLE IMAGES are listed — set image_index on IMAGE_LEFT slides (and prefer at least one IMAGE_LEFT layout)."
    : "";

  const chartHint = options.hasCharts
    ? mode === "html"
      ? "- AVAILABLE CHARTS are listed — embed with <div data-nela-chart=\"nela-chart:0\"></div>. Never invent Chart.js or echarts.init."
      : ""
    : "";

  const dynamic = [
    `- ${options.slideCountInstruction}`,
    options.sourceDocumentRules.trim(),
    mode !== "local"
      ? "- Honor the user's topic exactly. Web research is optional supporting context — never let it replace the requested subject."
      : "",
    imageHint,
    chartHint,
  ]
    .filter(Boolean)
    .join("\n");

  const cacheable =
    mode === "html"
      ? PRESENTATION_CLOUD_HTML_STATIC
      : mode === "json"
        ? PRESENTATION_CLOUD_JSON_STATIC
        : PRESENTATION_SCHEMA_STATIC;

  return { cacheable, dynamic };
}

export function buildPresentationSystemPrompt(options: {
  slideCountInstruction: string;
  sourceDocumentRules: string;
  cloudFreeform?: boolean;
  cloudMode?: CloudPresentationMode;
}): string {
  const parts = buildPresentationSystemParts(options);
  return parts.dynamic
    ? `${parts.cacheable}\n\n${parts.dynamic}`
    : parts.cacheable;
}

/** @deprecated Prefer PRESENTATION_CLOUD_HTML_STATIC / PRESENTATION_CLOUD_JSON_STATIC */
export const PRESENTATION_CLOUD_SCHEMA_STATIC = PRESENTATION_CLOUD_JSON_STATIC;
