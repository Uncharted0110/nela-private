/**
 * Freeform HTML theme entrypoints.
 * Coloring uses hue-preserving OKLCH recolor of existing <style> / inline colors
 * (keeps multi-color text; repairs local contrast).
 */

import {
  buildThemePalette,
  buildThemePaletteFromPrompt,
  describePalette,
  resolveThemeBuildInput,
  type FiveTokenPalette,
} from "./themePaletteEngine";
import { applyStyleColorTheme } from "./freeformHtmlStyleColorTheme";

export type FreeformThemePalette = {
  label: string;
  backgroundGradient: string;
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  accent: string;
  accentFrom: string;
  accentTo: string;
  border?: string;
  textOnAccent?: string;
  tone?: string;
  harmony?: string;
};

export function fiveTokenToFreeform(p: FiveTokenPalette): FreeformThemePalette {
  return {
    label: describePalette(p),
    backgroundGradient: p.backgroundGradient,
    bg: p.background,
    surface: p.box,
    text: p.text,
    textMuted: p.textMuted,
    accent: p.accent,
    accentFrom: p.accent,
    accentTo: p.accentSoft,
    border: p.border,
    textOnAccent: p.textOnAccent,
    tone: p.tone,
    harmony: p.harmony,
  };
}

/** Default bluish dark split-complementary palette. */
export const BLUISH_GRADIENT_PALETTE: FreeformThemePalette = fiveTokenToFreeform(
  buildThemePalette({
    label: "blue",
    brandHue: 250,
    tone: "dark",
    harmony: "splitComplementary",
  })
);

/** Apply a full FiveTokenPalette by remapping colors in the artifact CSS. */
export function applyFiveTokenThemeToHtml(
  html: string,
  palette: FiveTokenPalette
): string {
  return applyStyleColorTheme(html, palette);
}

/**
 * Apply theme from a FreeformThemePalette-shaped object (edit path compatibility).
 */
export function applyFreeformThemePalette(
  html: string,
  palette: FreeformThemePalette
): string {
  const fromPrompt = buildThemePaletteFromPrompt(palette.label || "blue");
  const merged: FiveTokenPalette = {
    ...fromPrompt,
    background: palette.bg || fromPrompt.background,
    box: palette.surface || fromPrompt.box,
    text: palette.text || fromPrompt.text,
    textMuted: palette.textMuted || fromPrompt.textMuted,
    accent: palette.accent || fromPrompt.accent,
    accentSoft: palette.accentTo || fromPrompt.accentSoft,
    border: palette.border || fromPrompt.border,
    textOnAccent: palette.textOnAccent || fromPrompt.textOnAccent,
    backgroundGradient:
      palette.backgroundGradient || fromPrompt.backgroundGradient,
  };
  return applyFiveTokenThemeToHtml(html, merged);
}

/** Apply theme inferred directly from a natural-language prompt. */
export function applyThemeFromPrompt(
  html: string,
  prompt: string
): {
  html: string;
  palette: FiveTokenPalette;
} {
  const palette = buildThemePaletteFromPrompt(prompt);
  return { html: applyFiveTokenThemeToHtml(html, palette), palette };
}

export function isTextContrastFixRequest(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    /\b(text\s*colou?rs?|font\s*colou?rs?|contrast|readable|legible|not visible|can't see|cannot see|hard to read|invisible|opposite|complementary|color\s*wheel|oklch|harmony)\b/i.test(
      lower
    ) ||
    (/\b(text|font|copy|headings?|bullets?)\b/.test(lower) &&
      /\b(colou?rs?|white|light|bright)\b/.test(lower))
  );
}

/** Map theme asks onto a freeform-shaped palette (for callers expecting FreeformThemePalette). */
export function freeformPaletteFromPrompt(
  prompt: string
): FreeformThemePalette | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;
  if (
    !/\b(theme|background|palette|colou?rs?|gradient|style|styling|orange|blue|green|red|purple|pink|teal|yellow|sunset|dark|light)\b/i.test(
      trimmed
    ) &&
    !isTextContrastFixRequest(trimmed)
  ) {
    return null;
  }
  return fiveTokenToFreeform(buildThemePaletteFromPrompt(trimmed));
}

/** @deprecated kept for older imports — use buildThemePaletteFromPrompt */
export function complementaryTextForBg(bgHex: string): {
  text: string;
  textMuted: string;
  accent: string;
} {
  const p = buildThemePalette({
    label: "derived",
    brandHue: 250,
    tone: "dark",
    harmony: "splitComplementary",
  });
  void bgHex;
  return { text: p.text, textMuted: p.textMuted, accent: p.accent };
}

export { buildThemePaletteFromPrompt, describePalette, resolveThemeBuildInput };
