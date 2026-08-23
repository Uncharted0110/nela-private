import type { IrNode } from "./ir.ts";

/**
 * Detect a collapsed/left-dumped walk (flex centering lost, or empty IR).
 * Full-bleed background shapes are ignored.
 */
export function slideIrLooksCollapsed(
  ir: IrNode[],
  slideW: number,
  slideH: number
): boolean {
  if (slideW < 200 || slideH < 200) return true;
  const items = ir.filter((n) => {
    if (
      n.kind === "shape" &&
      n.rect.w >= slideW * 0.85 &&
      n.rect.h >= slideH * 0.85
    ) {
      return false;
    }
    return n.rect.w >= 2 && n.rect.h >= 2;
  });
  if (items.length === 0) return true;
  if (slideW / slideH < 1.4) return false;
  const leftish = items.filter((n) => n.rect.x + n.rect.w / 2 < slideW * 0.32)
    .length;
  return items.length >= 4 && leftish / items.length >= 0.85;
}
