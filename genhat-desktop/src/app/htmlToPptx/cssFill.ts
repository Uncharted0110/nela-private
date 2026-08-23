import { cssColorToHex } from "./geometry.ts";

export type GradStop = { color: string; position: number };
export type LinearGrad = { angle: number; colors: GradStop[] };

/** Split a CSS list on commas that are not inside parentheses. */
export function splitCssList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function isOpaqueCssColor(color: string): boolean {
  const c = (color || "").trim();
  if (!c || c === "transparent") return false;
  if (c === "rgba(0, 0, 0, 0)" || c === "rgba(0,0,0,0)") return false;
  const rgb = c.match(/rgba?\(([^)]+)\)/i);
  if (rgb) {
    const parts = rgb[1].split(",").map((p) => parseFloat(p.trim()));
    if (parts.length >= 4 && (Number.isNaN(parts[3]) || parts[3] === 0)) {
      return false;
    }
  }
  return true;
}

export function isHiddenComputed(
  visibility: string,
  display: string,
  opacity: string
): boolean {
  if ((visibility || "").trim() === "hidden") return true;
  if ((display || "").trim() === "none") return true;
  const o = parseFloat(opacity || "1");
  return !Number.isNaN(o) && o === 0;
}

export function isBackgroundClipText(cs: {
  backgroundClip?: string;
  webkitBackgroundClip?: string;
}): boolean {
  const clip = `${cs.backgroundClip ?? ""} ${cs.webkitBackgroundClip ?? ""}`.toLowerCase();
  return clip.includes("text");
}

export function cssNeedsRaster(input: {
  backgroundImage: string;
  filter: string;
  mixBlendMode: string;
  clipPath: string;
  transform: string;
}): boolean {
  const img = input.backgroundImage || "";
  if (/radial-gradient|conic-gradient/i.test(img)) return true;
  const filter = (input.filter || "").trim();
  if (filter && filter !== "none") return true;
  const blend = (input.mixBlendMode || "").trim();
  if (blend && blend !== "normal") return true;
  const clip = (input.clipPath || "").trim();
  if (clip && clip !== "none" && clip !== "auto") return true;
  const tf = (input.transform || "").trim();
  if (tf && tf !== "none" && /matrix3d|perspective|rotateX|rotateY|skew/i.test(tf)) {
    return true;
  }
  return false;
}

function parseAnglePrefix(inner: string): { angle: number; rest: string } {
  const deg = inner.match(/^(\d+(?:\.\d+)?)deg\s*,\s*/i);
  if (deg) {
    return { angle: parseFloat(deg[1]), rest: inner.slice(deg[0].length) };
  }
  const to = inner.match(/^to\s+(top|bottom|left|right)(?:\s+\w+)?\s*,\s*/i);
  if (to) {
    const dir = to[1].toLowerCase();
    const angle =
      dir === "top" ? 0 : dir === "right" ? 90 : dir === "left" ? 270 : 180;
    return { angle, rest: inner.slice(to[0].length) };
  }
  return { angle: 180, rest: inner };
}

function colorFromStop(stop: string): string {
  const hex = stop.match(/#([0-9a-fA-F]{3,8})\b/);
  if (hex) return cssColorToHex("#" + hex[1], "");
  const rgb = stop.match(/rgba?\([^)]+\)/i);
  if (rgb) return cssColorToHex(rgb[0], "");
  return cssColorToHex(stop.split(/\s+/)[0] || "", "");
}

export function parseLinearGradient(backgroundImage: string): LinearGrad | null {
  const idx = backgroundImage.indexOf("linear-gradient(");
  if (idx < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = idx + "linear-gradient".length; i < backgroundImage.length; i++) {
    const ch = backgroundImage[i];
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const inner = backgroundImage.slice(idx + "linear-gradient(".length, end).trim();
  const { angle, rest } = parseAnglePrefix(inner);
  const stops = splitCssList(rest).filter(Boolean);
  if (stops.length < 2) return null;
  const colors: GradStop[] = stops.map((s, i) => {
    const posM = s.match(/(\d+(?:\.\d+)?)%/);
    const position = posM
      ? parseFloat(posM[1])
      : (i / Math.max(stops.length - 1, 1)) * 100;
    return { color: colorFromStop(s), position };
  }).filter((s) => Boolean(s.color));
  if (colors.length < 2) return null;
  return { angle, colors };
}
