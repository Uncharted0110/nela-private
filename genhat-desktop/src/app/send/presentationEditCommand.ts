/**
 * Hybrid presentation edit system — command vocabulary + deterministic parser.
 *
 * The preview edit bar resolves user requests into structured
 * `PresentationEditCommand`s. Most phrasings parse here with 0 LLM calls;
 * anything left over goes to the single-call planner
 * (`presentationEditPlanner.ts`) which emits the same command vocabulary.
 */

import {
  isPresentationSlideAddRequest,
  isPresentationSlideExpandRequest,
  isPresentationSlideImageChangeRequest,
  isPresentationSlideMoveRequest,
  isPresentationSlideRemoveRequest,
  isPresentationThemeStyleRequest,
  parseOneBasedSlideNumber,
} from "../artifactEdit";
import { oklchToHex, rgbToOklch } from "./themePaletteEngine";

// ── Types ────────────────────────────────────────────────────────────────────

export type SlideScope =
  | { type: "deck" }
  | { type: "slide"; oneBased: number }
  | { type: "first" }
  | { type: "last" };

export type PresentationEditCommand =
  /* Style — fully deterministic */
  | { kind: "set_background"; scope: SlideScope; color: string; colorLabel: string }
  | { kind: "set_text_color"; scope: SlideScope; color: string; colorLabel: string }
  | { kind: "set_font"; font: string }
  | { kind: "set_theme"; prompt: string }
  | { kind: "set_layout"; scope: SlideScope; layout: string }
  | { kind: "reformat_content"; scope: SlideScope; style: "bullets" | "paragraph" }
  /* Structural — delegated to the existing deterministic runners (raw text) */
  | { kind: "add_slide"; raw: string }
  | { kind: "remove_slide"; raw: string }
  | { kind: "move_slide"; raw: string }
  | { kind: "expand_content"; raw: string }
  /**
   * Image swap. The planner fills `oneBased` + `query` (its own image search
   * query) so the executor can offer candidates; `raw` keeps the legacy
   * runner working for the deterministic fallback path.
   */
  | { kind: "change_image"; raw: string; oneBased?: number; query?: string }
  /* Planner-only (concrete content emitted by the LLM planner) */
  | {
      kind: "patch_content";
      oneBased: number;
      title?: string;
      bullets?: string[];
      layout?: string;
    }
  | {
      kind: "add_slide_spec";
      /** 0-based insert index; undefined = end. */
      insertIndex?: number;
      title: string;
      bullets: string[];
      layout?: string;
    }
  | { kind: "remove_slide_at"; oneBased: number }
  | { kind: "move_slide_spec"; fromOneBased: number; toOneBased: number };

export type ParsedEditCommands = {
  commands: PresentationEditCommand[];
  /** Unparsed request text — non-empty means the planner must run. */
  residual: string;
};

/** Resolve a SlideScope against the current slide count → 0-based index. */
export function resolveScopeIndex(
  scope: SlideScope,
  slideCount: number
): number | null {
  if (slideCount < 1) return null;
  switch (scope.type) {
    case "deck":
      return null;
    case "first":
      return 0;
    case "last":
      return slideCount - 1;
    case "slide": {
      const idx = scope.oneBased - 1;
      return Math.max(0, Math.min(slideCount - 1, idx));
    }
  }
}

export function describeScope(scope: SlideScope): string {
  switch (scope.type) {
    case "deck":
      return "the whole deck";
    case "first":
      return "the first slide";
    case "last":
      return "the last slide";
    case "slide":
      return `slide ${scope.oneBased}`;
  }
}

// ── "This slide" normalization ───────────────────────────────────────────────

const THIS_SLIDE_RE =
  /\b(?:this|the\s+current|current|the\s+open|the\s+active|active)\s+slide\b/gi;

/** True when the request refers to the slide currently visible in the preview. */
export function mentionsThisSlide(text: string): boolean {
  THIS_SLIDE_RE.lastIndex = 0;
  return THIS_SLIDE_RE.test(text);
}

/**
 * Rewrite "this slide" / "the current slide" into "slide N" so every existing
 * parser (and the planner) sees a concrete target. `activeSlideIndex` is
 * 0-based (from the preview iframe); null falls back to slide 1.
 */
export function normalizeThisSlideReferences(
  text: string,
  activeSlideIndex: number | null | undefined
): { text: string; usedFallback: boolean } {
  if (!mentionsThisSlide(text)) return { text, usedFallback: false };
  const known = activeSlideIndex != null && activeSlideIndex >= 0;
  const oneBased = known ? activeSlideIndex + 1 : 1;
  const next = text.replace(THIS_SLIDE_RE, `slide ${oneBased}`);
  return { text: next, usedFallback: !known };
}

