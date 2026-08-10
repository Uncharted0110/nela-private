import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyThemeFromPrompt } from "../src/app/send/freeformHtmlThemeEdit";

const root = resolve("c:/Users/assas/CODEBASES");
const spain = readFileSync(resolve(root, "artifact.html"), "utf8");
const out = applyThemeFromPrompt(spain, "Change theme to light red").html;
const styles = [...out.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(
  (m, i) => ({ i, id: /id=["']([^"']+)["']/i.exec(m[0])?.[1], css: m[1] })
);
for (const s of styles) {
  console.log("\n==== style", s.i, s.id, "len", s.css.length);
  for (const sel of [
    ".nav ",
    ".nav button",
    ".chips span",
    ".note",
    ".card ",
    ".dest-list li",
    ".kicker",
  ]) {
    const re = new RegExp(
      `(${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{[^}]*\\})`,
      "i"
    );
    const m = s.css.match(re);
    if (m) console.log(sel.trim(), "=>", m[1].replace(/\s+/g, " ").slice(0, 180));
  }
}
