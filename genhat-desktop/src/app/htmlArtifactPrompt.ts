/**
 * Structured HTML page plans — the model fills content; Rust renders the page.
 * Cloud Smart/Deep use freeform HTML instead of the section template.
 */

export const HTML_PLAN_MAX_TOKENS = 4096;
/** Freeform HTML needs room for a full page (CSS + content). */
export const HTML_FREEFORM_MAX_TOKENS = 12_000;

/**
 * Cloud freeform HTML for capable models (Smart/Deep on paid tiers).
 * Do NOT force HERO/GRID/STATS templates — the model designs the page.
 */
export const HTML_CLOUD_FREEFORM_STATIC = `You generate a complete, self-contained HTML webpage wrapped in a NELA artifact tag.

OUTPUT FORMAT (mandatory):
1. BEFORE the tag: 2–4 sentences in plain text explaining what page you are building (never write the words "nela-artifact" here).
2. Then open a tag exactly like:
   <nela-artifact type="text/html" title="Short Page Title">
3. Emit a complete HTML document starting with <!DOCTYPE html>.
4. Close with </nela-artifact>.
5. AFTER the tag: 2–4 sentences summarizing what is on the page and inviting edits.

CRITICAL CONTENT RULES:
- Do NOT return JSON. Do NOT use a fixed HERO / GRID / STATS / FAQ section schema.
- Invent your own layout, typography, color system, and structure that fit the topic.
- Put meaningful page content in the body before long CSS when possible.
- Keep CSS reasonably compact; prefer one cohesive design over many competing effects.
- Content must be rich and specific to the USER'S TOPIC (real places, offerings, tone).
- Use web research only as supporting facts — never let off-topic search results replace the subject.
- Set <title> to a short accurate page title.
- Self-contained: inline <style> (and minimal <script> only if needed). No external frameworks required.
- No markdown fences around the HTML.`;

export const HTML_RENDERER_THEMES = [
  "midnight",
  "corporate",
  "sunset",
  "minimal",
  "forest",
  "rose",
  "cyber",
  "ocean",
  "academic",
  "lavender",
  "neon",
  "slate",
  "aurora",
  "paper",
] as const;

export type HtmlRendererTheme = (typeof HTML_RENDERER_THEMES)[number];

export const HTML_SECTION_KINDS = [
  "HERO",
  "INFO_BAR",
  "GRID",
  "SPLIT",
  "STATS",
  "QUOTES",
  "FAQ",
  "CTA",
  "TEXT",
  "CHART",
  "IMAGE",
] as const;

export type HtmlSectionKind = (typeof HTML_SECTION_KINDS)[number];

export const HTML_CHART_TYPES = ["bar", "pie", "line"] as const;
export type HtmlChartType = (typeof HTML_CHART_TYPES)[number];

/** Suggested palette per page type when the prompt does not imply a theme. */
export function defaultThemeForArchetype(archetype: string): HtmlRendererTheme {
  const map: Record<string, HtmlRendererTheme> = {
    landing: "midnight",
    local_business: "sunset",
    article: "minimal",
    portfolio: "rose",
    dashboard: "aurora",
    documentation: "minimal",
    event: "rose",
    comparison: "corporate",
    catalog: "minimal",
    resume: "minimal",
    infographic: "forest",
    newsletter: "rose",
    interactive: "midnight",
  };
  return map[archetype] ?? "midnight";
}

/** Map legacy or presentation theme names to renderer palettes. */
export function mapHtmlRendererTheme(theme: string): HtmlRendererTheme {
  if ((HTML_RENDERER_THEMES as readonly string[]).includes(theme)) {
    return theme as HtmlRendererTheme;
  }
  const map: Record<string, HtmlRendererTheme> = {
    cyber: "cyber",
    ocean: "ocean",
    academic: "academic",
    lavender: "lavender",
    neon: "neon",
    slate: "slate",
  };
  return map[theme] ?? "midnight";
}