// ── Color parsing ────────────────────────────────────────────────────────────

const NAMED_COLORS: Record<string, string> = {
  red: "#dc2626",
  crimson: "#dc143c",
  scarlet: "#e0341b",
  maroon: "#7f1d1d",
  orange: "#ea580c",
  tangerine: "#f97316",
  amber: "#f59e0b",
  yellow: "#eab308",
  gold: "#d4a017",
  lime: "#84cc16",
  green: "#16a34a",
  emerald: "#10b981",
  forest: "#166534",
  olive: "#6b8e23",
  mint: "#98e4c4",
  teal: "#0d9488",
  cyan: "#06b6d4",
  aqua: "#22d3ee",
  turquoise: "#14b8a6",
  sky: "#0ea5e9",
  azure: "#2f7ff0",
  blue: "#2563eb",
  navy: "#1e3a8a",
  indigo: "#4f46e5",
  violet: "#7c3aed",
  purple: "#9333ea",
  lavender: "#b6a3e8",
  magenta: "#d946ef",
  fuchsia: "#d946ef",
  pink: "#ec4899",
  rose: "#f43f5e",
  salmon: "#fa8072",
  coral: "#ff7f50",
  brown: "#92400e",
  tan: "#d2b48c",
  beige: "#f5f0dc",
  cream: "#fdf6e3",
  ivory: "#fffff0",
  white: "#ffffff",
  black: "#0b0f19",
  gray: "#6b7280",
  grey: "#6b7280",
  silver: "#c0c4cc",
  charcoal: "#26282e",
  slate: "#475569",
};

const COLOR_WORD_SOURCE = Object.keys(NAMED_COLORS).join("|");

function adjustLightness(hex: string, delta: number): string {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  const { l, c, h } = rgbToOklch(
    parseInt(m[1], 16),
    parseInt(m[2], 16),
    parseInt(m[3], 16)
  );
  return oklchToHex(Math.max(0.05, Math.min(0.97, l + delta)), c, h);
}

/**
 * Parse an explicit color from a request: hex, rgb(), or a named color with
 * an optional light/dark modifier. Returns null when no color is present.
 */
export function parseColorFromText(
  text: string
): { hex: string; label: string } | null {
  const hex = text.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
  if (hex) {
    let value = hex[0].toLowerCase();
    if (value.length === 4) {
      value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
    }
    return { hex: value, label: value };
  }

  const rgb = text.match(
    /\brgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i
  );
  if (rgb) {
    const to = (n: string) =>
      Math.max(0, Math.min(255, parseInt(n, 10)))
        .toString(16)
        .padStart(2, "0");
    const value = `#${to(rgb[1])}${to(rgb[2])}${to(rgb[3])}`;
    return { hex: value, label: value };
  }

  const named = text.match(
    new RegExp(
      `\\b(light|pale|soft|bright|dark|deep)?\\s*(${COLOR_WORD_SOURCE})\\b`,
      "i"
    )
  );
  if (!named) return null;
  const base = NAMED_COLORS[named[2].toLowerCase()];
  const modifier = (named[1] ?? "").toLowerCase();
  const label = `${modifier ? modifier + " " : ""}${named[2].toLowerCase()}`;
  if (modifier === "light" || modifier === "pale" || modifier === "soft") {
    return { hex: adjustLightness(base, 0.22), label };
  }
  if (modifier === "dark" || modifier === "deep") {
    return { hex: adjustLightness(base, -0.2), label };
  }
  if (modifier === "bright") {
    return { hex: adjustLightness(base, 0.08), label };
  }
  return { hex: base, label };
}

/** OKLCH lightness of a hex color (contrast decisions). */
export function hexLightness(hex: string): number {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return 0.5;
  return rgbToOklch(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16))
    .l;
}

// ── Scope parsing ────────────────────────────────────────────────────────────

const SLIDE_NUM_TOKEN =
  "(\\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|last)";

const DECK_SCOPE_RE =
  /\b(?:entire|whole|all(?:\s+(?:the|of\s+the))?|every|full|complete)\s+(?:slides?|deck|presentation|ppt|pptx|powerpoint)\b|\ball\s+slides\b|\bevery\s+slide\b/i;

