/**
 * Validate hue-preserving theme recolor on artifact.html / artifact2.html
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyThemeFromPrompt } from "../src/app/send/freeformHtmlThemeEdit";
import {
  contrastRatio,
  parseCssColor,
} from "../src/app/send/freeformHtmlStyleColorTheme";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function styleBodies(html: string): string[] {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(
    (m) => m[1]
  );
}

function ruleFor(css: string, sel: string): string | null {
  const re = new RegExp(
    `(${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{[^}]*\\})`,
    "i"
  );
  return css.match(re)?.[1] ?? null;
}

function colorsIn(rule: string): string[] {
  return [...rule.matchAll(/#(?:[0-9a-f]{3,8})\b|rgba?\([^)]+\)/gi)].map(
    (m) => m[0]
  );
}

function distinctHexCount(css: string): number {
  const set = new Set(
    [...css.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase())
  );
  return set.size;
}

function checkDeck(label: string, html: string, prompt: string) {
  const out = applyThemeFromPrompt(html, prompt).html;
  assert(!/nela-theme-override/i.test(out), `${label}: override should be gone`);
  assert(/nela-theme-safety/i.test(out), `${label}: safety missing`);

  const css = styleBodies(out).join("\n");
  const distinct = distinctHexCount(css);
  assert(
    distinct >= 6,
    `${label}: expected multi-color palette, got ${distinct} unique hexes`
  );

  // Shadows: keep soft rgba when present; otherwise solid offset shadows (artifact2).
  const hasRgbaShadow = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0?\.\d+/i.test(
    css
  );
  const hasBoxShadow = /box-shadow\s*:/i.test(css);
  assert(
    hasRgbaShadow || hasBoxShadow,
    `${label}: expected shadows to remain`
  );

  const deckCss = styleBodies(out).find((s) => !/nela-theme-safety/i.test(s)) ?? css;

  for (const sel of [".chips span", ".nav button", ".controls button"]) {
    const rule = ruleFor(deckCss, sel);
    if (!rule) continue;
    const bg = rule.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1];
    const fg = rule.match(/(?<![-\w])color\s*:\s*([^;]+)/i)?.[1];
    const bgC = bg?.match(/#(?:[0-9a-f]{3,8})\b|rgba?\([^)]+\)/i)?.[0];
    const fgC = fg?.match(/#(?:[0-9a-f]{3,8})\b|rgba?\([^)]+\)/i)?.[0];
    if (!bgC || !fgC) continue;
    const b = parseCssColor(bgC);
    const f = parseCssColor(fgC);
    if (!b || !f) continue;
    const ratio = contrastRatio(f, b);
    assert(
      ratio >= 3,
      `${label}: ${sel} contrast ${ratio.toFixed(2)} too low (${fgC} on ${bgC})`
    );
  }

  const note = ruleFor(deckCss, ".note");
  if (note) {
    assert(!/border\s*:\s*1px/i.test(note), `${label}: .note should not gain border`);
  }

  console.log(`OK ${label} (${prompt}) distinctHex=${distinct}`);
  return out;
}

const root = resolve("c:/Users/assas/CODEBASES");
const spain = readFileSync(resolve(root, "artifact.html"), "utf8");
const bcn = readFileSync(resolve(root, "artifact2.html"), "utf8");

checkDeck("spain", spain, "Change theme to light red");
checkDeck("spain", spain, "Change theme to dark blue");
const mid = checkDeck("spain", spain, "Change theme to light red");
checkDeck("spain-idempotent", mid, "Change theme to blue");
checkDeck("artifact2", bcn, "Change theme to light blue");
checkDeck("artifact2", bcn, "Change theme to dark orange");

console.log("Hue-preserving theme validations passed.");
