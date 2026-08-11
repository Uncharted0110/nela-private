/**
 * Artifact edit routing — detect when the user wants to modify an existing
 * HTML deck/page, spreadsheet, or presentation rather than create a new one.
 */

import type { ChatSession } from "../types";

export type ArtifactEditKind = "html" | "spreadsheet" | "presentation" | "presentation_deck";

/** Max characters of HTML sent to the diff-patch model (keeps RAM/context lean). */
export const MAX_PATCH_SOURCE_CHARS = 96_000;

/** Max data rows loaded into a spreadsheet edit plan. */
export const MAX_EDIT_SPREADSHEET_ROWS = 800;

/** Sample rows shown in the edit prompt (full data stays in source_rows). */
export const MAX_EDIT_SAMPLE_ROWS = 35;

const EDIT_VERBS =
  /\b(edit|modify|update|change|revise|fix|adjust|tweak|improve|enhance|refine|rewrite|reformat|add|remove|delete|insert|replace|shorten|expand|increase|enrich|polish|correct|amend|patch)\b/i;

/** Strong signal the user wants a brand-new artifact, not an edit. */
const STRONG_CREATE_ONLY =
  /\b(create|make|build|generate|synthesize|from scratch|brand new|new presentation|new spreadsheet|new workbook|new excel(?:\s+sheet)?|new (?:csv\s+)?sheet|new deck|new html(?:\s+page)?)\b/i;

/**
 * Explicit reference to an existing artifact.
 * Deliberately excludes bare "the sheet" / "the table" — those appear in create
 * prompts ("In the sheet have…") and were falsely routing generation → edit.
 */
const EDIT_FILE_HINT =
  /\b(this|my|that|current|existing|above|attached|open|same)\s+(file|deck|slide|spreadsheet|sheet|workbook|table|page|html|artifact|presentation|ppt|excel|xlsx)\b|\bthe\s+(existing|current|attached|open|same)\s+(file|deck|slide|spreadsheet|sheet|workbook|table|page|html|artifact|presentation|ppt|excel|xlsx)\b/i;

/** Create/generate a spreadsheet, deck, HTML page, etc. */
const CREATE_ARTIFACT_REQUEST =
  /\b(create|make|build|generate|synthesize|design|plan)\b[\s\S]{0,80}\b(excel|spreadsheet|workbook|xlsx|csv|sheet|presentation|deck|slides?|powerpoint|pptx|html\s+page|landing\s+page|webpage|web\s+page)\b|\b(excel|spreadsheet|workbook|presentation|deck)\b[\s\S]{0,40}\b(create|make|build|generate)\b/i;

/** Questions / explain prompts must never become artifact edits. */
const INFORMATION_SEEKING =
  /^(explain|why|how\s+(does|did|do|can|would|is|are)|what\s+(is|are|was|were|does|did)|who|when|where|tell\s+me|describe|summarize|can\s+you\s+explain|could\s+you\s+explain|please\s+explain)\b/i;

const STRUCTURAL_ARTIFACT_EDIT =
  /\b((add|remove|delete|insert|append|reorder|move)\b[\s\S]{0,40}\bslides?\b|\bslides?\b[\s\S]{0,40}\b(add|remove|delete|insert|append|reorder|move)\b|change\s+(the\s+)?theme|update\s+(the\s+)?theme|change\s+(the\s+)?title|add\s+(a\s+)?(column|row)|remove\s+(a\s+)?(column|row)|delete\s+(a\s+)?(column|row))\b/i;

/** Style / look tweaks that should edit an open deck without requiring "this presentation". */
const STYLE_ARTIFACT_EDIT =
  /\b(change|update|set|make|switch|use|apply|fix)\b[\s\S]{0,50}\b(font|fonts|typeface|typography|colou?rs?|accent|theme|background|palette|style|styling|contrast)\b|\b(darker|lighter|bluer|greener|more\s+minimal|more\s+corporate)\b|\b(font\s+to|colou?r\s+to|theme\s+to)\b|\b(text|font)s?\s+colou?rs?\b|\b(not visible|hard to read|unreadable)\b/i;

