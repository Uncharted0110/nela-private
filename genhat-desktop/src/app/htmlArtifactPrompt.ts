/**
 * Structured HTML page plans — the model fills content; Rust renders the page.
 */

export const HTML_PLAN_MAX_TOKENS = 4096;

export const HTML_RENDERER_THEMES = [
  "midnight",
  "corporate",
  "sunset",
  "minimal",
  "forest",
  "rose",
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
] as const;

export type HtmlSectionKind = (typeof HTML_SECTION_KINDS)[number];

/** Suggested palette per page type when the prompt does not imply a theme. */
export function defaultThemeForArchetype(archetype: string): HtmlRendererTheme {
  const map: Record<string, HtmlRendererTheme> = {
    landing: "midnight",
    local_business: "sunset",
    article: "minimal",
    portfolio: "rose",
    dashboard: "corporate",
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

/** Map presentation-style theme names to renderer-supported palettes. */
export function mapHtmlRendererTheme(theme: string): HtmlRendererTheme {
  if ((HTML_RENDERER_THEMES as readonly string[]).includes(theme)) {
    return theme as HtmlRendererTheme;
  }
  const map: Record<string, HtmlRendererTheme> = {
    cyber: "midnight",
    ocean: "corporate",
    academic: "minimal",
    lavender: "rose",
    neon: "sunset",
    slate: "corporate",
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
    kinds: ["HERO", "STATS", "GRID", "TEXT"],
    hint: "Analytics — KPI stats, widget cards",
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

export function buildHtmlArtifactSystemPrompt(archetype: string): string {
  const spec = ARCHETYPE_SECTIONS[archetype] ?? ARCHETYPE_SECTIONS.landing;
  const kindsList = spec.kinds.join(", ");
  const suggestedTheme = defaultThemeForArchetype(archetype);

  return `You generate a structured JSON plan for a web page. A native renderer builds the final HTML — you only provide content.

Return ONLY valid JSON matching this shape:
{
  "title": "Page headline / business name",
  "tagline": "Short subtitle",
  "archetype": "${archetype}",
  "theme": "midnight" | "corporate" | "sunset" | "minimal" | "forest" | "rose",
  "sections": [
    {
      "kind": "HERO" | "INFO_BAR" | "GRID" | "SPLIT" | "STATS" | "QUOTES" | "FAQ" | "CTA" | "TEXT",
      "title": "Section heading",
      "subtitle": "optional",
      "body": "optional paragraph",
      "items": [{ "label": "...", "detail": "...", "meta": "optional price/stat" }]
    }
  ],
  "output_name": "file-slug"
}

Page archetype: ${archetype} — ${spec.hint}
Suggested theme for this archetype: ${suggestedTheme}

Required section kinds IN THIS ORDER: ${kindsList}
- HERO: page title in "title", tagline in subtitle, intro in body
- INFO_BAR: items = hours, address, phone (label + detail)
- GRID: items = cards (menu items, features, products) — use meta for price
- SPLIT: body = long about/story paragraph
- STATS: items = metrics (label = number, detail = label text)
- QUOTES: items = testimonials (label = quote, detail = attribution)
- FAQ: items = questions (label = Q, detail = A)
- CTA: closing call-to-action title + subtitle
- TEXT: article paragraphs in body

Rules:
- Fill EVERY required section with real, topic-specific content (no lorem ipsum).
- Use at least 3 items in GRID sections; at least 2 in FAQ/QUOTES when present.
- For interactive archetype: GRID must list actual pickable items (e.g. real movie titles), never marketing bullets about an app.
- Pick theme that fits the topic (food/local → sunset or rose, tech → midnight, nature → forest).
- No markdown, no code fences, no explanations outside JSON.`;
}

export function htmlPlanRequest(text: string, archetype: string): string {
  const spec = ARCHETYPE_SECTIONS[archetype] ?? ARCHETYPE_SECTIONS.landing;
  if (archetype === "interactive") {
    return `Build an interactive tool page for: "${text}".

This is a mini-app the user runs in the browser — NOT a landing page for a product or service.
Archetype: interactive. Sections: ${spec.kinds.join(", ")}.
HERO: tool name + one instruction line (e.g. "Press the button for a random movie").
GRID: at least 8 real items to pick from (movies, songs, recipes — match the topic). Each item needs label, detail, and meta.`;
  }
  return `Create a complete page plan for: "${text}".

Archetype: ${archetype}. Include all section kinds: ${spec.kinds.join(", ")}.
Write detailed, specific content for the topic in every section.`;
}

// Re-export archetype inference from existing module
export {
  HTML_PAGE_ARCHETYPES,
  inferHtmlPageStructure,
  normalizeHtmlArchetype,
  type HtmlPageArchetype,
} from "./htmlPageArchetypes";
