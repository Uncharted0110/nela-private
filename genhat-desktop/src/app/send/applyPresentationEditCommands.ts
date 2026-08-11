/**
 * Hybrid presentation edit system — command executor.
 *
 * Takes structured `PresentationEditCommand`s (from the deterministic parser
 * or the LLM planner) and applies them to the open deck:
 * - NELA HTML decks / PPTX: batched Rust surgical ops (`applyPresentationOps`)
 *   plus a per-slide override style block for slide-scoped background/text.
 * - Freeform HTML decks: string/DOM transforms via freeformHtmlSlideEdit.
 * Structural commands (add/remove/move/expand/image/theme) delegate to the
 * existing deterministic runners so their web enrichment keeps working.
 */

import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import { useSessionStore } from "../../stores/sessionStore";
import {
  editedOutputName,
  isNelaPresentationDeckHtml,
} from "../artifactEdit";
import {
  countFreeformSlides,
  expandSlideInFreeformHtml,
  getFreeformSlideBlock,
  insertSlideIntoFreeformHtml,
  listFreeformSlideTitles,
  moveSlideInFreeformHtml,
  removeSlideFromFreeformHtml,
} from "./freeformHtmlSlideEdit";
import {
  describeScope,
  hexLightness,
  resolveScopeIndex,
  type PresentationEditCommand,
  type SlideScope,
} from "./presentationEditCommand";
import type { SendHandlerContext } from "./types";
import { friendlyErrorFromUnknown } from "../friendlyError";

export type UpdateEditMsg = (
  stage: PipelineStageKind,
  path?: string | null,
  contentOverride?: string
) => void;

// ── Per-slide override style block (shared format with Rust edit.rs) ─────────

export const SLIDE_OVERRIDES_ID = "nela-slide-overrides";

export type SlideOverride = { background?: string; text?: string };
export type SlideOverridesMap = Record<string, SlideOverride>;