const ARCHETYPE_SECTIONS: Record<string, { kinds: HtmlSectionKind[]; hint: string }> = {
  landing: {
    kinds: ["HERO", "GRID", "STATS", "QUOTES", "FAQ", "CTA"],
    hint: "SaaS/product landing — features grid, metrics, testimonials, FAQ",
  },
  local_business: {
    kinds: ["HERO", "INFO_BAR", "GRID", "SPLIT", "QUOTES", "CTA"],
    hint: "Restaurant/shop — hours & address chips, menu/services grid, story, reviews",
  },
  article: {
    kinds: ["HERO", "TEXT", "TEXT", "QUOTES", "CTA"],
    hint: "Blog/editorial — long paragraphs in TEXT sections, pull quote",
  },
  portfolio: {
    kinds: ["HERO", "GRID", "SPLIT", "CTA"],
    hint: "Creative portfolio — project grid, about split",
  },
  dashboard: {
    kinds: ["HERO", "STATS", "CHART", "CHART", "TEXT"],
    hint:
      "Analytics dashboard — KPI STATS band, two CHART sections (bar/pie/line), TEXT insights. " +
      "When source data is attached: CHART sections MUST use label_column + value_column (exact header names) and aggregation; leave items empty.",
  },
  documentation: {
    kinds: ["HERO", "TEXT", "GRID", "FAQ"],
    hint: "Docs/tutorial — explanatory TEXT, reference GRID, FAQ",
  },
  event: {
    kinds: ["HERO", "INFO_BAR", "GRID", "QUOTES", "CTA"],
    hint: "Event — date/venue info bar, schedule/speakers grid",
  },
  comparison: {
    kinds: ["HERO", "GRID", "SPLIT", "FAQ", "CTA"],
    hint: "Vs/compare — option cards in GRID, pros/cons in SPLIT",
  },
  catalog: {
    kinds: ["HERO", "GRID", "STATS", "CTA"],
    hint: "Shop — product cards with prices in meta field",
  },
  resume: {
    kinds: ["HERO", "GRID", "SPLIT", "CTA"],
    hint: "CV — skills GRID, experience SPLIT",
  },
  infographic: {
    kinds: ["HERO", "STATS", "GRID", "TEXT", "CTA"],
    hint: "Educational — big STATS, fact GRID",
  },
  newsletter: {
    kinds: ["HERO", "TEXT", "QUOTES", "CTA"],
    hint: "Signup — benefits TEXT, social proof QUOTES",
  },
  interactive: {
    kinds: ["HERO", "GRID"],
    hint:
      "A working mini-app (NOT a marketing landing page). HERO = short tool title + one-line instruction. GRID = the pool of real items to pick from (movies, recipes, books, etc.) — at least 8 items. label=item name, detail=short description, meta=year/genre/tag. Do NOT write about a company, service, signup, FAQ, or features.",
  },
};

const THEME_LIST = HTML_RENDERER_THEMES.join(" | ");

/** Stable schema + layout docs — cacheable across HTML artifact cloud requests. */
export const HTML_ARTIFACT_SCHEMA_STATIC = `You generate a structured JSON plan for a web page. A native renderer builds the final HTML — you only provide content.

Return ONLY valid JSON matching this shape:
{
  "title": "Page headline / business name",
  "tagline": "Short subtitle",
  "archetype": "landing | local_business | article | portfolio | dashboard | documentation | event | comparison | catalog | resume | infographic | newsletter | interactive",
  "theme": ${THEME_LIST.split(" | ").map((t) => `"${t}"`).join(" | ")},
  "sections": [
    {
      "kind": "HERO" | "INFO_BAR" | "GRID" | "SPLIT" | "STATS" | "QUOTES" | "FAQ" | "CTA" | "TEXT" | "CHART" | "IMAGE",
      "title": "Section heading",
      "subtitle": "optional",
      "body": "optional paragraph",
      "chart_type": "bar" | "pie" | "line",
      "label_column": "optional — exact CSV/XLSX header",
      "value_column": "optional — exact CSV/XLSX header",
      "aggregation": "sum" | "count" | "avg" | "min" | "max",
      "image_index": 0,
      "items": [{ "label": "...", "detail": "...", "meta": "numeric string for charts" }]
    }
  ],
  "output_name": "file-slug"
}

Section kind reference:
- HERO: page title in "title", tagline in subtitle, intro in body
- INFO_BAR: items = hours, address, phone (label + detail)
- GRID: items = cards (menu items, features, products) — use meta for price
- SPLIT: body = long about/story paragraph
- STATS: items = metrics (label = number, detail = label text) — auto-filled when source data attached
- CHART: chart_type required; bar for comparisons, pie for proportions, line for trends
- IMAGE: full-width illustration; set image_index from the image catalog when available
- QUOTES: items = testimonials (label = quote, detail = attribution)
- FAQ: items = questions (label = Q, detail = A)
- CTA: closing call-to-action title + subtitle
- TEXT: article paragraphs in body

Rules:
- Fill EVERY required section with real, topic-specific content (no lorem ipsum).
- Use at least 3 items in GRID sections; at least 2 in FAQ/QUOTES when present.
- Dashboard archetype: include exactly two CHART sections with different chart_type when possible.
- For interactive archetype: GRID must list actual pickable items, never marketing bullets.
- Pick theme that fits the topic (food/local → sunset or rose, tech → cyber or midnight, data → aurora or corporate).
- No markdown, no code fences, no explanations outside JSON.`;

