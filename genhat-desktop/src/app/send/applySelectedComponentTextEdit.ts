/**
 * Persist in-preview text edits for a selected presentation component.
 */

import { Api } from "../../api";
import type { SelectedComponentRole } from "../presentationPreviewSelect";
import {
  countFreeformSlides,
  getFreeformSlideBlock,
  replaceFreeformSlideBlock,
} from "./freeformHtmlSlideEdit";
import { writeDeckHtmlCopy } from "./applyDeckLibraryImage";
import type { SendHandlerContext } from "./types";

export type ComponentTextEditCommit = {
  slideIndex: number;
  role: SelectedComponentRole | string;
  tagName: string;
  selectorHint: string;
  bulletIndex?: number;
  oldText: string;
  newText: string;
  /** Prefer this when present — preserves <br> / light markup from contentEditable. */
  newInnerHTML?: string;
};

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripSlidePrefix(selectorHint: string): string {
  // ".slide[data-num='2'] > .slide-header h2" → ".slide-header h2"
  // ".slide:nth-of-type(1) > h1" → "h1"
  const parts = selectorHint.split(/\s*>\s*/);
  if (parts.length <= 1) return selectorHint.replace(/^\.slide[^>\s]*/, "").trim();
  return parts.slice(1).join(" > ").trim();
}

function findTargetInSlide(
  root: Element,
  edit: ComponentTextEditCommit
): Element | null {
  const tag = (edit.tagName || "").toLowerCase();

  if (typeof edit.bulletIndex === "number" && edit.bulletIndex >= 0) {
    const lis = Array.from(root.querySelectorAll("li"));
    if (edit.bulletIndex < lis.length) return lis[edit.bulletIndex]!;
  }

  const relative = stripSlidePrefix(edit.selectorHint);
  if (relative) {
    try {
      const hit = root.querySelector(relative);
      if (hit) return hit;
    } catch {
      /* invalid selector */
    }
  }

  const oldNorm = normalizeText(edit.oldText);
  const candidates = Array.from(root.querySelectorAll("*")).filter((el) => {
    if (tag && el.tagName.toLowerCase() !== tag) return false;
    return normalizeText(el.textContent || "") === oldNorm;
  });
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    // Prefer deepest / leaf-most match
    candidates.sort(
      (a, b) => (b.querySelectorAll("*").length ? 0 : 1) - (a.querySelectorAll("*").length ? 0 : 1)
    );
    return candidates[0]!;
  }

  // Soft match: starts with old text
  if (oldNorm) {
    const soft = Array.from(root.querySelectorAll(tag || "*")).find((el) =>
      normalizeText(el.textContent || "").startsWith(oldNorm.slice(0, 40))
    );
    if (soft) return soft;
  }

  return null;
}

function applyTextToElement(el: Element, edit: ComponentTextEditCommit): void {
  if (typeof edit.newInnerHTML === "string") {
    el.innerHTML = edit.newInnerHTML;
    return;
  }
  const text = edit.newText;
  const kids = Array.from(el.childNodes);
  const onlyTextOrBr = kids.every(
    (n) =>
      n.nodeType === Node.TEXT_NODE ||
      (n.nodeType === Node.ELEMENT_NODE &&
        (n as Element).tagName.toLowerCase() === "br")
  );
  if (onlyTextOrBr || kids.length === 0) {
    const esc = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    el.innerHTML = esc.replace(/\n/g, "<br>");
    return;
  }
  el.textContent = text;
}

/**
 * Patch one selected component's text inside a freeform/NELA HTML deck string.
 */
export function patchSelectedComponentText(
  html: string,
  edit: ComponentTextEditCommit
): string {
  if (normalizeText(edit.oldText) === normalizeText(edit.newText) && !edit.newInnerHTML) {
    return html;
  }
  const slideCount = countFreeformSlides(html);
  if (slideCount < 1) {
    throw new Error("No slides found in HTML deck");
  }
  const slideIndex = Math.max(
    0,
    Math.min(slideCount - 1, Math.floor(edit.slideIndex))
  );
  const block = getFreeformSlideBlock(html, slideIndex);
  if (!block) {
    throw new Error(`Could not load slide ${slideIndex + 1}`);
  }

  const doc = new DOMParser().parseFromString(block, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) {
    throw new Error(`Could not parse slide ${slideIndex + 1}`);
  }

  const target = findTargetInSlide(root, edit);
  if (!target) {
    throw new Error(
      `Could not find selected ${edit.role || "component"} on slide ${slideIndex + 1}`
    );
  }

  applyTextToElement(target, edit);
  return replaceFreeformSlideBlock(html, slideIndex, root.outerHTML);
}

export async function applySelectedComponentTextEdit(args: {
  artifactPath: string;
  sid: string;
  ctx: SendHandlerContext;
  edit: ComponentTextEditCommit;
}): Promise<{ path: string; html: string }> {
  const html = await Api.readFileText(args.artifactPath);
  const next = patchSelectedComponentText(html, args.edit);
  const path = await writeDeckHtmlCopy({
    artifactPath: args.artifactPath,
    html: next,
    sid: args.sid,
    ctx: args.ctx,
  });
  return { path, html: next };
}