/** Extract the slide/deck scope of a style command. Defaults to deck. */
export function parseScope(text: string): SlideScope {
  if (DECK_SCOPE_RE.test(text)) return { type: "deck" };

  const numbered =
    text.match(new RegExp(`\\bslide\\s+(?:number\\s+)?${SLIDE_NUM_TOKEN}\\b`, "i")) ??
    text.match(new RegExp(`\\b${SLIDE_NUM_TOKEN}\\s+slide\\b`, "i"));
  if (numbered) {
    const one = parseOneBasedSlideNumber(numbered[1]);
    if (one === -1) return { type: "last" };
    if (one != null) return { type: "slide", oneBased: one };
  }

  if (/\b(?:last|final|closing)\s+slide\b/i.test(text)) return { type: "last" };
  if (/\bfirst\s+slide\b/i.test(text)) return { type: "first" };

  // Bare "the background" / "the deck" with no slide reference → whole deck.
  return { type: "deck" };
}

// ── Style command matchers ───────────────────────────────────────────────────

const STYLE_VERB_RE =
  /\b(?:change|set|make|switch|use|apply|update|turn|paint|colou?r)\b/i;

const BACKGROUND_NOUN_RE = /\b(?:background|backdrop|bg)\b/i;

const TEXT_COLOR_RE =
  /\b(?:text|font|title|heading|word|letter)s?['’]?s?\s*colou?rs?\b|\bcolou?rs?\s+of\s+(?:the\s+)?(?:text|font|titles?|headings?|words?)\b/i;

const FONT_RE = /\bfonts?\b|\btypeface\b|\btypography\b/i;

const LAYOUT_RE = /\blayout\b|\barrangement\b/i;

const LAYOUT_NAMES: { match: RegExp; layout: string }[] = [
  { match: /\btwo[\s-]?columns?\b|\b2\s*columns?\b/i, layout: "TWO_COLUMN" },
  { match: /\bimage[\s-]?(?:on\s+the\s+)?left\b/i, layout: "IMAGE_LEFT" },
  { match: /\bcards?\b|\bgrid\b|\btiles?\b/i, layout: "CARDS" },
  { match: /\bquote\b/i, layout: "QUOTE" },
  { match: /\bstats?\b|\bstatistics?\b|\bnumbers?\b|\bmetrics?\b/i, layout: "STAT" },
  { match: /\bcomparison\b|\bversus\b|\bvs\.?\b/i, layout: "COMPARISON" },
  { match: /\bcenter(?:ed)?\b/i, layout: "CENTERED" },
  { match: /\bsection\b|\bdivider\b/i, layout: "SECTION" },
  { match: /\bbullets?\b|\blist\b/i, layout: "BULLET" },
  { match: /\btitle\b|\bhero\b/i, layout: "TITLE" },
];

export function parseLayoutName(text: string): string | null {
  for (const entry of LAYOUT_NAMES) {
    if (entry.match.test(text)) return entry.layout;
  }
  return null;
}

const REFORMAT_TO_BULLETS_RE =
  /\b(?:format|reformat|convert|turn|change|make|switch|rewrite)\b[\s\S]{0,80}\b(?:to|into|as|in)\s+(?:short\s+)?(?:bullet(?:\s*points?)?s?|a\s+(?:bulleted\s+)?list|list\s+form)\b/i;

const REFORMAT_TO_PARAGRAPH_RE =
  /\b(?:format|reformat|convert|turn|change|make|switch|rewrite)\b[\s\S]{0,80}\b(?:to|into|as|in)\s+(?:a\s+|an\s+)?(?:paragraphs?|descriptions?|prose|sentences?|narrative|flowing\s+text)\b/i;

const CONTENT_NOUN_RE = /\b(?:contents?|body|text|copy|bullets?|points?|slide)\b/i;

/** Known presentation-friendly fonts (bundled themes + common web-safe). */
const KNOWN_FONTS = [
  "Outfit",
  "Plus Jakarta Sans",
  "Inter",
  "Poppins",
  "Montserrat",
  "Roboto",
  "Open Sans",
  "Lato",
  "Raleway",
  "Nunito",
  "Merriweather",
  "Playfair Display",
  "Source Sans Pro",
  "Work Sans",
  "DM Sans",
  "Space Grotesk",
  "Georgia",
  "Garamond",
  "Times New Roman",
  "Arial",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Courier New",
  "Comic Sans MS",
  "Impact",
  "Segoe UI",
  "Calibri",
  "Cambria",
  "Futura",
  "Baskerville",
  "Palatino",
];

export function parseFontFromText(text: string): string | null {
  // Known fonts anywhere in the request win (multi-word safe).
  for (const font of KNOWN_FONTS) {
    if (new RegExp(`\\b${font.replace(/\s+/g, "\\s+")}\\b`, "i").test(text)) {
      return font;
    }
  }
  // "change the font to X" — accept an unknown capitalized name.
  const m = text.match(
    /\bfont\s+(?:to|into|:)\s*["']?([A-Za-z][A-Za-z0-9\- ]{1,32}?)["']?\s*(?:$|[.,!?]|\s+(?:please|for|on|in)\b)/i
  );
  if (m?.[1]) {
    const name = m[1].trim().replace(/\s+/g, " ");
    if (
      name.length >= 3 &&
      !/^(?:something|anything|a|an|the|it|this|that|different|better|nicer|modern)$/i.test(
        name
      )
    ) {
      return name
        .split(" ")
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" ");
    }
  }
  return null;
}

// ── Single-command parser ────────────────────────────────────────────────────

function parseSingleCommand(text: string): PresentationEditCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Structural intents first (mirrors the current router priority).
  if (isPresentationSlideRemoveRequest(trimmed)) {
    return { kind: "remove_slide", raw: trimmed };
  }
  if (isPresentationSlideImageChangeRequest(trimmed)) {
    return { kind: "change_image", raw: trimmed };
  }
  if (isPresentationSlideAddRequest(trimmed)) {
    return { kind: "add_slide", raw: trimmed };
  }
  if (isPresentationSlideMoveRequest(trimmed)) {
    return { kind: "move_slide", raw: trimmed };
  }
  if (isPresentationSlideExpandRequest(trimmed)) {
    return { kind: "expand_content", raw: trimmed };
  }

  // Text color before background ("text color" must not read as bg change).
  if (TEXT_COLOR_RE.test(trimmed)) {
    const color = parseColorFromText(
      // Avoid picking up "text" tokens as color words by scanning whole text.
      trimmed
    );
    if (color) {
      return {
        kind: "set_text_color",
        scope: parseScope(trimmed),
        color: color.hex,
        colorLabel: color.label,
      };
    }
  }

  if (BACKGROUND_NOUN_RE.test(trimmed) && STYLE_VERB_RE.test(trimmed)) {
    const color = parseColorFromText(trimmed);
    if (color) {
      return {
        kind: "set_background",
        scope: parseScope(trimmed),
        color: color.hex,
        colorLabel: color.label,
      };
    }
  }

  if (FONT_RE.test(trimmed) && !TEXT_COLOR_RE.test(trimmed)) {
    const font = parseFontFromText(trimmed);
    if (font) {
      return { kind: "set_font", font };
    }
  }

  if (LAYOUT_RE.test(trimmed)) {
    const layout = parseLayoutName(
      // Strip the word "layout" itself so "list layout" still maps cleanly.
      trimmed
    );
    if (layout) {
      return { kind: "set_layout", scope: parseScope(trimmed), layout };
    }
    // "change the layout of this slide" without a named layout → planner picks.
    return null;
  }

  if (CONTENT_NOUN_RE.test(trimmed)) {
    if (REFORMAT_TO_BULLETS_RE.test(trimmed)) {
      return {
        kind: "reformat_content",
        scope: parseScope(trimmed),
        style: "bullets",
      };
    }
    if (REFORMAT_TO_PARAGRAPH_RE.test(trimmed)) {
      return {
        kind: "reformat_content",
        scope: parseScope(trimmed),
        style: "paragraph",
      };
    }
  }

  // Generic theme / palette / contrast asks (after the specific style ops).
  if (isPresentationThemeStyleRequest(trimmed)) {
    return { kind: "set_theme", prompt: trimmed };
  }

  return null;
}

