import {
  cssColorToHex,
  firstFontFamily,
  pxToPt,
  type PxRect,
} from "./geometry.ts";
import {
  cssNeedsRaster,
  isBackgroundClipText,
  isHiddenComputed,
  isOpaqueCssColor,
  parseLinearGradient,
} from "./cssFill.ts";
import type { IrFill, IrNode } from "./ir.ts";
import { captureElementPng, captureMediaHost } from "./captureMedia.ts";
import { isTextHostTag } from "./slideRoots.ts";
import {
  collectMediaHosts,
  collectTextHosts,
  isInsideMedia,
} from "./textHosts.ts";

const SKIP_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "noscript",
  "br",
  "head",
]);

function relRect(el: Element, slideRect: DOMRect): PxRect {
  const r = el.getBoundingClientRect();
  return {
    x: r.left - slideRect.left,
    y: r.top - slideRect.top,
    w: r.width,
    h: r.height,
  };
}

/** Content box: PPTX text has no CSS padding. */
export function insetRectByPadding(rect: PxRect, cs: CSSStyleDeclaration): PxRect {
  const pl = parsePx(cs.paddingLeft);
  const pr = parsePx(cs.paddingRight);
  const pt = parsePx(cs.paddingTop);
  const pb = parsePx(cs.paddingBottom);
  return {
    x: rect.x + pl,
    y: rect.y + pt,
    w: Math.max(1, rect.w - pl - pr),
    h: Math.max(1, rect.h - pt - pb),
  };
}

function parsePx(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function underRaster(el: Element, roots: Set<Element>): boolean {
  let p: Element | null = el;
  while (p) {
    if (roots.has(p) && p !== el) return true;
    p = p.parentElement;
  }
  return false;
}

function shouldRasterEl(el: HTMLElement, win: Window): boolean {
  const cs = win.getComputedStyle(el);
  return cssNeedsRaster({
    backgroundImage: cs.backgroundImage,
    filter: cs.filter,
    mixBlendMode: cs.mixBlendMode,
    clipPath: cs.clipPath,
    transform: cs.transform,
  });
}

function shapeFill(cs: CSSStyleDeclaration): IrFill | undefined {
  const img = cs.backgroundImage || "";
  if (img && img !== "none") {
    const grad = parseLinearGradient(img);
    if (grad) return { kind: "grad", grad };
  }
  if (isOpaqueCssColor(cs.backgroundColor)) {
    const color = cssColorToHex(cs.backgroundColor, "");
    if (color) return { kind: "solid", color };
  }
  return undefined;
}

export async function walkSlideToIr(
  slide: HTMLElement,
  win: Window
): Promise<IrNode[]> {
  const slideRect = slide.getBoundingClientRect();
  const nodes: IrNode[] = [];
  const rasterRoots = new Set<Element>();

  for (const el of collectMediaHosts(slide)) {
    rasterRoots.add(el);
  }
  const all = [slide, ...Array.from(slide.querySelectorAll("*"))] as HTMLElement[];
  for (const el of all) {
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
    if (shouldRasterEl(el, win)) rasterRoots.add(el);
  }

  const captured = new Set<Element>();
  for (const el of rasterRoots) {
    if (!(el instanceof HTMLElement)) continue;
    if (underRaster(el, rasterRoots)) continue;
    const host = await captureMediaHost(el, slide);
    const dataUrl =
      host?.dataUrl ??
      (await captureElementPng(el).catch(() => null));
    if (!dataUrl) continue;
    const rect = host?.rect ?? relRect(el, slideRect);
    if (rect.w < 2 || rect.h < 2) continue;
    nodes.push({ kind: "image", rect, dataUrl });
    captured.add(el);
  }

  const rasterSkip = new Set<Element>([...rasterRoots, ...captured]);

  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    if (rasterSkip.has(el) || underRaster(el, rasterSkip)) continue;
    const cs = win.getComputedStyle(el);
    if (isHiddenComputed(cs.visibility, cs.display, cs.opacity)) continue;
    const rect = relRect(el, slideRect);
    if (rect.w < 2 || rect.h < 2) continue;

    if (isBackgroundClipText(cs)) continue;
    const fill = shapeFill(cs);
    const strokeW = parsePx(cs.borderTopWidth);
    const strokeStyle = (cs.borderTopStyle || "").trim();
    const hasStroke =
      strokeW >= 0.5 && strokeStyle !== "none" && isOpaqueCssColor(cs.borderTopColor);
    if (!fill && !hasStroke) continue;
    if (isTextHostTag(tag) && fill?.kind === "grad" && !hasStroke) continue;

    const radiusPx = parsePx(cs.borderTopLeftRadius);
    const opacity = parseFloat(cs.opacity || "1");
    nodes.push({
      kind: "shape",
      rect,
      fill,
      strokeColor: hasStroke ? cssColorToHex(cs.borderTopColor, "000000") : undefined,
      strokeWidthPx: hasStroke ? strokeW : 0,
      radiusPx,
      opacity: Number.isFinite(opacity) ? opacity : 1,
    });
  }

  for (const el of collectTextHosts(slide)) {
    if (underRaster(el, rasterSkip) || isInsideMedia(el)) continue;
    const cs = win.getComputedStyle(el);
    if (isHiddenComputed(cs.visibility, cs.display, cs.opacity)) continue;
    const rect = insetRectByPadding(relRect(el, slideRect), cs);
    if (rect.w < 2 || rect.h < 2) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const fontPx = parseFloat(cs.fontSize) || 16;
    const weight = cs.fontWeight;
    const bold =
      weight === "bold" ||
      weight === "bolder" ||
      (parseInt(weight, 10) >= 600 && !Number.isNaN(parseInt(weight, 10)));
    const alignRaw = cs.textAlign;
    const align =
      alignRaw === "center" || alignRaw === "right"
        ? alignRaw
        : alignRaw === "end"
          ? "right"
          : "left";
    nodes.push({
      kind: "text",
      rect,
      text,
      fontSizePt: Math.max(8, Math.round(pxToPt(fontPx) * 10) / 10),
      fontFace: firstFontFamily(cs.fontFamily),
      bold,
      italic: cs.fontStyle === "italic" || cs.fontStyle === "oblique",
      color: cssColorToHex(cs.color, "111111"),
      align,
    });
  }

  return nodes;
}