/** Explicit full-deck rewrite — fall back to regenerating the whole plan. */
const FULL_DECK_REWRITE =
  /\b(rewrite|regenerate|redo|restructure|overhaul|from\s+scratch|replace\s+all|rebuild)\b[\s\S]{0,40}\b(deck|presentation|slides?|ppt|pptx)\b|\b(rewrite|regenerate|redo|rebuild)\s+(the\s+)?(entire|whole|full)\b/i;

const EDITABLE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".xlsx",
  ".xls",
  ".ods",
  ".csv",
  ".tsv",
  ".pptx",
  ".ppt",
]);

export function artifactKindFromPath(path: string): ArtifactEditKind | null {
  const lower = path.toLowerCase();
  if (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    lower.endsWith(".ods") ||
    lower.endsWith(".csv") ||
    lower.endsWith(".tsv")
  ) {
    return "spreadsheet";
  }
  if (lower.endsWith(".pptx") || lower.endsWith(".ppt")) {
    return "presentation";
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "html";
  }
  return null;
}

export function isEditableArtifactPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return EDITABLE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Last assistant message with a live artifact path in this session. */
export function findSessionArtifactPath(session: ChatSession): string | null {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role === "assistant" && msg.artifactPath && msg.artifactStage === "LivePreview") {
      return msg.artifactPath;
    }
  }
  if (session.artifactPath && session.artifactStage === "LivePreview") {
    return session.artifactPath;
  }
  return null;
}

export function matchesArtifactEditIntent(
  prompt: string,
  options: {
    artifactPath?: string | null;
    attachedPaths?: string[];
  }
): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;

  if (INFORMATION_SEEKING.test(trimmed)) return false;

  const attachedEditable = (options.attachedPaths ?? []).filter(
    isEditableArtifactPath
  );
  const hasAttachedEditable = attachedEditable.length > 0;
  const hasSessionArtifact = !!(
    options.artifactPath && isEditableArtifactPath(options.artifactPath)
  );
  const hasEditableTarget = hasSessionArtifact || hasAttachedEditable;

  // Creating a new workbook/deck/page must not fall into edit routing.
  // Example failure: "create a new excel sheet… Add links… In the sheet have…"
  // matched EDIT_VERBS ("Add") + EDIT_FILE_HINT ("the sheet") with no target.
  if (STRONG_CREATE_ONLY.test(trimmed) || CREATE_ARTIFACT_REQUEST.test(trimmed)) {
    const explicitEditExisting =
      /\b(edit|modify|update|revise|fix|patch)\b/i.test(trimmed) &&
      (hasEditableTarget || EDIT_FILE_HINT.test(trimmed));
    if (!explicitEditExisting) return false;
  }

  if (!EDIT_VERBS.test(trimmed)) return false;

  if (!hasEditableTarget && !EDIT_FILE_HINT.test(trimmed)) return false;

  // Open session artifact alone is not enough — require an explicit "this deck"
  // style hint, an attached file, a structural edit, or a style tweak.
  if (hasSessionArtifact && !hasAttachedEditable) {
    if (
      !EDIT_FILE_HINT.test(trimmed) &&
      !STRUCTURAL_ARTIFACT_EDIT.test(trimmed) &&
      !STYLE_ARTIFACT_EDIT.test(trimmed)
    ) {
      return false;
    }
  }

  return true;
}

/** True when the user wants a full deck rewrite (not a surgical op list). */
export function isPresentationFullRewriteRequest(prompt: string): boolean {
  return FULL_DECK_REWRITE.test(prompt.trim());
}

/** Truncate large HTML for patch generation while preserving head/tail context. */
export function truncateForPatchEdit(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.62);
  const tail = Math.floor(maxChars * 0.33);
  const omitted = content.length - head - tail;
  return (
    content.slice(0, head) +
    `\n\n<!-- NELA: ${omitted} characters omitted for memory limits. ` +
    `Apply patches only to visible regions; keep changes minimal. -->\n\n` +
    content.slice(-tail)
  );
}