// ── Compound parsing ─────────────────────────────────────────────────────────

const CLAUSE_SPLIT_RE = /\s*(?:;|,\s+(?:and\s+)?|\s+and\s+(?:then\s+|also\s+)?)\s*/i;

function splitClauses(text: string): string[] {
  // Never split inside quoted spans (slide titles with commas).
  if (/["'][^"']*[,;][^"']*["']/.test(text)) return [text];
  return text
    .split(CLAUSE_SPLIT_RE)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Deterministic parse of an edit request into structured commands.
 * When part of the request can't be parsed, `residual` carries the full text
 * so the LLM planner takes over (the planner re-plans the whole request to
 * keep op ordering coherent).
 */
export function parseEditCommands(text: string): ParsedEditCommands {
  const trimmed = text.trim();
  if (!trimmed) return { commands: [], residual: "" };

  // Compound requests first — whole-text matching would silently drop the
  // second half of "make the background orange and the font Georgia".
  const clauses = splitClauses(trimmed);
  if (clauses.length > 1) {
    const commands: PresentationEditCommand[] = [];
    let allParsed = true;
    for (const clause of clauses) {
      const cmd = parseSingleCommand(clause);
      if (!cmd) {
        allParsed = false;
        break;
      }
      commands.push(cmd);
    }
    if (allParsed && commands.length > 1) {
      return { commands, residual: "" };
    }
  }

  const whole = parseSingleCommand(trimmed);
  if (whole) return { commands: [whole], residual: "" };

  return { commands: [], residual: trimmed };
}