export type HtmlArtifactSystemParts = {
  /** Stable schema — first system message for OpenRouter caching. */
  cacheable: string;
  /** Per-request archetype / data / image instructions. */
  dynamic: string;
};

export type CloudHtmlMode = "html" | "json" | "local";

export function buildHtmlArtifactSystemParts(
  archetype: string,
  options?: {
    hasSourceData?: boolean;
    hasImages?: boolean;
    /** Smart/Deep cloud freeform vs structured JSON plan. */
    cloudMode?: CloudHtmlMode;
  }
): HtmlArtifactSystemParts {
  if (options?.cloudMode === "html") {
    const imageHint = options.hasImages
      ? "Image URLs/catalog entries may appear in the user message — use real ones when they fit; otherwise omit images."
      : "";
    const dataHint = options.hasSourceData
      ? "Source spreadsheet data may be attached — visualize real columns when building charts/tables; do not invent numbers."
      : "";
    return {
      cacheable: HTML_CLOUD_FREEFORM_STATIC,
      dynamic: [imageHint, dataHint].filter(Boolean).join("\n\n"),
    };
  }

  const spec = ARCHETYPE_SECTIONS[archetype] ?? ARCHETYPE_SECTIONS.landing;
  const kindsList = spec.kinds.join(", ");
  const suggestedTheme = defaultThemeForArchetype(archetype);
  const dataRules = options?.hasSourceData
    ? `SOURCE DATA RULES (attached file — STRICT):
- NEVER invent or guess numeric values. All chart numbers are computed from the file in the renderer.
- CHART sections: set label_column, value_column, aggregation (sum|count|avg|min|max). Omit items or use an empty items array.
- STATS numeric KPIs are auto-computed from the file — focus chart column choices and TEXT insights.
- Use exact column header names from the data context.`
    : `NO SOURCE FILE:
- CHART sections: provide items with label (category) and meta (numeric value as string).
- You may use plausible illustrative data for demos when no file is attached.`;

  const imageRules = options?.hasImages
    ? `IMAGES (available in catalog):
- Use IMAGE sections or HERO/SPLIT with image_index to place real images.
- Set image_index to the catalog index; do not use placeholder URLs.`
    : "";

  const dynamic = [
    `Page archetype: ${archetype} — ${spec.hint}`,
    `Suggested theme for this archetype: ${suggestedTheme}`,
    `Required section kinds IN THIS ORDER: ${kindsList}`,
    `Set JSON "archetype" to "${archetype}".`,
    dataRules,
    imageRules,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { cacheable: HTML_ARTIFACT_SCHEMA_STATIC, dynamic };
}

export function buildHtmlArtifactSystemPrompt(
  archetype: string,
  options?: { hasSourceData?: boolean; hasImages?: boolean }
): string {
  const parts = buildHtmlArtifactSystemParts(archetype, options);
  return `${parts.cacheable}\n\n${parts.dynamic}`;
}

export function htmlPlanRequest(
  text: string,
  archetype: string,
  options?: { hasSourceData?: boolean; cloudMode?: CloudHtmlMode }
): string {
  if (options?.cloudMode === "html") {
    return (
      `Write a complete HTML webpage for: "${text}". ` +
      `Stay on this exact subject. ` +
      `Wrap the document in <nela-artifact type="text/html" title="...">...</nela-artifact>. ` +
      `Invent your own design — do not use a JSON section template.`
    );
  }

  const spec = ARCHETYPE_SECTIONS[archetype] ?? ARCHETYPE_SECTIONS.landing;
  if (archetype === "interactive") {
    return `Build an interactive tool page for: "${text}".

This is a mini-app the user runs in the browser — NOT a landing page for a product or service.
Archetype: interactive. Sections: ${spec.kinds.join(", ")}.
HERO: tool name + one instruction line (e.g. "Press the button for a random movie").
GRID: at least 8 real items to pick from (movies, songs, recipes — match the topic). Each item needs label, detail, and meta.`;
  }
  if (archetype === "dashboard") {
    const dataNote = options?.hasSourceData
      ? "Source spreadsheet is attached — reference real column names in CHART sections; do not invent numbers."
      : "No file attached — use realistic demo numbers in CHART items.";
    return `Build an analytics dashboard page for: "${text}".

Archetype: dashboard. Sections: ${spec.kinds.join(", ")}.
Include two CHART sections (bar, pie, or line) plus KPI STATS and a TEXT insights section.
${dataNote}`;
  }
  return `Create a complete page plan for: "${text}".

Archetype: ${archetype}. Include all section kinds: ${spec.kinds.join(", ")}.
Write detailed, specific content for the topic in every section.`;
}

export {
  HTML_PAGE_ARCHETYPES,
  inferHtmlPageStructure,
  normalizeHtmlArchetype,
  type HtmlPageArchetype,
} from "./htmlPageArchetypes";
