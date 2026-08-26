/**
 * Unit tests for artifact failure classification / friendly errors.
 * Run: npx --yes tsx --test src/app/friendlyError.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COPY } from "./copy.js";
import {
  artifactErrorBannerText,
  classifyArtifactFailure,
  friendlyError,
} from "./friendlyError.js";

describe("classifyArtifactFailure", () => {
  it("maps truncated HTML phrases to truncated copy", () => {
    assert.equal(
      classifyArtifactFailure(
        "Generated HTML was empty or truncated. Try again, shorten the prompt, or use a model with a larger output limit."
      ),
      COPY.errorArtifactTruncated
    );
    assert.equal(
      classifyArtifactFailure("Presentation HTML looks truncated. Try again with a larger output limit."),
      COPY.errorArtifactTruncated
    );
    assert.equal(
      classifyArtifactFailure(
        "Presentation HTML was truncated (styles without slide content). Try again."
      ),
      COPY.errorArtifactTruncated
    );
  });

  it("maps empty / unusable content phrases", () => {
    assert.equal(
      classifyArtifactFailure(
        "Generated HTML has almost no visible content. Try again with a more capable model."
      ),
      COPY.errorArtifactEmpty
    );
    assert.equal(
      classifyArtifactFailure("Generated HTML is missing body content. Try again."),
      COPY.errorArtifactEmpty
    );
  });

  it("maps preview-save failures", () => {
    assert.equal(
      classifyArtifactFailure(
        "Preview is ready but saving failed: Generated HTML was empty or truncated."
      ),
      COPY.errorArtifactSave
    );
  });

  it("maps spreadsheet / CSV failures", () => {
    assert.equal(
      classifyArtifactFailure("Streamed CSV was empty after removing artifact tags"),
      COPY.errorArtifactSpreadsheet
    );
    assert.equal(
      classifyArtifactFailure("Streamed CSV had no header row"),
      COPY.errorArtifactSpreadsheet
    );
  });

  it("does not treat optimistic prose mentioning artifact as a file failure", () => {
    assert.equal(
      classifyArtifactFailure(
        "I apologize — the artifact clearly didn't render properly. Let me rebuild it completely from scratch."
      ),
      null
    );
    assert.equal(
      classifyArtifactFailure("Here is the complete interactive maze explorer with 5 algorithms."),
      null
    );
  });
});

describe("friendlyError artifact mapping", () => {
  it("uses truncated/empty/save taxonomy instead of one blunt line", () => {
    assert.equal(
      friendlyError("Generated HTML was empty or truncated."),
      COPY.errorArtifactTruncated
    );
    assert.equal(
      friendlyError("Generated HTML has almost no visible content."),
      COPY.errorArtifactEmpty
    );
    assert.equal(
      friendlyError("Preview is ready but saving failed: disk error"),
      COPY.errorArtifactSave
    );
  });

  it("does not collapse chat that merely says artifact into errorArtifact", () => {
    const prose =
      "I've put together your artifact as a webpage. Open the panel to preview.";
    // Not an artifact *failure* phrase — falls through to short plain-text handling.
    const out = friendlyError(prose);
    assert.notEqual(out, COPY.errorArtifact);
    assert.notEqual(out, COPY.errorArtifactTruncated);
  });

  it("leaves unrelated network errors unchanged", () => {
    assert.equal(
      friendlyError("error sending request to https://example.com"),
      COPY.errorCloudUnreachable
    );
  });

  it("passes through our COPY lines in full", () => {
    assert.equal(friendlyError(COPY.errorArtifactTruncated), COPY.errorArtifactTruncated);
    assert.equal(friendlyError(COPY.errorArtifactSave), COPY.errorArtifactSave);
  });
});

describe("artifactErrorBannerText", () => {
  it("shows classified short errors as-is", () => {
    assert.equal(
      artifactErrorBannerText(COPY.errorArtifactSave),
      COPY.errorArtifactSave
    );
  });

  it("uses truncated banner for long Error-stage prose", () => {
    const longProse = [
      "I apologize — the artifact clearly didn't render properly.",
      "Let me rebuild it completely from scratch with a clean implementation.",
      "Here is the complete interactive explorer with five algorithms and a solver.",
    ].join("\n\n");
    assert.equal(artifactErrorBannerText(longProse), COPY.errorArtifactTruncated);
  });
});

describe("isPreviewableHtmlDocument", () => {
  it("accepts script-heavy interactive pages that still preview", async () => {
    const { isPreviewableHtmlDocument } = await import("./artifactHtmlOutput.js");
    const html = `<!DOCTYPE html><html><body>
<canvas id="c"></canvas>
<button>Regenerate</button>
<script>${"x".repeat(900)}</script>
</body></html>`;
    assert.equal(isPreviewableHtmlDocument(html), true);
  });

  it("rejects tiny stubs", async () => {
    const { isPreviewableHtmlDocument } = await import("./artifactHtmlOutput.js");
    assert.equal(isPreviewableHtmlDocument("<div>hi</div>"), false);
  });
});