export function editedOutputName(originalPath: string): string {
  const base = originalPath.split(/[/\\]/).pop() ?? "artifact";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const cleaned = stem.replace(/[^a-zA-Z0-9._\- ]+/g, " ").trim().slice(0, 72);
  return cleaned ? `${cleaned}_edited` : "nela_artifact_edited";
}

export function buildSpreadsheetEditSample(
  headers: string[],
  rows: string[][],
  sampleRows = MAX_EDIT_SAMPLE_ROWS
): string {
  const headerLine = headers.join(" | ");
  const sample = rows
    .slice(0, sampleRows)
    .map((row) => row.map((c) => c.trim()).join(" | "))
    .join("\n");
  const more =
    rows.length > sampleRows
      ? `\n… (${rows.length - sampleRows} more data rows — full data is attached to the plan, not repeated here)`
      : "";
  return `Columns: [${headers.join(", ")}]\nRow count: ${rows.length}\nSample rows:\n${headerLine}\n${sample}${more}`;
}

/** NELA slide decks are HTML files with a recognizable deck shell. */
export function isNelaPresentationDeckHtml(content: string): boolean {
  return (
    content.includes("deck-container") &&
    content.includes("slide-stage") &&
    content.includes('class="slide')
  );
}

const ADD_SLIDE_REQUEST =
  /\b(add|insert|append)\b[\s\S]{0,80}\b(slide|slides)\b|\b(at the (end|last|start|beginning|first)|to the (end|last|start|beginning|first)|starting\s+slide|opening\s+slide)\b[\s\S]{0,40}\b(slide|slides)?\b/i;

/** "add a pic/image/photo …" — image op, not a new slide. */
const ADD_IMAGE_NOUN =
  /\b(add|put|include)\s+(a\s+|an\s+|the\s+)?(images?|photos?|pictures?|pics?|imgs?|photographs?)\b/i;

const REMOVE_SLIDE_REQUEST =
  /\b(remove|delete)\b[\s\S]{0,100}\bslides?\b|\bslides?\b[\s\S]{0,40}\b(remove|delete)\b/i;

const COMPLEX_DECK_REWRITE =
  /\b(rewrite|replace all|restructure|swap all slides)\b/i;

const MOVE_SLIDE_REQUEST =
  /\b(move|shift|relocate)\b[\s\S]{0,60}\bslides?\b|\bslides?\b[\s\S]{0,40}\b(move|shift|relocate)\b|\b(swap)\b[\s\S]{0,40}\bslides?\b/i;

/** User wants to append one or more slides (not a full deck rewrite). */
export function isPresentationSlideAddRequest(prompt: string): boolean {
  if (COMPLEX_DECK_REWRITE.test(prompt)) return false;
  if (MOVE_SLIDE_REQUEST.test(prompt)) return false;
  if (REMOVE_SLIDE_REQUEST.test(prompt)) return false;
  // "add a pic to slide 1" must not create a new slide.
  if (ADD_IMAGE_NOUN.test(prompt)) return false;
  return ADD_SLIDE_REQUEST.test(prompt);
}

/** User wants to remove/delete a slide (not a full deck rewrite). */
export function isPresentationSlideRemoveRequest(prompt: string): boolean {
  if (COMPLEX_DECK_REWRITE.test(prompt)) return false;
  if (MOVE_SLIDE_REQUEST.test(prompt)) return false;
  return REMOVE_SLIDE_REQUEST.test(prompt.trim());
}

/** User wants to move/reorder a slide (deterministic — no LLM). */
export function isPresentationSlideMoveRequest(prompt: string): boolean {
  if (COMPLEX_DECK_REWRITE.test(prompt)) return false;
  if (isPresentationSlideAddRequest(prompt)) return false;
  if (REMOVE_SLIDE_REQUEST.test(prompt.trim())) return false;
  return MOVE_SLIDE_REQUEST.test(prompt.trim());
}

const EXPAND_SLIDE_REQUEST =
  /\b(increase|expand|enrich|lengthen|grow|fatten|extend)\b[\s\S]{0,50}\b(contents?|body|texts?|copy|bullets?|details?)\b|\b(more|extra|additional)\s+(contents?|details?|texts?|bullets?|copy)\b|\b(add|put)\s+more\s+(contents?|details?|texts?|bullets?|copy)\b/i;

