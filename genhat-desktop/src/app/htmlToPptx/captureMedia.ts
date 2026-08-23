import { toPng } from "html-to-image";
import { cssColorToHex, type PxRect } from "./geometry.ts";

export type CapturedMedia = {
  dataUrl: string;
  rect: PxRect;
};

async function pngFromCanvas(canvas: HTMLCanvasElement): Promise<string | null> {
  try {
    const url = canvas.toDataURL("image/png");
    if (!url || url.length < 80) return null;
    return url;
  } catch {
    return null;
  }
}

async function pngFromElement(el: HTMLElement): Promise<string | null> {
  try {
    return await toPng(el, {
      pixelRatio: 2,
      cacheBust: true,
      style: { transform: "none", margin: "0" },
    });
  } catch {
    return null;
  }
}

export async function captureMediaHost(
  el: HTMLElement,
  slide: HTMLElement
): Promise<CapturedMedia | null> {
  const slideRect = slide.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const rect: PxRect = {
    x: r.left - slideRect.left,
    y: r.top - slideRect.top,
    w: r.width,
    h: r.height,
  };
  const tag = el.tagName.toLowerCase();
  let dataUrl: string | null = null;

  if (tag === "img") {
    const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
    if (src && (src.startsWith("data:") || src.startsWith("blob:") || /^https?:/i.test(src))) {
      if (src.startsWith("data:")) dataUrl = src;
      else dataUrl = await pngFromElement(el);
    } else {
      dataUrl = await pngFromElement(el);
    }
  } else if (tag === "canvas") {
    dataUrl = await pngFromCanvas(el as HTMLCanvasElement);
    if (!dataUrl) dataUrl = await pngFromElement(el);
  } else {
    const canvas = el.querySelector("canvas");
    if (canvas) dataUrl = await pngFromCanvas(canvas);
    if (!dataUrl) dataUrl = await pngFromElement(el);
  }

  if (!dataUrl) return null;
  return { dataUrl, rect };
}

export async function captureElementPng(
  el: HTMLElement,
  backgroundColor?: string
): Promise<string> {
  const bg =
    backgroundColor && backgroundColor !== "transparent"
      ? backgroundColor
      : undefined;
  return toPng(el, {
    pixelRatio: 2,
    cacheBust: true,
    backgroundColor: bg,
    style: { transform: "none", margin: "0" },
  });
}

export function computedSlideBackgroundHex(
  slide: HTMLElement,
  win: Window
): string {
  const cs = win.getComputedStyle(slide);
  const fromSlide = cssColorToHex(cs.backgroundColor, "");
  if (fromSlide) return fromSlide;
  const body = cssColorToHex(win.getComputedStyle(slide.ownerDocument.body).backgroundColor, "");
  if (body) return body;
  return "ffffff";
}
