import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attachmentFileName,
  attachmentKindLabel,
  formatAttachmentSize,
  sameAttachmentPath,
} from "./attachmentDisplay.ts";

describe("attachment display labels", () => {
  it("prefers the inspected file name over the path", () => {
    assert.equal(
      attachmentFileName("/tmp/tmp-abc.docx", "Business case.docx"),
      "Business case.docx"
    );
    assert.equal(
      attachmentFileName("/home/amogh/slides.pptx"),
      "slides.pptx"
    );
  });

  it("uses short type labels instead of Office MIME subtypes", () => {
    assert.equal(
      attachmentKindLabel({
        name: "memo.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        kind: "extracted_text",
      }),
      "Word"
    );
    assert.equal(
      attachmentKindLabel({
        name: "deck.pptx",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        kind: "extracted_text",
      }),
      "PowerPoint"
    );
    assert.equal(formatAttachmentSize(561 * 1024), "561 KB");
  });

  it("treats slash and backslash paths as the same file", () => {
    assert.equal(
      sameAttachmentPath("/tmp/deck.pptx", "/tmp/deck.pptx"),
      true
    );
    assert.equal(
      sameAttachmentPath("C:\\docs\\deck.pptx", "C:/docs/deck.pptx"),
      true
    );
  });
});
