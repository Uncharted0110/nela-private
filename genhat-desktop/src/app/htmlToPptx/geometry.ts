/** PPTX layout size in inches (standard 16:9). */
export const IN_W = 13.333;
export const IN_H = 7.5;

export type PxRect = { x: number; y: number; w: number; h: number };
export type InRect = { x: number; y: number; w: number; h: number };

export type LetterboxFrame = {
  contentW: number;
  contentH: number;
  offsetX: number;
  offsetY: number;
  pxToInX: number;
  pxToInY: number;
};

/** Fit a slide pixel box onto 16:9 without stretching (uniform scale). */
export function letterboxFrame(slideW: number, slideH: number): LetterboxFrame {
  const w = Math.max(1, slideW);
  const h = Math.max(1, slideH);
  const s = Math.min(IN_W / w, IN_H / h);
  const contentW = w * s;
  const contentH = h * s;
  return {
    contentW,
    contentH,
    offsetX: (IN_W - contentW) / 2,
    offsetY: (IN_H - contentH) / 2,
    pxToInX: s,
    pxToInY: s,
  };
}

export function rectToInches(rect: PxRect, frame: LetterboxFrame): InRect {
  return {
    x: frame.offsetX + rect.x * frame.pxToInX,
    y: frame.offsetY + rect.y * frame.pxToInY,
    w: rect.w * frame.pxToInX,
    h: rect.h * frame.pxToInY,
  };
}

export function pxToPt(px: number): number {
  return (px * 72) / 96;
}

/** Normalize CSS color to RRGGBB (no #) for pptxgenjs. */
export function cssColorToHex(color: string, fallback = "000000"): string {
  const c = (color || "").trim();
  if (!c || c === "transparent" || c === "rgba(0, 0, 0, 0)") return fallback;
  const hexMatch = c.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hexMatch) {
    let h = hexMatch[1];
    if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
    return h.toLowerCase();
  }
  const rgb = c.match(/rgba?\(([^)]+)\)/i);
  if (rgb) {
    const parts = rgb[1].split(",").map((p) => parseFloat(p.trim()));
    if (parts.length >= 3 && parts.every((n) => !Number.isNaN(n))) {
      return parts
        .slice(0, 3)
        .map((n) =>
          Math.max(0, Math.min(255, Math.round(n)))
            .toString(16)
            .padStart(2, "0")
        )
        .join("");
    }
  }
  return fallback;
}

export function firstFontFamily(value: string, fallback = "Arial"): string {
  const first = (value || "").split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
  return first || fallback;
}
