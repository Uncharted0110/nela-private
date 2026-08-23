/**
 * Shared slide-root contract for export and in-app click-edit.
 * Prefer class="slide"; aliases keep NELA per-slide editing working.
 */
export const SLIDE_ROOT_SELECTOR = [
  ".slide",
  "[data-nela-slide]",
  "[data-slide]",
  ".deck-slide",
  ".ppt-slide",
].join(", ");

export const SLIDE_ROOT_SELECTOR_IN_STAGE =
  ".slide-stage > .slide, .slides-wrapper .slide, " + SLIDE_ROOT_SELECTOR;

const TEXT_HOST_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "td",
  "th",
  "blockquote",
  "figcaption",
]);

export function isTextHostTag(tagName: string): boolean {
  return TEXT_HOST_TAGS.has(tagName.toLowerCase());
}

/** Nodes that are charts/diagrams/photos — not overlay text, export as pictures. */
export function isMediaHostSelectorMatch(el: {
  tagName: string;
  className?: string;
  hasAttribute?: (name: string) => boolean;
}): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "svg" || tag === "canvas" || tag === "img") return true;
  if (el.hasAttribute?.("data-nela-chart") || el.hasAttribute?.("data-chart")) {
    return true;
  }
  const cls = typeof el.className === "string" ? el.className : "";
  return /(?:^|\s)(?:echarts|diagram)(?:\s|$)/i.test(cls);
}

export function htmlLooksLikePresentation(html: string): boolean {
  if (!html) return false;
  if (/class\s*=\s*["'][^"']*\bslide\b/i.test(html)) return true;
  if (/\bdata-nela-slide\b/i.test(html)) return true;
  if (/\bdata-slide\s*=/i.test(html)) return true;
  if (/class\s*=\s*["'][^"']*\b(?:deck-slide|ppt-slide)\b/i.test(html)) {
    return true;
  }
  return false;
}

function isOpaqueBackground(color: string): boolean {
  const c = (color || "").trim();
  if (!c || c === "transparent") return false;
  if (c === "rgba(0, 0, 0, 0)" || c === "rgba(0,0,0,0)") return false;
  return true;
}

function looksLikeSlidePage(el: HTMLElement, win: Window): boolean {
  const cls = el.className?.toString?.() ?? "";
  if (/\bslide\b/i.test(cls)) return true;
  const r = el.getBoundingClientRect();
  if (r.height < 200 || r.width < 200) return false;
  const ratio = r.width / Math.max(1, r.height);
  if (ratio > 1.2 && ratio < 2.2) return true;
  const cs = win.getComputedStyle(el);
  return cs.position === "absolute" || cs.position === "fixed";
}

function dedupeNested(els: HTMLElement[]): HTMLElement[] {
  return els.filter(
    (el) => !els.some((other) => other !== el && other.contains(el))
  );
}

export function findSlideElements(doc: Document, win: Window): HTMLElement[] {
  const tagged = dedupeNested(
    Array.from(doc.querySelectorAll(SLIDE_ROOT_SELECTOR)) as HTMLElement[]
  );
  if (tagged.length > 0) return tagged;

  const sections = Array.from(doc.querySelectorAll("section")) as HTMLElement[];
  const pages = dedupeNested(
    sections.filter((el) => looksLikeSlidePage(el, win))
  );
  if (pages.length > 0) return pages;

  return [doc.body];
}

export function copyAncestorBackground(slide: HTMLElement, win: Window): void {
  const own = win.getComputedStyle(slide);
  if (own.backgroundImage !== "none" || isOpaqueBackground(own.backgroundColor)) {
    return;
  }
  const doc = slide.ownerDocument;
  const chain: (Element | null)[] = [
    slide.parentElement,
    doc.body,
    doc.documentElement,
  ];
  for (const node of chain) {
    if (!node) continue;
    const s = win.getComputedStyle(node);
    if (s.backgroundImage !== "none" || isOpaqueBackground(s.backgroundColor)) {
      slide.style.backgroundColor = s.backgroundColor;
      slide.style.backgroundImage = s.backgroundImage;
      slide.style.backgroundSize = s.backgroundSize;
      slide.style.backgroundPosition = s.backgroundPosition;
      slide.style.backgroundRepeat = s.backgroundRepeat;
      return;
    }
  }
}
