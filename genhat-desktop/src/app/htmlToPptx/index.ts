import { withDeckDocument } from "./openDeckDocument.ts";
import { isolateSlide, pinExportLayout, prepareSlidesForExport } from "./isolateSlide.ts";
import { slideIrLooksCollapsed } from "./irQuality.ts";
import { captureElementPng, computedSlideBackgroundHex } from "./captureMedia.ts";
import { walkSlideToIr } from "./walkSlide.ts";
import { buildDomMappedPptxBase64 } from "./emitDomPptx.ts";
import { cssColorToHex } from "./geometry.ts";
import type { IrNode } from "./ir.ts";

export { SLIDE_ROOT_SELECTOR, htmlLooksLikePresentation, findSlideElements, isTextHostTag } from "./slideRoots.ts";
export { letterboxFrame, rectToInches, cssColorToHex, IN_W, IN_H } from "./geometry.ts";
export { isInsideMedia, isNestedTextHost } from "./textHosts.ts";
export {
  parseLinearGradient,
  cssNeedsRaster,
  isHiddenComputed,
  isOpaqueCssColor,
} from "./cssFill.ts";

async function tick(): Promise<void> {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

async function rasterizeSlideFull(
  slide: HTMLElement,
  win: Window
): Promise<string> {
  const bg = cssColorToHex(win.getComputedStyle(slide).backgroundColor, "");
  return captureElementPng(slide, bg ? `#${bg}` : undefined);
}

/** DOM-mapped PPTX: native shapes/text; rasterize svg/canvas/exotic CSS only. */
export async function htmlToPptxBase64(html: string): Promise<string> {
  const packed = await withDeckDocument(html, async (doc, win) => {
    doc.body.classList.add("exporting");
    pinExportLayout(doc);
    const slides = prepareSlidesForExport(doc, win);
    const out: {
      ir: IrNode[];
      slidePxW: number;
      slidePxH: number;
      slideBgHex: string;
      fallbackPng?: string;
    }[] = [];

    for (const slide of slides) {
      const restoreIso = isolateSlide(slides, slide);
      try {
        await tick();
        const r = slide.getBoundingClientRect();
        const slidePxW = Math.max(1, r.width);
        const slidePxH = Math.max(1, r.height);
        const slideBgHex = computedSlideBackgroundHex(slide, win);
        try {
          const ir = await walkSlideToIr(slide, win);
          if (slideIrLooksCollapsed(ir, slidePxW, slidePxH)) {
            console.warn("DOM PPTX walk looked collapsed; using slide PNG");
            const fallbackPng = await rasterizeSlideFull(slide, win);
            out.push({
              ir: [],
              slidePxW,
              slidePxH,
              slideBgHex,
              fallbackPng,
            });
          } else {
            out.push({ ir, slidePxW, slidePxH, slideBgHex });
          }
        } catch (err) {
          console.warn("DOM PPTX walk failed; using slide PNG:", err);
          const fallbackPng = await rasterizeSlideFull(slide, win);
          out.push({
            ir: [],
            slidePxW,
            slidePxH,
            slideBgHex,
            fallbackPng,
          });
        }
      } finally {
        restoreIso();
      }
    }
    return out;
  });

  return buildDomMappedPptxBase64(packed);
}

/** Full visual of each slide (text + diagrams) for PDF. */
export async function captureFullSlidePngs(html: string): Promise<string[]> {
  return withDeckDocument(html, async (doc, win) => {
    doc.body.classList.add("exporting");
    pinExportLayout(doc);
    const slides = prepareSlidesForExport(doc, win);
    const images: string[] = [];
    for (const slide of slides) {
      const restoreIso = isolateSlide(slides, slide);
      try {
        await tick();
        images.push(await rasterizeSlideFull(slide, win));
      } finally {
        restoreIso();
      }
    }
    if (images.length === 0) {
      throw new Error("No slides found in the presentation.");
    }
    return images;
  });
}
