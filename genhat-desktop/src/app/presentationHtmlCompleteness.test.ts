import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  completeTruncatedPresentationHtml,
  isIncompletePresentationHtml,
  stitchPresentationHtml,
} from "./presentationHtmlCompleteness.ts";

const twoSlidesOpen = `<!DOCTYPE html><html><head><style>.x{}</style></head><body>
<div class="slide">One</div>
<div class="slide">Two`;

const sixSlidesClosed = `<!DOCTYPE html><html><head><style>.x{}</style></head><body>
${[1, 2, 3, 4, 5, 6].map((n) => `<div class="slide">Slide ${n} content here</div>`).join("\n")}
</body></html>`;

describe("presentation HTML completeness", () => {
  it("flags unclosed html and too few slides", () => {
    assert.equal(
      isIncompletePresentationHtml(twoSlidesOpen, { requestedSlides: 6 }),
      true
    );
    assert.equal(
      isIncompletePresentationHtml(sixSlidesClosed, { requestedSlides: 6 }),
      false
    );
  });

  it("stitches remaining markup onto a cutoff", () => {
    const stitched = stitchPresentationHtml(
      twoSlidesOpen,
      `</div><div class="slide">Three</div></body></html>`
    );
    assert.match(stitched, /Slide 3|Three/);
    assert.match(stitched, /<\/html>/i);
  });

  it("inserts extra slides before a premature </html>", () => {
    const earlyClose = `<!DOCTYPE html><html><body>
<div class="slide">A</div>
<div class="slide">B</div>
</body></html>`;
    const stitched = stitchPresentationHtml(
      earlyClose,
      `<div class="slide">C</div><div class="slide">D</div>`
    );
    assert.match(stitched, />C</);
    assert.ok(stitched.indexOf("C") < stitched.toLowerCase().indexOf("</body>"));
  });

  it("continues until the document closes", async () => {
    const result = await completeTruncatedPresentationHtml({
      html: twoSlidesOpen,
      userRequest: "pitch deck with cost benefit",
      requestedSlides: 6,
      continueOnce: async () =>
        `</div>
<div class="slide">Three</div>
<div class="slide">Four</div>
<div class="slide">Five</div>
<div class="slide">Six</div>
</body></html>`,
    });
    assert.equal(result.continued, true);
    assert.equal(result.stillIncomplete, false);
    assert.equal(isIncompletePresentationHtml(result.html, { requestedSlides: 6 }), false);
  });
});
