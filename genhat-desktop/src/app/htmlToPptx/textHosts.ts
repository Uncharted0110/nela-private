import { isMediaHostSelectorMatch, isTextHostTag } from "./slideRoots.ts";
import {
  cssColorToHex,
  firstFontFamily,
  pxToPt,
  type PxRect,
} from "./geometry.ts";

export { isTextHostTag };

export type MeasuredTextBox = {
  text: string;
  rect: PxRect;
  fontSizePt: number;
  fontFace: string;
  bold: boolean;
  italic: boolean;
  color: string;
  align: "left" | "center" | "right";
};

const MEDIA_CLOSEST =
  "svg, canvas, [data-nela-chart], [data-chart], .echarts, .diagram";

export function isInsideMedia(el: Element): boolean {
  return Boolean(el.closest(MEDIA_CLOSEST));
}

export function isNestedTextHost(el: Element, slide: Element): boolean {
  let p = el.parentElement;
  while (p && p !== slide) {
    const tag = p.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      p = p.parentElement;
      continue;
    }
    if (isTextHostTag(p.tagName)) return true;
    p = p.parentElement;
  }
  return false;
}

function visibleText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function mapAlign(align: string): "left" | "center" | "right" {
  if (align === "center" || align === "right") return align;
  if (align === "end") return "right";
  if (align === "start") return "left";
  return "left";
}

export function collectTextHosts(slide: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    slide.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,figcaption,[role=heading]"
    )
  ) as HTMLElement[];
  return nodes.filter((el) => {
    if (isInsideMedia(el)) return false;
    if (isNestedTextHost(el, slide)) return false;
    if (!visibleText(el)) return false;
    return true;
  });
}

export function measureTextBoxes(
  slide: HTMLElement,
  win: Window
): MeasuredTextBox[] {
  const slideRect = slide.getBoundingClientRect();
  const hosts = collectTextHosts(slide);
  const boxes: MeasuredTextBox[] = [];
  for (const el of hosts) {
    const r = el.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    if (w < 2 || h < 2) continue;
    const cs = win.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const opacity = parseFloat(cs.opacity || "1");
    if (opacity === 0) continue;
    const fontPx = parseFloat(cs.fontSize) || 16;
    const weight = cs.fontWeight;
    const bold =
      weight === "bold" ||
      weight === "bolder" ||
      (parseInt(weight, 10) >= 600 && !Number.isNaN(parseInt(weight, 10)));
    boxes.push({
      text: visibleText(el),
      rect: {
        x: r.left - slideRect.left,
        y: r.top - slideRect.top,
        w,
        h,
      },
      fontSizePt: Math.max(8, Math.round(pxToPt(fontPx) * 10) / 10),
      fontFace: firstFontFamily(cs.fontFamily),
      bold,
      italic: cs.fontStyle === "italic" || cs.fontStyle === "oblique",
      color: cssColorToHex(cs.color, "111111"),
      align: mapAlign(cs.textAlign),
    });
  }
  return boxes;
}

export function collectMediaHosts(slide: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    slide.querySelectorAll(
      "svg, canvas, img, [data-nela-chart], [data-chart], .echarts, .diagram"
    )
  ) as HTMLElement[];
  return nodes.filter((el) => {
    if (!isMediaHostSelectorMatch(el)) return false;
    const parentMedia = el.parentElement?.closest(
      "svg, canvas, img, [data-nela-chart], [data-chart], .echarts, .diagram"
    );
    if (parentMedia && parentMedia !== el && slide.contains(parentMedia)) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  });
}