const IMAGE_NOUN = "images?|photos?|pictures?|pics?|imgs?|photographs?";

const IMAGE_SLIDE_REQUEST = new RegExp(
  [
    // change/replace the image|pic|…
    `\\b(change|replace|swap|update|refresh|new)\\b[\\s\\S]{0,50}\\b(${IMAGE_NOUN})\\b`,
    // image|pic … change/replace
    `\\b(${IMAGE_NOUN})\\b[\\s\\S]{0,50}\\b(change|replace|swap|update|refresh)\\b`,
    // add/put a pic|image of X (on an existing slide)
    `\\b(add|put|include)\\s+(a\\s+|an\\s+|the\\s+)?(${IMAGE_NOUN})\\b`,
  ].join("|"),
  "i"
);

/** User wants richer copy on an existing slide (deterministic web enrich). */
export function isPresentationSlideExpandRequest(prompt: string): boolean {
  if (COMPLEX_DECK_REWRITE.test(prompt)) return false;
  if (isPresentationSlideAddRequest(prompt)) return false;
  if (isPresentationSlideRemoveRequest(prompt)) return false;
  if (isPresentationSlideMoveRequest(prompt)) return false;
  if (isPresentationSlideImageChangeRequest(prompt)) return false;
  const trimmed = prompt.trim();
  if (!EXPAND_SLIDE_REQUEST.test(trimmed)) return false;
  // Prefer an explicit slide target (number / last / titled).
  return (
    /\bslides?\b/i.test(trimmed) ||
    /\b(last|final|this|current)\b/i.test(trimmed)
  );
}

/** User wants to change/replace the image on a slide (deterministic web fetch). */
export function isPresentationSlideImageChangeRequest(prompt: string): boolean {
  if (COMPLEX_DECK_REWRITE.test(prompt)) return false;
  if (isPresentationSlideRemoveRequest(prompt)) return false;
  if (isPresentationSlideMoveRequest(prompt)) return false;
  // Prefer image ops over "add slide" when the noun is an image/pic.
  if (isPresentationSlideAddRequest(prompt) && !ADD_IMAGE_NOUN.test(prompt)) {
    return false;
  }
  const trimmed = prompt.trim();
  if (!IMAGE_SLIDE_REQUEST.test(trimmed)) return false;
  return (
    /\bslides?\b/i.test(trimmed) ||
    /\b(last|final|this|current|first)\b/i.test(trimmed) ||
    EDIT_FILE_HINT.test(trimmed)
  );
}

/**
 * Optional topic after "to …" / "with …" / "of …" for image replacement.
 * e.g. "change the image on slide 1 to Park Güell" → "Park Güell"
 * e.g. "add a pic of Messi" → "Messi"
 */
