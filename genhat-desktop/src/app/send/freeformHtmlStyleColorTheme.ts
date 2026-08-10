/**
 * Hue-preserving theme recolor for freeform HTML decks.
 * Keeps chromatic hue identity (multi-color titles/accents), retargets neutrals
 * for light/dark, and repairs text/shape contrast against local or canvas bg.
 */

import {
  oklchToHex,
  rgbToOklch,
  resolveHarmonyHues,
  wrapHue,
  type FiveTokenPalette,
  type Oklch,
} from "./themePaletteEngine";

const OVERRIDE_STYLE_ID = "nela-theme-override";
const SAFETY_STYLE_ID = "nela-theme-safety";

const CHROMATIC_C = 0.04;
const CONTRAST_TEXT = 4.5;
const CONTRAST_SHAPE = 1.8;

type Rgb = { r: number; g: number; b: number; a: number };
type ColorUsage = "text" | "fill" | "shadow" | "border" | "unknown";

const NAMED: Record<string, Rgb> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  navy: { r: 0, g: 0, b: 128, a: 1 },
  teal: { r: 0, g: 128, b: 128, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 },
  gold: { r: 255, g: 215, b: 0, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  silver: { r: 192, g: 192, b: 192, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

const COLOR_TOKEN_RE =
  /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|rgba?\(\s*[^)]+\)|hsla?\(\s*[^)]+\)|\b(?:white|black|red|green|blue|navy|teal|orange|gold|gray|grey|silver|transparent)\b/gi;

/**
 * Named colors like `gold` / `coral` / `green` must not match inside
 * `--gold`, `--coral`, `--green` (would turn `var(--gold)` into `var(--#…)`).
 */
function isNamedColorInsideCustomPropIdent(
  css: string,
  matchStart: number,
  matchRaw: string
): boolean {
  const t = matchRaw.trim().toLowerCase();
  if (t.startsWith("#") || t.startsWith("rgb") || t.startsWith("hsl")) {
    return false;
  }
  let i = matchStart;
  while (i > 0 && /[A-Za-z0-9_-]/.test(css[i - 1]!)) i--;
  return css.slice(i, i + 2) === "--";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function clampByte(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)));
}

export function parseCssColor(raw: string): Rgb | null {
  const v = raw.trim().toLowerCase();
  if (NAMED[v]) return { ...NAMED[v] };

  const hex = v.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const src = hex[1];
    let h = src;
    if (src.length === 3) {
      h = src
        .split("")
        .map((c) => c + c)
        .join("");
    } else if (src.length === 4) {
      h =
        src
          .slice(0, 3)
          .split("")
          .map((c) => c + c)
          .join("") +
        src[3] +
        src[3];
    }
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      };
    }
    if (h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: parseInt(h.slice(6, 8), 16) / 255,
      };
    }
  }

  const rgb = v.match(
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/
  );
  if (rgb) {
    return {
      r: clampByte(Number(rgb[1])),
      g: clampByte(Number(rgb[2])),
      b: clampByte(Number(rgb[3])),
      a: rgb[4] != null ? Number(rgb[4]) : 1,
    };
  }

  const hsl = v.match(
    /^hsla?\(\s*([0-9.]+)\s*,\s*([0-9.]+)%\s*,\s*([0-9.]+)%(?:\s*,\s*([0-9.]+))?\s*\)$/
  );
  if (hsl) {
    const hh = Number(hsl[1]) / 360;
    const s = Number(hsl[2]) / 100;
    const l = Number(hsl[3]) / 100;
    const a = hsl[4] != null ? Number(hsl[4]) : 1;
    const hue2rgb = (p: number, q: number, t: number) => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    let r: number;
    let g: number;
    let b: number;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, hh + 1 / 3);
      g = hue2rgb(p, q, hh);
      b = hue2rgb(p, q, hh - 1 / 3);
    }
    return {
      r: clampByte(r * 255),
      g: clampByte(g * 255),
      b: clampByte(b * 255),
      a,
    };
  }

  return null;
}

