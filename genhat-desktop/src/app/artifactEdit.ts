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
  /\b(edit|modify|update|change|revise|fix|adjust|tweak|improve|enhance|refine|rewrite|reformat|add|remove|delete|insert|replace|shorten|expand|polish|correct|amend|patch)\b/i;

const STRONG_CREATE_ONLY =
  /\b(create|make|build|generate|synthesize|from scratch|brand new|new presentation|new spreadsheet|new deck|new html page)\b/i;

const EDIT_FILE_HINT =
  /\b(this|the|my|that|current|existing|above|attached|open|same)\s+(file|deck|slide|spreadsheet|sheet|workbook|table|page|html|artifact|presentation|ppt|excel|xlsx)\b/i;

/** Questions / explain prompts must never become artifact edits. */
const INFORMATION_SEEKING =
  /^(explain|why|how\s+(does|did|do|can|would|is|are)|what\s+(is|are|was|were|does|did)|who|when|where|tell\s+me|describe|summarize|can\s+you\s+explain|could\s+you\s+explain|please\s+explain)\b/i;

const STRUCTURAL_ARTIFACT_EDIT =
  /\b((add|remove|delete|insert|append|reorder|move)\b[\s\S]{0,40}\bslides?\b|\bslides?\b[\s\S]{0,40}\b(add|remove|delete|insert|append|reorder|move)\b|change\s+(the\s+)?theme|update\s+(the\s+)?theme|change\s+(the\s+)?title|add\s+(a\s+)?(column|row)|remove\s+(a\s+)?(column|row)|delete\s+(a\s+)?(column|row))\b/i;

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

  if (!EDIT_VERBS.test(trimmed)) return false;

  const attachedEditable = (options.attachedPaths ?? []).filter(
    isEditableArtifactPath
  );
  const hasAttachedEditable = attachedEditable.length > 0;
  const hasSessionArtifact = !!(
    options.artifactPath && isEditableArtifactPath(options.artifactPath)
  );
  const hasEditableTarget = hasSessionArtifact || hasAttachedEditable;

  if (!hasEditableTarget && !EDIT_FILE_HINT.test(trimmed)) return false;

  // "Create a new deck" should stay on generation, not edit.
  if (STRONG_CREATE_ONLY.test(trimmed) && !EDIT_FILE_HINT.test(trimmed)) {
    return false;
  }

  // Open session artifact alone is not enough — require an explicit "this deck"
  // style hint, an attached file, or a clear structural edit request.
  if (hasSessionArtifact && !hasAttachedEditable) {
    if (
      !EDIT_FILE_HINT.test(trimmed) &&
      !STRUCTURAL_ARTIFACT_EDIT.test(trimmed)
    ) {
      return false;
    }
  }

  return true;
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

const COMPLEX_DECK_REWRITE =
  /\b(remove|delete|rewrite|replace all|restructure|reorder|move slide|swap slide)\b/i;

/** User wants to append one or more slides (not a full deck rewrite). */
export function isPresentationSlideAddRequest(prompt: string): boolean {
  if (COMPLEX_DECK_REWRITE.test(prompt)) return false;
  return ADD_SLIDE_REQUEST.test(prompt);
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

  const beforeNum = lower.match(/\bbefore\s+(?:slide\s+)?(\d{1,2})\b/);
  if (beforeNum) {
    const n = parseInt(beforeNum[1], 10);
    const index = Math.max(0, Math.min(slideCount, n - 1));
    return { index, label: `before slide ${n}` };
  }

  const afterNum = lower.match(/\bafter\s+(?:slide\s+)?(\d{1,2})\b/);
  if (afterNum) {
    const n = parseInt(afterNum[1], 10);
    const index = Math.max(0, Math.min(slideCount, n));
    return { index, label: `after slide ${n}` };
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
