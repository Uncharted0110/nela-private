/**
 * Spot-check artifact2 light theme: intro text + gold image offset visible.
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

const root = resolve("c:/Users/assas/CODEBASES");
const bcn = readFileSync(resolve(root, "artifact2.html"), "utf8");
const out = applyThemeFromPrompt(bcn, "Make it a light day theme").html;
const css = [...out.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
  .map((m) => m[1])
  .join("\n");

const intro = css.match(/\.intro\s*,\s*p\s*,\s*li\s*\{[^}]*\}/i)?.[0] ?? "";
const goldDef = css.match(/--gold\s*:\s*([^;]+)/i)?.[1] ?? "";
const creamDef = css.match(/--cream\s*:\s*([^;]+)/i)?.[1] ?? "";
const hero = css.match(/\.hero-img[^{]*\{[^}]*\}/i)?.[0] ?? "";

console.log("intro rule:", intro.slice(0, 160));
console.log("gold:", goldDef.trim(), "cream:", creamDef.trim());
console.log("hero:", hero.slice(0, 200));

const introColor = intro.match(/color\s*:\s*([^;]+)/i)?.[1];
const introTok = introColor?.match(/#(?:[0-9a-f]{3,8})\b|rgba?\([^)]+\)/i)?.[0];
const creamTok = creamDef.match(/#(?:[0-9a-f]{3,8})\b/i)?.[0];
const goldTok = goldDef.match(/#(?:[0-9a-f]{3,8})\b/i)?.[0];

assert(introTok, "intro color missing");
assert(creamTok, "cream missing");
assert(goldTok, "gold missing");

const fg = parseCssColor(introTok!)!;
const cream = parseCssColor(creamTok!)!;
const gold = parseCssColor(goldTok!)!;
const bgApprox = parseCssColor("#e8eef0") ?? cream;

const textRatio = contrastRatio(fg, cream);
const shapeRatio = contrastRatio(gold, cream);
console.log("text contrast vs cream", textRatio.toFixed(2));
console.log("gold contrast vs cream", shapeRatio.toFixed(2));

assert(textRatio >= 4.5, `intro text contrast ${textRatio} too low`);
assert(shapeRatio >= 1.8, `gold shape contrast ${shapeRatio} too low`);
assert(/box-shadow/i.test(hero), "hero box-shadow missing");

// Also dark pass shouldn't kill gold visibility on dark canvas
const dark = applyThemeFromPrompt(bcn, "Change theme to dark blue").html;
const dcss = [...dark.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
  .map((m) => m[1])
  .join("\n");
const dIntro = dcss.match(/\.intro\s*,\s*p\s*,\s*li\s*\{[^}]*\}/i)?.[0] ?? "";
const dFgTok = dIntro.match(/color\s*:\s*([^;]+)/i)?.[1]?.match(/#[0-9a-f]{3,8}/i)?.[0];
const dBg = parseCssColor("#120508")!;
const dFg = parseCssColor(dFgTok!)!;
const dRatio = contrastRatio(dFg, dBg);
console.log("dark intro contrast", dRatio.toFixed(2), dFgTok);
assert(dRatio >= 4.5, `dark intro contrast ${dRatio}`);

console.log("artifact2 contrast spotcheck passed");
