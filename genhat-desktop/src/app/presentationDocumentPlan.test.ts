import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPresentationFallbackPlan,
  extractRequestedDeckOutline,
  extractUserStatedFacts,
  isLikelyDeckTemplate,
  looksLikeInstructionPrompt,
} from "./presentationDocumentPlan.ts";

const PROMPT =
  "create a meaningful pitch deck including solid business justification and also cost benefit analysis and well highlighting what's missing in PTES PTES does not have data hydration, detailed test results analysis, scripts have to copy pasted from vscode to PTES application and then saved, no direct pull from git for example Also use this taru_avocette_slide_template template to create ppt";

const SOURCE = `
File: "Strengthening Quality Engineering Capabilities.pptx" (Path: /tmp/qe.pptx)
Content:
SITUATION Quality Engineering — Situation Today's approach relies on script automation, with manual effort spanning functional, SIT, regression and smoke testing. PTES is the current tool.
Strategic Opportunities & Business Value Move beyond script automation toward a reusable quality engineering capability
Introduce intelligent test-data hydration and results analysis
Reduce manual effort while improving coverage, consistency and release confidence
`;

describe("presentation fallback vs user brief", () => {
  it("pulls pitch beats and PTES gaps from the user prompt", () => {
    const outline = extractRequestedDeckOutline(PROMPT);
    assert.ok(outline.includes("Business Justification"));
    assert.ok(outline.includes("Cost–Benefit Analysis"));
    assert.ok(outline.includes("Gaps vs Current Tooling"));
    const facts = extractUserStatedFacts(PROMPT);
    assert.ok(facts.some((f) => /hydrat/i.test(f)));
    assert.ok(facts.some((f) => /git/i.test(f)));
  });

  it("does not use the raw instruction prompt as the title", () => {
    assert.equal(looksLikeInstructionPrompt(PROMPT.slice(0, 80)), true);
    const plan = buildPresentationFallbackPlan({
      userPrompt: PROMPT,
      ambientContent: SOURCE,
      targetSlideCount: 6,
    });
    assert.ok(plan);
    const slides = plan.slides as Array<{ title: string; bullets?: string[] }>;
    const titles = slides.map((s) => s.title);
    assert.equal(
      titles.some((t) => /inculdign|justifcation|Key Details/i.test(t)),
      false
    );
    assert.ok(titles.includes("Business Justification"));
    assert.ok(titles.includes("Gaps vs Current Tooling"));
    const gap = slides.find((s) => s.title === "Gaps vs Current Tooling");
    assert.ok(gap?.bullets?.some((b) => /git|hydrat|VS Code/i.test(b)));
  });

  it("treats named HTML templates as design, not source dumps", () => {
    assert.equal(
      isLikelyDeckTemplate(
        "/tmp/taru_avocette_slide_template.html",
        '<div class="slide">x</div>',
        PROMPT
      ),
      true
    );
    assert.equal(
      isLikelyDeckTemplate(
        "/tmp/Strengthening Quality Engineering Capabilities.pptx",
        "SITUATION Quality Engineering",
        PROMPT
      ),
      false
    );
  });
});
