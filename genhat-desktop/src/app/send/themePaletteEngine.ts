/**
 * Dual theme engine:
 * - HSL harmony picks neutralHue / accentHue for variety
 * - OKLCH 5-token matrix locks L/C for Background, Text, Boxes, Borders, Accent
 */

export type ThemeTone = "light" | "dark";
export type HarmonyMode =
  | "analogous"
  | "complementary"
  | "splitComplementary"
  | "triadic"
  | "monochrome";

export type ThemeBuildInput = {
  label: string;
  brandHue: number;
  tone: ThemeTone;
  harmony: HarmonyMode;
};

export type FiveTokenPalette = {
  label: string;
  tone: ThemeTone;
  harmony: HarmonyMode;
  brandHue: number;
  neutralHue: number;
  accentHue: number;
  /** Token 1 */
  background: string;
  /** Token 2 */
  text: string;
  /** Soft secondary text (slightly less extreme L). */
  textMuted: string;
  /** Token 3 */
  box: string;
  /** Token 4 */
  border: string;
  /** Token 5 */
  accent: string;
  /** Soft accent for glows / gradients. */
  accentSoft: string;
  /** Text sitting on accent fills. */
  textOnAccent: string;
  backgroundGradient: string;
  accentGradient: string;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function wrapHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/** Stable string hash for unnamed theme seeds. */
export function hashString(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

const BRAND_HUES: { match: RegExp; hue: number; label: string }[] = [
  { match: /\borange\b|\btangerine\b|\bamber\b/i, hue: 55, label: "orange" },
  { match: /\byellow\b|\bgold\b/i, hue: 95, label: "yellow" },
  { match: /\bgreen\b|\bemerald\b|\bforest\b/i, hue: 145, label: "green" },
  { match: /\bteal\b|\bcyan\b|\baqua\b/i, hue: 195, label: "teal" },
  {
    match:
      /\bblue\b|\bbluish\b|\bblueish\b|\bocean\b|\bazure\b|\bmarine\b|\bsky\b/i,
    hue: 250,
    label: "blue",
  },
  {
    match: /\bpurple\b|\bviolet\b|\blavender\b/i,
    hue: 300,
    label: "purple",
  },
  { match: /\bpink\b|\brose\b|\bmagenta\b/i, hue: 350, label: "pink" },
  { match: /\bred\b|\bcrimson\b|\bscarlet\b/i, hue: 25, label: "red" },
  { match: /\bsunset\b|\bwarm\b/i, hue: 45, label: "sunset" },
  {
    match: /\bgrey\b|\bgray\b|\bslate\b|\bneutral\b|\bmono\b/i,
    hue: 250,
    label: "slate",
  },
];

export function parseBrandFromPrompt(prompt: string): {
  hue: number;
  label: string;
} {
  const lower = prompt.toLowerCase();
  for (const entry of BRAND_HUES) {
    if (entry.match.test(lower)) {
      return { hue: entry.hue, label: entry.label };
    }
  }
  const hue = hashString(lower.trim() || "theme") % 360;
  return { hue, label: "custom" };
}

export function parseToneFromPrompt(prompt: string): ThemeTone {
  const lower = prompt.toLowerCase();
  if (/\b(light|minimal|white|bright\s+mode|day)\b/.test(lower)) return "light";
  if (/\b(dark|midnight|night)\b/.test(lower)) return "dark";
  return "dark";
}

export function parseHarmonyFromPrompt(prompt: string): HarmonyMode {
  const lower = prompt.toLowerCase();
  if (/\b(mono|monochrome|minimal|neutral|slate)\b/.test(lower)) {
    return "monochrome";
  }
  if (/\b(calm|soft|pastel|gentle|analogous)\b/.test(lower)) {
    return "analogous";
  }
  if (/\b(vibrant|bold|neon|punchy|triadic)\b/.test(lower)) {
    return "triadic";
  }
  if (/\b(high\s*contrast|complementary|opposite)\b/.test(lower)) {
    return "complementary";
  }
  if (/\b(split)\b/.test(lower)) return "splitComplementary";
  // Named chromatic brands default to split-complementary variety.
  if (BRAND_HUES.some((e) => e.match.test(lower) && e.label !== "slate")) {
    return "splitComplementary";
  }
  return "splitComplementary";
}

export function resolveThemeBuildInput(prompt: string): ThemeBuildInput {
  const brand = parseBrandFromPrompt(prompt);
  return {
    label: brand.label,
    brandHue: brand.hue,
    tone: parseToneFromPrompt(prompt),
    harmony: parseHarmonyFromPrompt(prompt),
  };
}

/** HSL harmony → neutral + accent hues. */
export function resolveHarmonyHues(
  seedHue: number,
  mode: HarmonyMode
): { neutralHue: number; accentHue: number; accentSoftHue: number } {
  const seed = wrapHue(seedHue);
  switch (mode) {
    case "analogous":
      return {
        neutralHue: seed,
        accentHue: wrapHue(seed + 30),
        accentSoftHue: wrapHue(seed - 30),
      };
    case "complementary":
      return {
        neutralHue: seed,
        accentHue: wrapHue(seed + 180),
        accentSoftHue: wrapHue(seed + 150),
      };
    case "triadic":
      return {
        neutralHue: seed,
        accentHue: wrapHue(seed + 120),
        accentSoftHue: wrapHue(seed + 240),
      };
    case "monochrome":
      return {
        neutralHue: seed,
        accentHue: seed,
        accentSoftHue: seed,
      };
    case "splitComplementary":
    default:
      return {
        neutralHue: seed,
        accentHue: wrapHue(seed + 150),
        accentSoftHue: wrapHue(seed - 150),
      };
  }
}

// ── OKLCH ↔ sRGB ────────────────────────────────────────────────────────────

export type Oklch = { l: number; c: number; h: number };

function oklchToLinearSrgb(l: number, c: number, hDeg: number): {
  r: number;
  g: number;
  b: number;
} {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  return {
    r: +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    g: -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    b: -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  };
}

function linearToSrgb(x: number): number {
  const v = clamp(x, 0, 1);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function srgbToLinear(x: number): number {
  const v = clamp(x, 0, 1);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function inGamut(r: number, g: number, b: number): boolean {
  const eps = 1e-3;
  return (
    r >= -eps &&
    r <= 1 + eps &&
    g >= -eps &&
    g <= 1 + eps &&
    b >= -eps &&
    b <= 1 + eps
  );
}

/** Convert OKLCH to #rrggbb, reducing chroma until in sRGB gamut. */
export function oklchToHex(l: number, c: number, h: number): string {
  let chroma = Math.max(0, c);
  for (let i = 0; i < 12; i++) {
    const { r, g, b } = oklchToLinearSrgb(l, chroma, h);
    if (inGamut(r, g, b) || chroma < 0.002) {
      const to = (n: number) =>
        Math.round(clamp(linearToSrgb(n), 0, 1) * 255)
          .toString(16)
          .padStart(2, "0");
      return `#${to(r)}${to(g)}${to(b)}`;
    }
    chroma *= 0.85;
  }
  const { r, g, b } = oklchToLinearSrgb(l, 0, h);
  const to = (n: number) =>
    Math.round(clamp(linearToSrgb(n), 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Convert 0–255 sRGB channels to OKLCH. */
export function rgbToOklch(r255: number, g255: number, b255: number): Oklch {
  const r = srgbToLinear(r255 / 255);
  const g = srgbToLinear(g255 / 255);
  const b = srgbToLinear(b255 / 255);

  const l_ = Math.cbrt(
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  );
  const m_ = Math.cbrt(
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  );
  const s_ = Math.cbrt(
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  );

  const l = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bLab = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const c = Math.sqrt(a * a + bLab * bLab);
  let h = (Math.atan2(bLab, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: clamp(l, 0, 1), c: Math.max(0, c), h: c < 1e-6 ? 0 : wrapHue(h) };
}

export { wrapHue };

function tokenMatrix(tone: ThemeTone): {
  bg: Oklch;
  text: Oklch;
  textMuted: Oklch;
  box: Oklch;
  border: Oklch;
  accent: Oklch;
} {
  if (tone === "light") {
    return {
      bg: { l: 0.98, c: 0.01, h: 0 },
      text: { l: 0.2, c: 0.01, h: 0 },
      textMuted: { l: 0.35, c: 0.02, h: 0 },
      box: { l: 0.93, c: 0.02, h: 0 },
      border: { l: 0.83, c: 0.03, h: 0 },
      accent: { l: 0.6, c: 0.22, h: 0 },
    };
  }
  return {
    bg: { l: 0.12, c: 0.02, h: 0 },
    text: { l: 0.9, c: 0.01, h: 0 },
    textMuted: { l: 0.75, c: 0.03, h: 0 },
    box: { l: 0.17, c: 0.02, h: 0 },
    border: { l: 0.27, c: 0.03, h: 0 },
    accent: { l: 0.6, c: 0.22, h: 0 },
  };
}

function textOnAccentHex(accentHue: number): string {
  // Accent is locked at L=0.60 → prefer near-black for projection safety.
  return oklchToHex(0.12, 0.01, accentHue);
}

/**
 * Build the full functional palette from brand hue + tone + harmony.
 */
export function buildThemePalette(input: ThemeBuildInput): FiveTokenPalette {
  const hues = resolveHarmonyHues(input.brandHue, input.harmony);
  const m = tokenMatrix(input.tone);

  const background = oklchToHex(m.bg.l, m.bg.c, hues.neutralHue);
  const text = oklchToHex(m.text.l, m.text.c, hues.neutralHue);
  const textMuted = oklchToHex(m.textMuted.l, m.textMuted.c, hues.neutralHue);
  const box = oklchToHex(m.box.l, m.box.c, hues.neutralHue);
  const border = oklchToHex(m.border.l, m.border.c, hues.neutralHue);
  const accent = oklchToHex(m.accent.l, m.accent.c, hues.accentHue);
  const accentSoft = oklchToHex(
    m.accent.l,
    Math.min(0.14, m.accent.c * 0.55),
    hues.accentSoftHue
  );
  const textOnAccent = textOnAccentHex(hues.accentHue);

  const bgMid = oklchToHex(
    input.tone === "light" ? 0.95 : 0.14,
    input.tone === "light" ? 0.015 : 0.025,
    hues.neutralHue
  );

  return {
    label: input.label,
    tone: input.tone,
    harmony: input.harmony,
    brandHue: wrapHue(input.brandHue),
    neutralHue: hues.neutralHue,
    accentHue: hues.accentHue,
    background,
    text,
    textMuted,
    box,
    border,
    accent,
    accentSoft,
    textOnAccent,
    backgroundGradient: `linear-gradient(145deg, ${background} 0%, ${bgMid} 48%, ${box} 100%)`,
    accentGradient: `linear-gradient(135deg, ${accent} 0%, ${accentSoft} 100%)`,
  };
}

export function buildThemePaletteFromPrompt(prompt: string): FiveTokenPalette {
  return buildThemePalette(resolveThemeBuildInput(prompt));
}

export function describePalette(p: FiveTokenPalette): string {
  return `${p.label} (OKLCH 5-token, ${p.tone}, ${kebabHarmony(p.harmony)})`;
}

function kebabHarmony(h: HarmonyMode): string {
  switch (h) {
    case "splitComplementary":
      return "split-complementary";
    case "monochrome":
      return "monochrome";
    default:
      return h;
  }
}