export function parseSlideImageChangeTopic(prompt: string): string | null {
  const cleanTopic = (raw: string): string | null => {
    const topic = raw
      .replace(/\s+(?:on|in|to|for)\s+slides?\s+\d+\b.*$/i, "")
      .replace(/\b(please|thanks|thank you)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (topic.length < 2) return null;
    if (
      /^(slide|image|photo|picture|pic|img|it|this|that)\b/i.test(topic)
    ) {
      return null;
    }
    return topic;
  };

  const ofMatch = prompt.match(
    /\b(?:images?|photos?|pictures?|pics?|imgs?)\s+of\s+["']?([^"'.\n]{2,80})/i
  );
  if (ofMatch?.[1]) {
    const topic = cleanTopic(ofMatch[1]);
    if (topic) return topic;
  }

  const withoutSlideTail = prompt
    .replace(/\s+(?:on|in|to|for)\s+slides?\s+\d+\s*$/i, "")
    .replace(/\s+slides?\s+\d+\s*$/i, "")
    .trim();
  const m = withoutSlideTail.match(
    /\b(?:to|with|of|showing|about|for)\s+["']?([^"'.\n]{2,80})["']?\s*$/i
  );
  if (!m?.[1]) return null;
  return cleanTopic(m[1]);
}

/**
 * Which slide to expand. Prefer numbered ("slide 9"), then last, then title match.
 */
export function parseSlideExpandIndex(
  prompt: string,
  slideCount: number,
  slideTitles: string[] = []
): SlideInsertPosition | null {
  if (slideCount < 1) return null;
  const lower = prompt.toLowerCase();

  const numbered = lower.match(
    new RegExp(
      `\\b(?:slide\\s+)?(?:number\\s+)?${SLIDE_NUM_TOKEN}\\b(?:\\s+slide)?`
    )
  );
  // Prefer "slide 9" / "9th slide" near expand verbs — scan all matches.
  const allNums = [
    ...lower.matchAll(
      new RegExp(`\\bslide\\s+${SLIDE_NUM_TOKEN}\\b`, "g")
    ),
    ...lower.matchAll(
      new RegExp(`\\b${SLIDE_NUM_TOKEN}\\s+slide\\b`, "g")
    ),
  ];
  for (const m of allNums) {
    const one = parseOneBasedSlideNumber(m[1]);
    const n = one == null ? null : resolveOneBased(one, slideCount);
    if (n != null) {
      return { index: n - 1, label: `slide ${n}` };
    }
  }
  if (numbered && !allNums.length) {
    const one = parseOneBasedSlideNumber(numbered[1]);
    const n = one == null ? null : resolveOneBased(one, slideCount);
    if (n != null) return { index: n - 1, label: `slide ${n}` };
  }

  if (/\b(last|final|end)\b/.test(lower)) {
    return { index: slideCount - 1, label: "the last slide" };
  }

  const about = lower.match(
    /\b(?:about|titled|called|named)\s+[""']?([^""'\n,.]+?)[""']?(?:\s|$)/i
  );
  if (about) {
    const needle = about[1].trim().toLowerCase();
    const idx = slideTitles.findIndex((t) => {
      const title = t.trim().toLowerCase();
      return title === needle || title.includes(needle) || needle.includes(title);
    });
    if (idx >= 0) {
      return { index: idx, label: `“${slideTitles[idx] || needle}”` };
    }
  }

  return null;
}

const WORD_ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  last: -1,
};

const SLIDE_NUM_TOKEN =
  "(\\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|last)";

/** Parse "3", "3rd", "third" → 1-based slide number. `last` → -1. */
export function parseOneBasedSlideNumber(token: string): number | null {
  const t = token.trim().toLowerCase();
  if (t in WORD_ORDINALS) return WORD_ORDINALS[t];
  const m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function resolveOneBased(
  oneBased: number,
  slideCount: number
): number | null {
  if (slideCount < 1) return null;
  if (oneBased === -1) return slideCount;
  if (oneBased < 1 || oneBased > slideCount) return null;
  return oneBased;
}

/**
 * Resolve which slide to remove. Prefer title match ("thank you"), then
 * last/end, then numbered slide. Returns null if no clear target.
 */
export function parseSlideRemoveIndex(
  prompt: string,
  slideCount: number,
  slideTitles: string[] = []
): SlideInsertPosition | null {
  if (slideCount < 1) return null;
  const lower = prompt.toLowerCase();

  const named =
    lower.match(
      /\b(?:remove|delete)\s+(?:the\s+)?(?:slide\s+)?(?:about|titled|called|named|saying)?\s*[""']?([^""'\n,.]+?)[""']?\s+(?:slide\b|at the\b|from\b|$)/i
    ) ??
    lower.match(/\b(?:thank\s*you|thanks)\b/i);
  if (named) {
    const needle = (named[1] ?? named[0]).replace(/\s+slide$/i, "").trim().toLowerCase();
    if (needle) {
      const idx = slideTitles.findIndex((t) => {
        const title = t.trim().toLowerCase();
        return title === needle || title.includes(needle) || needle.includes(title);
      });
      if (idx >= 0) {
        return { index: idx, label: `“${slideTitles[idx] || needle}”` };
      }
      // "thank you" with no title parse — still treat as last-slide thank-you convention
      if (/thank\s*you|thanks/.test(needle) && slideCount > 0) {
        const thankIdx = slideTitles.findIndex((t) => /thank\s*you|thanks/i.test(t));
        if (thankIdx >= 0) {
          return { index: thankIdx, label: `“${slideTitles[thankIdx]}”` };
        }
      }
    }
  }

  if (/\b(last|end|final|closing)\b/.test(lower)) {
    return { index: slideCount - 1, label: "the last slide" };
  }

  const num = lower.match(/\b(?:slide\s+)?(?:number\s+)?(\d{1,2})\b/);
  if (num) {
    const n = parseInt(num[1], 10);
    const index = Math.max(0, Math.min(slideCount - 1, n - 1));
    return { index, label: `slide ${n}` };
  }

  if (/\bfirst\b/.test(lower)) {
    return { index: 0, label: "the first slide" };
  }

  return null;
}

/** True when a surgical op-list edit is preferable over full plan regen. */
export function prefersSurgicalPresentationEdit(prompt: string): boolean {
  if (isPresentationFullRewriteRequest(prompt)) return false;
  const trimmed = prompt.trim();
  return (
    STYLE_ARTIFACT_EDIT.test(trimmed) ||
    STRUCTURAL_ARTIFACT_EDIT.test(trimmed) ||
    isPresentationSlideAddRequest(trimmed) ||
    isPresentationSlideRemoveRequest(trimmed) ||
    EDIT_VERBS.test(trimmed)
  );
}

const THEME_STYLE_TOKENS =
  /\b(theme|background|palette|colours?|colors?|gradient|font|fonts|typeface|typography|accent|styling|style)\b/i;

/**
 * Theme / color / font look changes that can run without a local model.
 * Excludes slide add/remove and full rewrites.
 */
export function isPresentationThemeStyleRequest(prompt: string): boolean {
  if (isPresentationFullRewriteRequest(prompt)) return false;
  if (isPresentationSlideAddRequest(prompt)) return false;
  if (isPresentationSlideRemoveRequest(prompt)) return false;
  if (isPresentationSlideMoveRequest(prompt)) return false;
  if (isPresentationSlideExpandRequest(prompt)) return false;
  if (isPresentationSlideImageChangeRequest(prompt)) return false;
  const trimmed = prompt.trim();
  // STYLE_ARTIFACT_EDIT already includes make/switch/use/apply/set — those are
  // not in EDIT_VERBS (to avoid treating "make a new deck" as an edit verb alone).
  if (STYLE_ARTIFACT_EDIT.test(trimmed)) return true;
  if (!EDIT_VERBS.test(trimmed)) return false;
  return THEME_STYLE_TOKENS.test(trimmed);
}

export type SlideMovePosition = {
  /** 0-based source index. */
  from: number;
  /** 0-based destination index (final position). */
  to: number;
  label: string;
};

/**
 * Parse "move slide 9 to slide 4" / "move the 9th slide to the 4th".
 * Returns null when the request is not a clear single-slide move.
 */
export function parseSlideMove(
  prompt: string,
  slideCount: number,
  slideTitles: string[] = []
): SlideMovePosition | null {
  if (slideCount < 2) return null;
  const lower = prompt.toLowerCase();

  const numbered = lower.match(
    new RegExp(
      `\\b(?:move|shift|relocate)\\s+(?:the\\s+)?(?:slide\\s+)?${SLIDE_NUM_TOKEN}\\s+(?:to|into)\\s+(?:the\\s+)?(?:slide\\s+)?(?:position\\s+)?${SLIDE_NUM_TOKEN}\\b`
    )
  );
  if (numbered) {
    const fromOne = parseOneBasedSlideNumber(numbered[1]);
    const toOne = parseOneBasedSlideNumber(numbered[2]);
    if (fromOne == null || toOne == null) return null;
    const fromN = resolveOneBased(fromOne, slideCount);
    const toN = resolveOneBased(toOne, slideCount);
    if (fromN == null || toN == null) return null;
    return {
      from: fromN - 1,
      to: toN - 1,
      label: `slide ${fromN} → slide ${toN}`,
    };
  }

  // "move Camp Nou to slide 4"
  const named = lower.match(
    new RegExp(
      `\\b(?:move|shift|relocate)\\s+(?:the\\s+)?(?:slide\\s+)?(?:about\\s+|titled\\s+|called\\s+|named\\s+)?[""']?([^""'\\n]+?)[""']?\\s+(?:to|into)\\s+(?:the\\s+)?(?:slide\\s+)?(?:position\\s+)?${SLIDE_NUM_TOKEN}\\b`
    )
  );
  if (named) {
    const needle = named[1].replace(/\s+slide$/i, "").trim().toLowerCase();
    const toOne = parseOneBasedSlideNumber(named[2]);
    if (!needle || toOne == null) return null;
    const toN = resolveOneBased(toOne, slideCount);
    if (toN == null) return null;
    const from = slideTitles.findIndex((t) => {
      const title = t.trim().toLowerCase();
      return title === needle || title.includes(needle) || needle.includes(title);
    });
    if (from < 0) return null;
    return {
      from,
      to: toN - 1,
      label: `“${slideTitles[from] || needle}” → slide ${toN}`,
    };
  }

  return null;
}

export type SlideInsertPosition = {
  /** Zero-based insert index (0 = beginning, slideCount = end). */
  index: number;
  /** Human-readable position for status messages. */
  label: string;
};

function stripOuterQuotes(text: string): string {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Resolve where a new slide should be inserted from natural language.
 * `slideCount` is the number of existing slides (insert index range: 0..slideCount).
 */
export function parseSlideInsertIndex(
  prompt: string,
  slideCount: number
): SlideInsertPosition {
  const lower = prompt.toLowerCase();

  // "before the last slide" / "before last" — must run before generic "last" → end.
  if (/\bbefore\s+(the\s+)?last\b/.test(lower)) {
    const index = Math.max(0, slideCount - 1);
    return { index, label: "before the last slide" };
  }
  if (/\bafter\s+(the\s+)?last\b/.test(lower)) {
    return { index: slideCount, label: "after the last slide" };
  }
  if (/\bafter\s+(the\s+)?first\b/.test(lower)) {
    const index = Math.min(1, slideCount);
    return { index, label: "after the first slide" };
  }
  if (/\bbefore\s+(the\s+)?first\b/.test(lower)) {
    return { index: 0, label: "before the first slide" };
  }

  const beforeNum = lower.match(
    new RegExp(`\\bbefore\\s+(?:the\\s+)?(?:slide\\s+)?${SLIDE_NUM_TOKEN}\\b`)
  );
  if (beforeNum) {
    const one = parseOneBasedSlideNumber(beforeNum[1]);
    if (one != null) {
      const n = one === -1 ? slideCount : one;
      const index = Math.max(0, Math.min(slideCount, n - 1));
      return { index, label: `before slide ${n}` };
    }
  }

  const afterNum = lower.match(
    new RegExp(`\\bafter\\s+(?:the\\s+)?(?:slide\\s+)?${SLIDE_NUM_TOKEN}\\b`)
  );
  if (afterNum) {
    const one = parseOneBasedSlideNumber(afterNum[1]);
    if (one != null) {
      const n = one === -1 ? slideCount : one;
      const index = Math.max(0, Math.min(slideCount, n));
      return { index, label: `after slide ${n}` };
    }
  }

  const between = lower.match(
    /\bbetween\s+(?:slide\s+)?(\d{1,2})\s+and\s+(?:slide\s+)?(\d{1,2})\b/
  );
  if (between) {
    const a = parseInt(between[1], 10);
    const index = Math.max(0, Math.min(slideCount, a));
    return {
      index,
      label: `between slides ${between[1]} and ${between[2]}`,
    };
  }

  const atNum =
    lower.match(/\b(?:at|as)\s+(?:slide\s+)?(?:position\s+)?(\d{1,2})\b/) ??
    lower.match(/\b(?:slide|position)\s+(?:number\s+)?(\d{1,2})\b/);
  if (
    atNum &&
    !/\bafter\b/.test(lower) &&
    !/\bbefore\b/.test(lower) &&
    !/\b(start|beginning|first|end|last)\b/.test(atNum[0])
  ) {
    const n = parseInt(atNum[1], 10);
    const index = Math.max(0, Math.min(slideCount, n - 1));
    return { index, label: `at slide ${n}` };
  }

  if (
    /\b(at the )?(start|beginning|first|front|opening|intro)\b/.test(lower) ||
    /\bstarting\s+slide\b/.test(lower) ||
    /\bopening\s+slide\b/.test(lower) ||
    /\bintro\s+slide\b/.test(lower)
  ) {
    return { index: 0, label: "at the beginning" };
  }

  if (
    /\b(at the )?(end|last|final|closing)\b/.test(lower) ||
    /\bappend\b/.test(lower) ||
    /\bthank\s*you\b/.test(lower)
  ) {
    return { index: slideCount, label: "at the end" };
  }

  return { index: slideCount, label: "at the end" };
}

function inferLayoutForNewSlide(
  title: string,
  insertIndex: number
): "CENTERED" | "TITLE" | "BULLET" {
  if (insertIndex === 0) return "TITLE";
  if (/thank\s*you/i.test(title)) return "CENTERED";
  if (/welcome/i.test(title)) return "TITLE";
  return "BULLET";
}

/** Parse title/bullets for a new slide from natural language. */
export function parseAddSlideFromPrompt(
  prompt: string,
  insertIndex = Number.MAX_SAFE_INTEGER
): {
  title: string;
  bullets: string[];
  layout: "CENTERED" | "TITLE" | "BULLET";
} {
  const quoted = prompt.match(/["']([^"']+)["']/);
  if (quoted) {
    const content = stripOuterQuotes(quoted[1]);
    if (content.includes(",")) {
      const [first, ...rest] = content.split(",").map((s) => s.trim()).filter(Boolean);
      const title = first || "New Slide";
      return {
        title,
        bullets: rest,
        layout: inferLayoutForNewSlide(title, insertIndex),
      };
    }
    return {
      title: content,
      bullets: [],
      layout: inferLayoutForNewSlide(content, insertIndex),
    };
  }

  const called = prompt.match(
    /\b(?:called|titled|named|saying|with)\s+(.+?)(?:\s+(?:at|before|after)\s+|\s*$|\.)/i
  );
  if (called) {
    let content = stripOuterQuotes(called[1].trim());
    content = content.replace(/\s+(?:at the|before|after)\s+.*$/i, "").trim();
    if (content.includes(",")) {
      const [first, ...rest] = content.split(",").map((s) => s.trim()).filter(Boolean);
      const title = first || "New Slide";
      return {
        title,
        bullets: rest,
        layout: inferLayoutForNewSlide(title, insertIndex),
      };
    }
    return {
      title: content,
      bullets: [],
      layout: inferLayoutForNewSlide(content, insertIndex),
    };
  }

  // "add a slide about Camp Nou before the last slide"
  const about = prompt.match(
    /\b(?:about|on|covering|featuring)\s+(.+?)(?:\s+(?:at|before|after|to the|in the)\s+|\s*$|\.)/i
  );
  if (about) {
    let content = stripOuterQuotes(about[1].trim());
    content = content
      .replace(/\s+(?:at the|before|after|to the)\s+.*$/i, "")
      .replace(/[,\/#!$%\^&\*;:{}=`~()?]+$/g, "")
      .trim();
    if (content) {
      return {
        title: content,
        bullets: [],
        layout: inferLayoutForNewSlide(content, insertIndex),
      };
    }
  }

  if (/thank\s*you/i.test(prompt)) {
    const bullets = /nela/i.test(prompt) ? ["Generated by NELA"] : [];
    return {
      title: "Thank You",
      bullets,
      layout: "CENTERED",
    };
  }

  return {
    title: "New Slide",
    bullets: [],
    layout: inferLayoutForNewSlide("New Slide", insertIndex),
  };
}