function formatCssColor(c: Rgb, originalRaw: string): string {
  if (c.a < 0.999 || /^rgba?\(/i.test(originalRaw.trim())) {
    return `rgba(${clampByte(c.r)}, ${clampByte(c.g)}, ${clampByte(c.b)}, ${Number(c.a.toFixed(3))})`;
  }
  const h = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function hexToRgb(hex: string): Rgb | null {
  return parseCssColor(hex);
}

function relativeLuminance(c: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(wrapHue(a) - wrapHue(b));
  return Math.min(d, 360 - d);
}

/** Shortest-path blend; amount 0 = keep source, 1 = full brand. */
function blendHue(from: number, toward: number, amount: number): number {
  let d = wrapHue(toward) - wrapHue(from);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return wrapHue(from + d * clamp(amount, 0, 1));
}

function oklchToRgb(ok: Oklch): Rgb {
  const hex = oklchToHex(ok.l, ok.c, ok.h);
  return { ...hexToRgb(hex)!, a: 1 };
}

export type RecolorContext = {
  palette: FiveTokenPalette;
  accentHue: number;
  accentSoftHue: number;
  neutralHue: number;
  sourceCanvasLum: number;
  /** Target canvas solid approx (for contrast). */
  canvasRgb: Rgb;
};

function propertyAt(css: string, index: number): string {
  const before = css.slice(Math.max(0, index - 100), index);
  const m = before.match(/([-\w]+)\s*:\s*[^;{}]*$/);
  return m?.[1]?.toLowerCase() ?? "";
}

function customPropAt(css: string, index: number): string | null {
  const before = css.slice(Math.max(0, index - 120), index);
  const m = before.match(/(--[-\w]+)\s*:\s*[^;{}]*$/);
  return m?.[1]?.toLowerCase() ?? null;
}

function usageFromProperty(prop: string, customProp: string | null): ColorUsage {
  if (customProp) {
    if (/ink|text|muted|fg|foreground/i.test(customProp)) return "text";
    // Decorative offset / accent paints (hero gold slab, coral titles).
    if (/gold|coral|salmon|mustard|amber/i.test(customProp)) return "shadow";
    if (/teal|accent|brand|highlight|green|chip/i.test(customProp)) return "fill";
    if (/cream|bg|background|surface/i.test(customProp)) return "fill";
  }
  if (prop === "color") return "text";
  if (/box-shadow|text-shadow/i.test(prop)) return "shadow";
  if (/^border/.test(prop) || prop === "outline" || prop === "outline-color") {
    return "border";
  }
  if (/background|fill|stroke/i.test(prop)) return "fill";
  return "unknown";
}

/**
 * Hue-preserve chromatic colors; force text L for target tone; keep decorative
 * shapes visible on the canvas.
 */
export function recolorRgb(
  src: Rgb,
  ctx: RecolorContext,
  usage: ColorUsage = "unknown"
): Rgb {
  if (src.a < 0.08) return { ...src };

  const ok = rgbToOklch(src.r, src.g, src.b);
  const chromatic = ok.c >= CHROMATIC_C;
  const tone = ctx.palette.tone;
  const targetDark = tone === "dark";

  let next: Oklch;

  // Soft black/gray shadows: keep dark + alpha (don't invert to white).
  if (usage === "shadow" && !chromatic && src.a < 0.95) {
    next = {
      l: targetDark ? clamp(ok.l, 0.02, 0.25) : clamp(ok.l, 0.02, 0.2),
      c: 0.01,
      h: ctx.neutralHue,
    };
    const rgb = oklchToRgb(next);
    return { ...rgb, a: src.a };
  }

  if (usage === "text") {
    // Text must be dark on light themes and light on dark themes.
    // Fixes leftover light-on-dark hex (e.g. #e4dbdd) after a prior dark theme.
    if (!targetDark) {
      const muted = ok.l > 0.32 && ok.l < 0.78;
      let l: number;
      if (ok.l > 0.55) {
        // Was light text → flip to dark.
        l = muted
          ? clamp(1.05 - ok.l, 0.28, 0.48)
          : clamp(1.08 - ok.l, 0.16, 0.38);
      } else {
        l = clamp(ok.l, 0.16, 0.45);
      }
      next = {
        l,
        c: chromatic ? Math.min(ok.c, 0.2) : 0.02,
        h: chromatic ? ok.h : ctx.neutralHue,
      };
    } else {
      let l: number;
      if (ok.l < 0.5) {
        l = clamp(0.55 + (0.5 - ok.l), 0.68, 0.94);
      } else {
        l = clamp(ok.l, 0.68, 0.95);
      }
      next = {
        l,
        c: chromatic ? Math.min(ok.c, 0.2) : 0.02,
        h: chromatic ? ok.h : ctx.neutralHue,
      };
    }
  } else if (chromatic) {
    const towardSoft =
      hueDistance(ok.h, ctx.accentSoftHue) < hueDistance(ok.h, ctx.accentHue);
    const brandH = towardSoft ? ctx.accentSoftHue : ctx.accentHue;
    let l = ok.l;
    let c = Math.min(ok.c, 0.28);
    // Keep gold/coral offset shapes visible on light canvases.
    if (
      !targetDark &&
      (usage === "fill" || usage === "shadow" || usage === "border" || usage === "unknown") &&
      l > 0.72
    ) {
      l = clamp(0.58 + (l - 0.72) * 0.5, 0.52, 0.78);
      c = Math.max(c, 0.12);
    }
    if (targetDark && l < 0.35 && usage !== "text") {
      l = clamp(l + 0.15, 0.4, 0.7);
    }
    next = {
      l,
      c,
      // Nudge toward brand; keep source hue identity (gold stays gold-ish).
      h: blendHue(ok.h, brandH, 0.28),
    };
  } else {
    // Neutral fills / surfaces.
    let l = ok.l;
    const srcDark = ctx.sourceCanvasLum < 0.45;
    if (targetDark && !srcDark) {
      l = clamp(1 - ok.l * 0.9, 0.08, 0.92);
    } else if (!targetDark && srcDark) {
      l = clamp(0.12 + (1 - ok.l) * 0.86, 0.1, 0.98);
    } else if (!targetDark) {
      // Stay / go light: near-white stays elevated; mid grays stay mid.
      if (ok.l > 0.85) l = clamp(ok.l, 0.9, 0.99);
      else if (ok.l < 0.35) l = clamp(ok.l, 0.15, 0.4);
      else l = clamp(ok.l, 0.35, 0.9);
    } else {
      if (ok.l < 0.2) l = clamp(ok.l, 0.06, 0.22);
      else l = clamp(ok.l * 0.95, 0.1, 0.9);
    }
    next = {
      l,
      c: Math.min(0.03, Math.max(ok.c, 0.008)),
      h: ctx.neutralHue,
    };
  }

  // For chromatic / fill / text, ensure minimum contrast vs canvas when used as paint.
  let rgb = oklchToRgb(next);
  rgb = { ...rgb, a: src.a };

  if (usage === "text") {
    rgb = ensureContrast(rgb, ctx.canvasRgb, CONTRAST_TEXT);
  } else if (
    chromatic &&
    (usage === "fill" || usage === "shadow" || usage === "border") &&
    src.a > 0.85
  ) {
    rgb = ensureContrast(rgb, ctx.canvasRgb, CONTRAST_SHAPE);
  }

  return rgb;
}

/** Nudge foreground L until contrast vs background passes. */
export function ensureContrast(fg: Rgb, bg: Rgb, minRatio = CONTRAST_TEXT): Rgb {
  if (fg.a < 0.5) return fg;
  if (contrastRatio(fg, bg) >= minRatio) return fg;

  const ok = rgbToOklch(fg.r, fg.g, fg.b);
  const bgLum = relativeLuminance(bg);
  const wantLighter = bgLum < 0.45;
  let best = ok;

  for (let i = 1; i <= 18; i++) {
    const t = i / 18;
    const candidate: Oklch = {
      l: wantLighter
        ? clamp(ok.l + (0.98 - ok.l) * t, 0, 0.98)
        : clamp(ok.l * (1 - t * 0.95), 0.04, 1),
      c: Math.min(ok.c, 0.24),
      h: ok.h,
    };
    const rgb = oklchToRgb(candidate);
    best = candidate;
    if (contrastRatio({ ...rgb, a: 1 }, bg) >= minRatio) break;
  }

  const out = oklchToRgb(best);
  return { ...out, a: fg.a };
}

function stripDataUris(css: string): { css: string; holes: string[] } {
  const holes: string[] = [];
  const next = css.replace(/url\(\s*(['"]?)data:[^)]+?\1\s*\)/gi, (m) => {
    const i = holes.length;
    holes.push(m);
    return `url(__NELA_DATA_${i}__)`;
  });
  return { css: next, holes };
}

function restoreDataUris(css: string, holes: string[]): string {
  return css.replace(
    /url\(__NELA_DATA_(\d+)__\)/g,
    (_, n) => holes[Number(n)] ?? ""
  );
}

function estimateSourceCanvasLum(css: string): number {
  const hits: number[] = [];
  const re =
    /(?:html|body|\.deck|#deck|\.slide)\s*[^{]*\{[^}]*background(?:-color)?\s*:\s*([^;]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const token = m[1].match(COLOR_TOKEN_RE);
    if (!token) continue;
    const rgb = parseCssColor(token[0]);
    if (rgb && rgb.a > 0.5) hits.push(relativeLuminance(rgb));
  }
  for (const rm of css.matchAll(/--(?:cream|bg|background)\s*:\s*([^;}+]+)/gi)) {
    const token = rm[1].match(COLOR_TOKEN_RE);
    if (!token) continue;
    const rgb = parseCssColor(token[0]);
    if (rgb && rgb.a > 0.5) hits.push(relativeLuminance(rgb));
  }
  if (hits.length === 0) return 0.9;
  return hits.reduce((a, b) => a + b, 0) / hits.length;
}

function recolorColorToken(
  raw: string,
  ctx: RecolorContext,
  usage: ColorUsage
): string {
  const parsed = parseCssColor(raw);
  if (!parsed || parsed.a < 0.08) return raw;
  if (raw.trim().toLowerCase() === "transparent") return raw;
  const next = recolorRgb(parsed, ctx, usage);
  return formatCssColor(next, raw);
}

/** First pass: recolor every color token with property usage context. */
function recolorCssColors(css: string, ctx: RecolorContext): string {
  return css.replace(COLOR_TOKEN_RE, (raw, offset: number) => {
    if (isNamedColorInsideCustomPropIdent(css, offset, raw)) return raw;
    const prop = propertyAt(css, offset);
    const custom = customPropAt(css, offset);
    const usage = usageFromProperty(prop, custom);
    return recolorColorToken(raw, ctx, usage);
  });
}

function firstColorTokenIn(value: string): string | null {
  const re = new RegExp(COLOR_TOKEN_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    if (isNamedColorInsideCustomPropIdent(value, m.index, m[0])) continue;
    return m[0];
  }
  return null;
}

function firstColorIn(value: string): Rgb | null {
  const token = firstColorTokenIn(value);
  return token ? parseCssColor(token) : null;
}

function replaceColorTokensIn(
  value: string,
  replace: (raw: string) => string
): string {
  return value.replace(COLOR_TOKEN_RE, (raw, offset: number) => {
    if (isNamedColorInsideCustomPropIdent(value, offset, raw)) return raw;
    return replace(raw);
  });
}

/**
 * Second pass: repair `color` vs local bg, or vs canvas when no bg in rule.
 * Also repair solid box-shadow offset colors that vanish into the canvas.
 */
export function repairRuleContrast(css: string, canvas: Rgb): string {
  return css.replace(
    /([^{}@][^{]*)\{([^{}]+)\}/g,
    (full, prelude: string, body: string) => {
      if (/@(?:media|keyframes|supports)/i.test(prelude)) return full;
      let nextBody = body;

      const bgMatch = nextBody.match(
        /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i
      );
      const colorMatch = nextBody.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);

      let localBg = canvas;
      if (bgMatch && !/gradient\s*\(/i.test(bgMatch[1])) {
        const parsed = firstColorIn(bgMatch[1]);
        if (parsed && parsed.a > 0.4) localBg = parsed;
      }

      if (colorMatch) {
        const fgToken = firstColorTokenIn(colorMatch[1]);
        const fg = fgToken ? parseCssColor(fgToken) : null;
        if (fg && fgToken) {
          const fixed = ensureContrast(fg, localBg, CONTRAST_TEXT);
          if (
            fixed.r !== fg.r ||
            fixed.g !== fg.g ||
            fixed.b !== fg.b
          ) {
            const fixedCss = formatCssColor(fixed, fgToken);
            nextBody = nextBody.replace(
              /((?:^|;)\s*color\s*:\s*)([^;]+)/i,
              (_m, head: string, val: string) =>
                head +
                replaceColorTokensIn(val, (t) =>
                  t === fgToken ? fixedCss : t
                )
            );
          }
        }
      }

      // Solid offset shadows (14px 14px 0 #gold) — keep visible on canvas.
      if (/box-shadow\s*:/i.test(nextBody)) {
        nextBody = nextBody.replace(
          /(box-shadow\s*:\s*)([^;]+)/gi,
          (_m, head: string, val: string) => {
            const nextVal = replaceColorTokensIn(val, (raw) => {
              const c = parseCssColor(raw);
              if (!c || c.a < 0.85) return raw;
              const fixed = ensureContrast(c, canvas, CONTRAST_SHAPE);
              return formatCssColor(fixed, raw);
            });
            return head + nextVal;
          }
        );
      }

      return `${prelude}{${nextBody}}`;
    }
  );
}

function stripStyleById(html: string, id: string): string {
  return html.replace(
    new RegExp(`<style\\s+id=["']${id}["'][\\s\\S]*?<\\/style>\\s*`, "i"),
    ""
  );
}

function minimalSafetyCss(palette: FiveTokenPalette): string {
  return `<style id="${SAFETY_STYLE_ID}">
html, body {
  background: ${palette.backgroundGradient};
  background-attachment: fixed;
  color: ${palette.text};
}
</style>`;
}

function ensureMinimalSafety(html: string, palette: FiveTokenPalette): string {
  let next = stripStyleById(html, SAFETY_STYLE_ID);
  const css = minimalSafetyCss(palette);
  const headClose = next.lastIndexOf("</head>");
  if (headClose >= 0) {
    next = next.slice(0, headClose) + css + "\n" + next.slice(headClose);
  } else {
    next = css + "\n" + next;
  }
  return next;
}

function buildRecolorContext(
  palette: FiveTokenPalette,
  cssSample: string
): RecolorContext {
  const hues = resolveHarmonyHues(palette.brandHue, palette.harmony);
  const canvasRgb = parseCssColor(palette.background) ?? {
    r: palette.tone === "dark" ? 20 : 245,
    g: palette.tone === "dark" ? 20 : 245,
    b: palette.tone === "dark" ? 24 : 248,
    a: 1,
  };
  return {
    palette,
    accentHue: hues.accentHue,
    accentSoftHue: hues.accentSoftHue,
    neutralHue: hues.neutralHue,
    sourceCanvasLum: estimateSourceCanvasLum(cssSample),
    canvasRgb,
  };
}

function transformCssBlock(css: string, ctx: RecolorContext): string {
  const { css: stripped, holes } = stripDataUris(css);
  let next = recolorCssColors(stripped, ctx);
  next = repairRuleContrast(next, ctx.canvasRgb);
  return restoreDataUris(next, holes);
}

/**
 * Apply theme by hue-preserving recolor of <style> + inline colors.
 */
export function applyStyleColorTheme(
  html: string,
  palette: FiveTokenPalette
): string {
  let next = stripStyleById(html, OVERRIDE_STYLE_ID);
  next = stripStyleById(next, SAFETY_STYLE_ID);

  const styleBlocks: { full: string; css: string }[] = [];
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = styleRe.exec(next))) {
    styleBlocks.push({ full: sm[0], css: sm[1] });
  }

  const cssSample = styleBlocks.map((b) => b.css).join("\n");
  const ctx = buildRecolorContext(palette, cssSample);

  for (let i = styleBlocks.length - 1; i >= 0; i--) {
    const b = styleBlocks[i];
    const remapped = transformCssBlock(b.css, ctx);
    const open = b.full.match(/^<style\b[^>]*>/i)?.[0] ?? "<style>";
    const rebuilt = `${open}${remapped}</style>`;
    const idx = next.lastIndexOf(b.full);
    if (idx >= 0) {
      next = next.slice(0, idx) + rebuilt + next.slice(idx + b.full.length);
    }
  }

  next = next.replace(
    /\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi,
    (_full, q, style: string) => {
      const remapped = transformCssBlock(style, ctx);
      return `style=${q}${remapped}${q}`;
    }
  );

  return ensureMinimalSafety(next, palette);
}