function escapeAttr(json: string): string {
  return json
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function extractSlideOverrides(html: string): SlideOverridesMap {
  const m = html.match(
    new RegExp(
      `<style\\s+id="${SLIDE_OVERRIDES_ID}"\\s+data-nela-overrides="([^"]*)"`,
      "i"
    )
  );
  if (!m?.[1]) return {};
  try {
    const parsed = JSON.parse(unescapeAttr(m[1])) as SlideOverridesMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** CSS for one slide override (0-based index → :nth-child is 1-based). */
function slideOverrideCss(index: number, override: SlideOverride): string {
  const sel = `.slide-stage > .slide:nth-child(${index + 1})`;
  let css = "";
  if (override.background) {
    css +=
      `${sel} { background: ${override.background} !important; ` +
      `background-image: none !important; }\n` +
      `${sel}::before, ${sel}::after { background: none !important; }\n`;
  }
  if (override.text) {
    css +=
      `${sel}, ${sel} :is(h1,h2,h3,h4,h5,p,li,span,strong,em,blockquote,div) ` +
      `{ color: ${override.text} !important; ` +
      `-webkit-text-fill-color: ${override.text} !important; }\n`;
  }
  return css;
}

export function buildSlideOverridesBlock(map: SlideOverridesMap): string {
  const entries = Object.entries(map).filter(
    ([, v]) => v && (v.background || v.text)
  );
  if (!entries.length) return "";
  const json = escapeAttr(JSON.stringify(Object.fromEntries(entries)));
  const css = entries
    .map(([k, v]) => slideOverrideCss(parseInt(k, 10) || 0, v))
    .join("");
  return `<style id="${SLIDE_OVERRIDES_ID}" data-nela-overrides="${json}">\n${css}</style>\n`;
}

/** Merge new per-slide overrides into the deck HTML (idempotent block swap). */
export function upsertSlideOverridesInHtml(
  html: string,
  patch: SlideOverridesMap
): string {
  const merged: SlideOverridesMap = { ...extractSlideOverrides(html) };
  for (const [k, v] of Object.entries(patch)) {
    merged[k] = { ...merged[k], ...v };
  }

  let out = html;
  const blockRe = new RegExp(
    `<style\\s+id="${SLIDE_OVERRIDES_ID}"[\\s\\S]*?</style>\\n?`,
    "i"
  );
  out = out.replace(blockRe, "");

  const block = buildSlideOverridesBlock(merged);
  if (!block) return out;
  const headIdx = out.lastIndexOf("</head>");
  if (headIdx >= 0) {
    return out.slice(0, headIdx) + block + out.slice(headIdx);
  }
  const bodyIdx = out.lastIndexOf("</body>");
  if (bodyIdx >= 0) {
    return out.slice(0, bodyIdx) + block + out.slice(bodyIdx);
  }
  return out + block;
}

// ── Freeform deck-wide overrides (never re-rendered by Rust) ─────────────────

const DECK_OVERRIDES_ID = "nela-deck-overrides";

function upsertDeckOverridesInFreeformHtml(
  html: string,
  rules: { background?: string; text?: string; font?: string }
): string {
  const marker = new RegExp(
    `<style\\s+id="${DECK_OVERRIDES_ID}"[\\s\\S]*?</style>\\n?`,
    "i"
  );
  // Carry previous rules forward via data attribute.
  const prevMatch = html.match(
    new RegExp(`<style\\s+id="${DECK_OVERRIDES_ID}"\\s+data-nela-deck="([^"]*)"`, "i")
  );
  let prev: { background?: string; text?: string; font?: string } = {};
  if (prevMatch?.[1]) {
    try {
      prev = JSON.parse(unescapeAttr(prevMatch[1]));
    } catch {
      prev = {};
    }
  }
  const merged = { ...prev, ...rules };

  let css = "";
  if (merged.background) {
    css +=
      `body, .slide { background: ${merged.background} !important; ` +
      `background-image: none !important; }\n`;
  }
  if (merged.text) {
    css +=
      `.slide, .slide :is(h1,h2,h3,h4,h5,p,li,span,strong,em,blockquote,div) ` +
      `{ color: ${merged.text} !important; ` +
      `-webkit-text-fill-color: ${merged.text} !important; }\n`;
  }
  if (merged.font) {
    css +=
      `body, body :is(h1,h2,h3,h4,h5,p,li,span,strong,em,blockquote,div,button) ` +
      `{ font-family: '${merged.font}', system-ui, sans-serif !important; }\n`;
  }

  let out = html.replace(marker, "");
  if (!css) return out;
  const block = `<style id="${DECK_OVERRIDES_ID}" data-nela-deck="${escapeAttr(
    JSON.stringify(merged)
  )}">\n${css}</style>\n`;
  const headIdx = out.lastIndexOf("</head>");
  if (headIdx >= 0) return out.slice(0, headIdx) + block + out.slice(headIdx);
  const bodyIdx = out.lastIndexOf("</body>");
  if (bodyIdx >= 0) return out.slice(0, bodyIdx) + block + out.slice(bodyIdx);
  return out + block;
}

/** Append CSS to the inline style attribute of the Nth freeform slide. */
function setInlineStyleOnFreeformSlide(
  html: string,
  index: number,
  css: string
): string {
  const block = getFreeformSlideBlock(html, index);
  if (!block) throw new Error(`Slide ${index + 1} not found`);
  const openEnd = block.indexOf(">");
  if (openEnd < 0) throw new Error("Malformed slide tag");
  const openTag = block.slice(0, openEnd + 1);
  let nextOpen: string;
  const styleAttr = openTag.match(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/i);
  if (styleAttr) {
    const existing = styleAttr[2].trim().replace(/;?\s*$/, ";");
    nextOpen = openTag.replace(
      /\sstyle\s*=\s*(["'])[\s\S]*?\1/i,
      ` style="${existing} ${css}"`
    );
  } else {
    nextOpen = openTag.replace(/>$/, ` style="${css}">`);
  }
  const at = html.indexOf(block);
  if (at < 0) throw new Error("Slide block lookup failed");
  return html.slice(0, at) + nextOpen + html.slice(at + openTag.length);
}

// ── Reformat transforms ──────────────────────────────────────────────────────

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Merge bullets into 1–2 prose paragraphs. */
export function bulletsToParagraphs(items: string[]): string[] {
  const sentences = items
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => (/[.!?]$/.test(b) ? b : `${b}.`));
  if (!sentences.length) return [];
  const joined = sentences.join(" ");
  if (joined.length <= 420 || sentences.length < 4) return [joined];
  const mid = Math.ceil(sentences.length / 2);
  return [sentences.slice(0, mid).join(" "), sentences.slice(mid).join(" ")];
}

/** Split prose/long bullets into short bullet points. */
export function contentToBullets(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    for (const s of splitIntoSentences(item)) {
      const cleaned = s.replace(/^[•\-*–—]\s*/, "").replace(/\.$/, "").trim();
      if (cleaned.length >= 4 && !out.includes(cleaned)) out.push(cleaned);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function bulletsFromFreeformBlock(block: string): string[] {
  return [...block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 4);
}

function paragraphsFromFreeformBlock(block: string): string[] {
  return [...block.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)]
    .filter((m) => !/\bkicker\b/i.test(m[1]))
    .map((m) => m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 12);
}

// ── Delegated runners ────────────────────────────────────────────────────────

type DelegatedKind =
  | "add_slide"
  | "remove_slide"
  | "move_slide"
  | "expand_content"
  | "set_theme";

async function runDelegated(
  kind: DelegatedKind,
  raw: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  updateEditMsg: UpdateEditMsg
): Promise<boolean> {
  switch (kind) {
    case "add_slide": {
      const { runDeterministicSlideAdd } = await import("./runDeterministicSlideAdd");
      return runDeterministicSlideAdd(raw, artifactPath, sid, ctx, updateEditMsg);
    }
    case "remove_slide": {
      const { runDeterministicSlideRemove } = await import(
        "./runDeterministicSlideRemove"
      );
      return runDeterministicSlideRemove(raw, artifactPath, sid, ctx, updateEditMsg);
    }
    case "move_slide": {
      const { runDeterministicSlideMove } = await import("./runDeterministicSlideMove");
      return runDeterministicSlideMove(raw, artifactPath, sid, ctx, updateEditMsg);
    }
    case "expand_content": {
      const { runDeterministicSlideExpand } = await import(
        "./runDeterministicSlideExpand"
      );
      return runDeterministicSlideExpand(raw, artifactPath, sid, ctx, updateEditMsg);
    }
    case "set_theme": {
      const { runDeterministicThemeEdit } = await import("./runDeterministicThemeEdit");
      return runDeterministicThemeEdit(raw, artifactPath, sid, ctx, updateEditMsg);
    }
  }
}

/**
 * Fetch image candidates for a model-authored query, let the user pick one,
 * and write the updated HTML deck. Returns true when the request was handled
 * (including cancel / no candidates).
 */
async function applyChangeImageWithPicker(args: {
  artifactPath: string;
  sid: string;
  ctx: SendHandlerContext;
  updateEditMsg: UpdateEditMsg;
  oneBased: number;
  query: string;
}): Promise<boolean> {
  const { sid, ctx, updateEditMsg, oneBased, query } = args;
  const lower = args.artifactPath.toLowerCase();
  if (!lower.endsWith(".html") && !lower.endsWith(".htm")) {
    // Native PPTX image swap isn't supported here.
    return false;
  }

  let html: string;
  try {
    html = await Api.readFileText(args.artifactPath);
  } catch (err) {
    console.warn("Image-change read failed:", err);
    return false;
  }

  const slideCount = Math.max(
    countFreeformSlides(html),
    listFreeformSlideTitles(html).length
  );
  if (slideCount < 1) return false;
  const idx = Math.max(0, Math.min(slideCount - 1, oneBased - 1));
  const titles = listFreeformSlideTitles(html);
  const slideLabel = `slide ${idx + 1}${
    titles[idx]?.trim() ? ` (“${titles[idx].trim()}”)` : ""
  }`;

  const {
    fetchSlideImageCandidates,
    listDeckImageSources,
  } = await import("./slideImageCandidates");
  const { openImagePicker } = await import("../../stores/imagePickerStore");
  const {
    mergeCandidatesIntoDeckHtml,
    applyPickedCandidateToDeck,
    writeDeckHtmlCopy,
  } = await import("./applyDeckLibraryImage");

  updateEditMsg(
    "CrunchingMetrics",
    null,
    `Finding images for “${query}”…`
  );

  let candidates;
  try {
    candidates = await fetchSlideImageCandidates({
      query,
      count: 6,
      excludeSources: listDeckImageSources(html),
      onStatus: (msg) => updateEditMsg("CrunchingMetrics", null, msg),
    });
  } catch (err) {
    console.warn("Slide image candidate fetch failed:", err);
    candidates = [];
  }

  if (!candidates.length) {
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      `Couldn't find usable images for “${query}”. Try a more specific subject.`
    );
    return true;
  }

  // Persist all searched candidates into the in-deck library before picking.
  const merged = mergeCandidatesIntoDeckHtml(html, candidates);
  html = merged.html;

  updateEditMsg(
    "CrunchingMetrics",
    null,
    `Pick an image for ${slideLabel}…`
  );
  const pick = await openImagePicker({
    slideLabel,
    query,
    candidates,
  });

  if (!pick) {
    // Keep the library even when the user cancels the pick.
    try {
      const newPath = await writeDeckHtmlCopy({
        artifactPath: args.artifactPath,
        html,
        sid,
        ctx,
      });
      updateEditMsg(
        "LivePreview",
        newPath,
        `Kept the existing image on ${slideLabel}. New images are in the Images sidebar.`
      );
    } catch (err) {
      console.warn("Failed to persist image library on cancel:", err);
      ctx.updateSession(sid, { loading: false });
      updateEditMsg(
        "LivePreview",
        args.artifactPath,
        `Kept the existing image on ${slideLabel}.`
      );
    }
    return true;
  }

  updateEditMsg("WritingCode", null, `Updating image on ${slideLabel}…`);
  try {
    const newPath = await applyPickedCandidateToDeck({
      html,
      artifactPath: args.artifactPath,
      sid,
      ctx,
      slideIndex: idx,
      pick,
      entries: merged.entries,
    });
    const filename = newPath.split(/[/\\]/).pop();
    updateEditMsg(
      "LivePreview",
      newPath,
      `Updated the image on ${slideLabel} → **${filename}**`
    );
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      friendlyErrorFromUnknown(`Failed to change slide image: ${message}`)
    );
    return true;
  }
}

function freshArtifactPath(sid: string, fallback: string): string {
  const session = useSessionStore.getState().sessions.find((s) => s.id === sid);
  return session?.artifactPath || fallback;
}

// ── Main executor ────────────────────────────────────────────────────────────

const CONTRAST_DARK_TEXT = "#111827";
const CONTRAST_LIGHT_TEXT = "#f8fafc";

function contrastTextFor(bgHex: string): string {
  return hexLightness(bgHex) > 0.55 ? CONTRAST_DARK_TEXT : CONTRAST_LIGHT_TEXT;
}

function describeCommand(cmd: PresentationEditCommand): string {
  switch (cmd.kind) {
    case "set_background":
      return `background of ${describeScope(cmd.scope)} → ${cmd.colorLabel}`;
    case "set_text_color":
      return `text color of ${describeScope(cmd.scope)} → ${cmd.colorLabel}`;
    case "set_font":
      return `font → ${cmd.font}`;
    case "set_theme":
      return "theme";
    case "set_layout":
      return `layout of ${describeScope(cmd.scope)} → ${cmd.layout}`;
    case "reformat_content":
      return `${describeScope(cmd.scope)} → ${cmd.style}`;
    case "patch_content":
      return `rewrote slide ${cmd.oneBased}`;
    case "add_slide_spec":
      return `added “${cmd.title}”`;
    case "remove_slide_at":
      return `removed slide ${cmd.oneBased}`;
    case "move_slide_spec":
      return `moved slide ${cmd.fromOneBased} → ${cmd.toOneBased}`;
    default:
      return cmd.kind.replace(/_/g, " ");
  }
}

export async function applyPresentationEditCommands(args: {
  commands: PresentationEditCommand[];
  artifactPath: string;
  sid: string;
  ctx: SendHandlerContext;
  updateEditMsg: UpdateEditMsg;
}): Promise<boolean> {
  const { commands, sid, ctx, updateEditMsg } = args;
  if (!commands.length) return false;

  let currentPath = args.artifactPath;
  const lower = currentPath.toLowerCase();
  const isPptx = lower.endsWith(".pptx") || lower.endsWith(".ppt");
  const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");
  if (!isPptx && !isHtml) return false;

  const delegated: { kind: DelegatedKind; raw: string }[] = [];
  const imageCommands: Extract<PresentationEditCommand, { kind: "change_image" }>[] =
    [];
  const styleCommands: PresentationEditCommand[] = [];
  for (const cmd of commands) {
    if (cmd.kind === "change_image") {
      imageCommands.push(cmd);
    } else if (
      cmd.kind === "add_slide" ||
      cmd.kind === "remove_slide" ||
      cmd.kind === "move_slide" ||
      cmd.kind === "expand_content"
    ) {
      delegated.push({ kind: cmd.kind, raw: cmd.raw });
    } else if (cmd.kind === "set_theme") {
      delegated.push({ kind: "set_theme", raw: cmd.prompt });
    } else {
      styleCommands.push(cmd);
    }
  }

  // 1. Structural / theme commands via the existing deterministic runners.
  let delegatedRan = false;
  for (const d of delegated) {
    const handled = await runDelegated(
      d.kind,
      d.raw,
      currentPath,
      sid,
      ctx,
      updateEditMsg
    );
    if (!handled) {
      // Nothing applied yet → let the router fall back cleanly. If part of a
      // compound request already ran, stop here instead of double-applying.
      if (!delegatedRan) return false;
      updateEditMsg(
        "LivePreview",
        currentPath,
        "Applied part of the request — couldn't complete the rest automatically."
      );
      return true;
    }
    delegatedRan = true;
    currentPath = freshArtifactPath(sid, currentPath);
  }

  // 1b. Image swaps — planner-authored query goes through the picker; raw-only
  // falls back to the deterministic runner (regex path).
  for (const img of imageCommands) {
    let handled = false;
    if (img.oneBased != null && img.query?.trim()) {
      handled = await applyChangeImageWithPicker({
        artifactPath: currentPath,
        sid,
        ctx,
        updateEditMsg,
        oneBased: img.oneBased,
        query: img.query.trim(),
      });
    } else {
      const { runDeterministicSlideImageChange } = await import(
        "./runDeterministicSlideImageChange"
      );
      handled = await runDeterministicSlideImageChange(
        img.raw,
        currentPath,
        sid,
        ctx,
        updateEditMsg
      );
    }
    if (!handled) {
      if (!delegatedRan) return false;
      updateEditMsg(
        "LivePreview",
        currentPath,
        "Applied part of the request — couldn't complete the rest automatically."
      );
      return true;
    }
    delegatedRan = true;
    currentPath = freshArtifactPath(sid, currentPath);
  }

  if (!styleCommands.length) return delegatedRan || imageCommands.length > 0;

  // 2. Style / content commands.
  let html = "";
  let isNela = false;
  if (currentPath.toLowerCase().endsWith(".htm") || currentPath.toLowerCase().endsWith(".html")) {
    try {
      html = await Api.readFileText(currentPath);
    } catch (err) {
      console.warn("Edit executor read failed:", err);
      return false;
    }
    isNela = isNelaPresentationDeckHtml(html);
  }

  updateEditMsg("WritingCode", null, `Applying ${styleCommands.length} edit${styleCommands.length > 1 ? "s" : ""}…`);
  const outputName = editedOutputName(currentPath);
  const applied: string[] = [];

  try {
    if (isNela || isPptx) {
      const next = await applyNelaStyleCommands({
        styleCommands,
        currentPath,
        html,
        isPptx,
        outputName,
        applied,
      });
      currentPath = next;
    } else {
      const next = await applyFreeformStyleCommands({
        styleCommands,
        currentPath,
        html,
        outputName,
        applied,
        sid,
        ctx,
      });
      if (next === null) {
        // Unsupported on freeform HTML → fall back, unless part already ran.
        if (!delegatedRan) return false;
        updateEditMsg(
          "LivePreview",
          currentPath,
          "Applied part of the request — couldn't complete the rest automatically."
        );
        return true;
      }
      currentPath = next.path;
      ctx.updateSession(sid, { streamingArtifactHtml: next.html });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("Edit executor apply failed:", message);
    ctx.updateSession(sid, { loading: false });
    updateEditMsg("Error", null, friendlyErrorFromUnknown(`Edit failed: ${message}`));
    return true;
  }

  ctx.updateSession(sid, {
    loading: false,
    artifactPath: currentPath,
    artifactStage: "LivePreview",
    artifactPanelOpen: true,
  });
  const filename = currentPath.split(/[/\\]/).pop();
  updateEditMsg(
    "LivePreview",
    currentPath,
    `Applied: ${applied.join("; ")} → **${filename}** (original unchanged).`
  );
  return true;
}

// ── NELA / PPTX style application ────────────────────────────────────────────

async function applyNelaStyleCommands(args: {
  styleCommands: PresentationEditCommand[];
  currentPath: string;
  html: string;
  isPptx: boolean;
  outputName: string;
  applied: string[];
}): Promise<string> {
  const { styleCommands, isPptx, outputName, applied } = args;
  let { currentPath, html } = args;

  const parsed = await Api.parsePresentationDeck(currentPath);
  const slideCount = parsed.slideCount || parsed.slides?.length || 0;

  const overridesPatch: SlideOverridesMap = {};
  const rustOps: Record<string, unknown>[] = [];

  const resolveIndex = (scope: SlideScope): number | null =>
    resolveScopeIndex(scope, slideCount);

  for (const cmd of styleCommands) {
    switch (cmd.kind) {
      case "set_background": {
        const idx = cmd.scope.type === "deck" ? null : resolveIndex(cmd.scope);
        if (idx == null) {
          rustOps.push({
            op: "set_colors",
            background: cmd.color,
            text: contrastTextFor(cmd.color),
          });
        } else {
          overridesPatch[String(idx)] = {
            ...overridesPatch[String(idx)],
            background: cmd.color,
            // Keep the slide readable against its new background.
            ...(overridesPatch[String(idx)]?.text
              ? {}
              : { text: contrastTextFor(cmd.color) }),
          };
        }
        applied.push(describeCommand(cmd));
        break;
      }
      case "set_text_color": {
        const idx = cmd.scope.type === "deck" ? null : resolveIndex(cmd.scope);
        if (idx == null) {
          rustOps.push({ op: "set_colors", text: cmd.color });
        } else {
          overridesPatch[String(idx)] = {
            ...overridesPatch[String(idx)],
            text: cmd.color,
          };
        }
        applied.push(describeCommand(cmd));
        break;
      }
      case "set_font": {
        rustOps.push({ op: "set_font", heading: cmd.font, body: cmd.font });
        applied.push(describeCommand(cmd));
        break;
      }
      case "set_layout": {
        const idx = resolveIndex(cmd.scope);
        if (idx == null) {
          throw new Error(
            "Say which slide's layout to change — e.g. “change the layout of slide 2 to two columns”."
          );
        }
        rustOps.push({ op: "patch_slide", index: idx, layout: cmd.layout });
        applied.push(describeCommand(cmd));
        break;
      }
      case "reformat_content": {
        const targets =
          cmd.scope.type === "deck"
            ? parsed.slides.map((_, i) => i)
            : [resolveIndex(cmd.scope)].filter((i): i is number => i != null);
        for (const idx of targets) {
          const slide = parsed.slides[idx] as { bullets?: unknown };
          const bullets = Array.isArray(slide?.bullets)
            ? slide.bullets.map(String).filter(Boolean)
            : [];
          if (!bullets.length) continue;
          const nextBullets =
            cmd.style === "paragraph"
              ? bulletsToParagraphs(bullets)
              : contentToBullets(bullets);
          if (!nextBullets.length) continue;
          rustOps.push({ op: "patch_slide", index: idx, bullets: nextBullets });
        }
        applied.push(describeCommand(cmd));
        break;
      }
      case "patch_content": {
        const idx = Math.max(0, Math.min(slideCount - 1, cmd.oneBased - 1));
        rustOps.push({
          op: "patch_slide",
          index: idx,
          ...(cmd.title ? { title: cmd.title } : {}),
          ...(cmd.bullets?.length ? { bullets: cmd.bullets } : {}),
          ...(cmd.layout ? { layout: cmd.layout } : {}),
        });
        applied.push(describeCommand(cmd));
        break;
      }
      case "add_slide_spec": {
        rustOps.push({
          op: "insert_slide",
          index: cmd.insertIndex ?? slideCount,
          title: cmd.title,
          layout: cmd.layout ?? "BULLET",
          bullets: cmd.bullets,
        });
        applied.push(describeCommand(cmd));
        break;
      }
      case "remove_slide_at": {
        const idx = Math.max(0, Math.min(slideCount - 1, cmd.oneBased - 1));
        rustOps.push({ op: "remove_slide", index: idx });
        applied.push(describeCommand(cmd));
        break;
      }
      case "move_slide_spec": {
        rustOps.push({
          op: "move_slide",
          from: Math.max(0, cmd.fromOneBased - 1),
          to: Math.max(0, cmd.toOneBased - 1),
        });
        applied.push(describeCommand(cmd));
        break;
      }
      default:
        break;
    }
  }

  const hasOverrides = Object.keys(overridesPatch).length > 0;

  if (isPptx) {
    // PPTX → HTML conversion happens inside applyPresentationOps; overrides
    // are stamped on the rendered HTML afterwards.
    if (rustOps.length === 0 && hasOverrides) {
      rustOps.push({ op: "set_theme", theme: parsed.theme ?? "midnight" });
    }
    const result = await Api.applyPresentationOps({
      path: currentPath,
      ops: rustOps,
      outputName,
    });
    currentPath = result.path;
    if (hasOverrides) {
      const rendered = await Api.readFileText(currentPath);
      const next = upsertSlideOverridesInHtml(rendered, overridesPatch);
      currentPath = await Api.writeArtifactCopy(currentPath, next, outputName);
    }
    return currentPath;
  }

  // NELA HTML: stamp overrides first (Rust re-render preserves + remaps them),
  // then run the batched surgical ops.
  if (hasOverrides) {
    const next = upsertSlideOverridesInHtml(html, overridesPatch);
    currentPath = await Api.writeArtifactCopy(currentPath, next, outputName);
    html = next;
  }
  if (rustOps.length) {
    const result = await Api.applyPresentationOps({
      path: currentPath,
      ops: rustOps,
      outputName,
    });
    currentPath = result.path;
  }
  return currentPath;
}

// ── Freeform HTML style application ──────────────────────────────────────────

async function applyFreeformStyleCommands(args: {
  styleCommands: PresentationEditCommand[];
  currentPath: string;
  html: string;
  outputName: string;
  applied: string[];
  sid: string;
  ctx: SendHandlerContext;
}): Promise<{ path: string; html: string } | null> {
  const { styleCommands, currentPath, outputName, applied } = args;
  let html = args.html;

  const slideCount = countFreeformSlides(html);
  if (slideCount < 1) return null;

  for (const cmd of styleCommands) {
    switch (cmd.kind) {
      case "set_background": {
        if (cmd.scope.type === "deck") {
          html = upsertDeckOverridesInFreeformHtml(html, {
            background: cmd.color,
            text: contrastTextFor(cmd.color),
          });
        } else {
          const idx = resolveScopeIndex(cmd.scope, slideCount);
          if (idx == null) return null;
          html = setInlineStyleOnFreeformSlide(
            html,
            idx,
            `background: ${cmd.color} !important; background-image: none !important; color: ${contrastTextFor(cmd.color)};`
          );
        }
        applied.push(describeCommand(cmd));
        break;
      }
      case "set_text_color": {
        if (cmd.scope.type === "deck") {
          html = upsertDeckOverridesInFreeformHtml(html, { text: cmd.color });
        } else {
          const idx = resolveScopeIndex(cmd.scope, slideCount);
          if (idx == null) return null;
          html = setInlineStyleOnFreeformSlide(
            html,
            idx,
            `color: ${cmd.color} !important;`
          );
        }
        applied.push(describeCommand(cmd));
        break;
      }
      case "set_font": {
        html = upsertDeckOverridesInFreeformHtml(html, { font: cmd.font });
        applied.push(describeCommand(cmd));
        break;
      }
      case "set_layout":
        // Freeform decks have arbitrary markup — leave to the LLM patch path.
        return null;
      case "reformat_content": {
        const targets =
          cmd.scope.type === "deck"
            ? Array.from({ length: slideCount }, (_, i) => i)
            : [resolveScopeIndex(cmd.scope, slideCount)].filter(
                (i): i is number => i != null
              );
        const titles = listFreeformSlideTitles(html);
        for (const idx of targets) {
          const block = getFreeformSlideBlock(html, idx);
          const bullets = bulletsFromFreeformBlock(block);
          const paragraphs = paragraphsFromFreeformBlock(block);
          const source = bullets.length ? bullets : paragraphs;
          if (!source.length) continue;
          if (cmd.style === "paragraph") {
            const paras = bulletsToParagraphs([...bullets, ...paragraphs]);
            if (!paras.length) continue;
            html = expandSlideInFreeformHtml(html, idx, {
              title: titles[idx] || `Slide ${idx + 1}`,
              bullets: [],
              paragraphs: paras,
              summary: paras[0],
              bodyStyle: "paragraphs",
              preserveImage: true,
            });
          } else {
            const items = contentToBullets([...bullets, ...paragraphs]);
            if (!items.length) continue;
            html = expandSlideInFreeformHtml(html, idx, {
              title: titles[idx] || `Slide ${idx + 1}`,
              bullets: items,
              paragraphs: [],
              bodyStyle: "bullets",
              preserveImage: true,
            });
          }
        }
        applied.push(describeCommand(cmd));
        break;
      }
      case "patch_content": {
        const idx = Math.max(0, Math.min(slideCount - 1, cmd.oneBased - 1));
        const bullets = cmd.bullets ?? [];
        html = expandSlideInFreeformHtml(html, idx, {
          title: cmd.title || listFreeformSlideTitles(html)[idx] || `Slide ${idx + 1}`,
          bullets,
          paragraphs: bullets.length ? [] : undefined,
          bodyStyle: bullets.length ? "bullets" : "paragraphs",
          preserveImage: true,
        });
        applied.push(describeCommand(cmd));
        break;
      }
      case "add_slide_spec": {
        html = insertSlideIntoFreeformHtml(
          html,
          {
            title: cmd.title,
            bullets: cmd.bullets,
            bodyStyle: "bullets",
          },
          cmd.insertIndex ?? slideCount
        );
        applied.push(describeCommand(cmd));
        break;
      }
      case "remove_slide_at": {
        const idx = Math.max(0, Math.min(slideCount - 1, cmd.oneBased - 1));
        html = removeSlideFromFreeformHtml(html, idx);
        applied.push(describeCommand(cmd));
        break;
      }
      case "move_slide_spec": {
        html = moveSlideInFreeformHtml(
          html,
          Math.max(0, cmd.fromOneBased - 1),
          Math.max(0, cmd.toOneBased - 1)
        );
        applied.push(describeCommand(cmd));
        break;
      }
      default:
        break;
    }
  }

  const newPath = await Api.writeArtifactCopy(currentPath, html, outputName);
  return { path: newPath, html };
}
