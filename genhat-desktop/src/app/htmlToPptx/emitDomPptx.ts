import pptxgen from "pptxgenjs";
import {
  IN_H,
  IN_W,
  letterboxFrame,
  pxToPt,
  rectToInches,
  type InRect,
  type LetterboxFrame,
} from "./geometry.ts";
import type { IrNode } from "./ir.ts";

function usableIn(rect: InRect): boolean {
  return rect.w >= 0.04 && rect.h >= 0.03;
}

function emitNode(
  pptx: pptxgen,
  slide: ReturnType<pptxgen["addSlide"]>,
  node: IrNode,
  frame: LetterboxFrame
): void {
  const box = rectToInches(node.rect, frame);
  if (!usableIn(box)) return;

  if (node.kind === "shape") {
    const fill =
      node.fill?.kind === "grad"
        ? {
            type: "grad" as const,
            colors: node.fill.grad.colors.map((c) => ({
              color: c.color,
              position: c.position,
            })),
            angle: node.fill.grad.angle,
            transparency: Math.round((1 - node.opacity) * 100),
          }
        : node.fill?.kind === "solid"
          ? {
              color: node.fill.color,
              transparency: Math.round((1 - node.opacity) * 100),
            }
          : undefined;
    const line =
      node.strokeWidthPx > 0 && node.strokeColor
        ? { color: node.strokeColor, width: pxToPt(node.strokeWidthPx) }
        : undefined;
    const radiusIn = Math.min(box.w, box.h, node.radiusPx * frame.pxToInX);
    slide.addShape(
      radiusIn > 0.02 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect,
      {
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        fill,
        line,
        rectRadius: radiusIn > 0.02 ? radiusIn : undefined,
        rotate: 0,
      } as Record<string, unknown>
    );
    return;
  }

  if (node.kind === "image") {
    slide.addImage({
      data: node.dataUrl,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
    });
    return;
  }

  slide.addText(node.text, {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    fontFace: node.fontFace,
    fontSize: node.fontSizePt,
    bold: node.bold,
    italic: node.italic,
    color: node.color,
    align: node.align,
    valign: "top",
    wrap: true,
    margin: 0,
  });
}

export async function buildDomMappedPptxBase64(
  slides: {
    ir: IrNode[];
    slidePxW: number;
    slidePxH: number;
    slideBgHex: string;
    fallbackPng?: string;
  }[]
): Promise<string> {
  if (slides.length === 0) {
    throw new Error("No slides found in the presentation.");
  }
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "NELA_16x9", width: IN_W, height: IN_H });
  pptx.layout = "NELA_16x9";

  for (const d of slides) {
    const frame = letterboxFrame(d.slidePxW, d.slidePxH);
    const slide = pptx.addSlide();
    slide.background = { color: d.slideBgHex || "ffffff" };
    if (d.fallbackPng) {
      slide.addImage({
        data: d.fallbackPng,
        x: frame.offsetX,
        y: frame.offsetY,
        w: frame.contentW,
        h: frame.contentH,
      });
      continue;
    }
    const shapes = d.ir.filter((n) => n.kind === "shape");
    const images = d.ir.filter((n) => n.kind === "image");
    const texts = d.ir.filter((n) => n.kind === "text");
    for (const n of shapes) emitNode(pptx, slide, n, frame);
    for (const n of images) emitNode(pptx, slide, n, frame);
    for (const n of texts) emitNode(pptx, slide, n, frame);
  }

  return (await pptx.write({ outputType: "base64" })) as string;
}
