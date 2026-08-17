/**
 * Unit tests for prompt-bar artifact edit routing + ask_followup limits.
 * Run: npx --yes tsx --test src/app/artifactEdit.test.ts src/app/send/askFollowUp.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isDataCorrectionWithoutValues,
  isImageEditWithoutSource,
  matchesArtifactEditIntent,
} from "./artifactEdit.js";

describe("matchesArtifactEditIntent with LivePreview target", () => {
  const path = "/tmp/deck.html";

  it("routes concrete slide/reorder prompts without 'this deck'", () => {
    assert.equal(
      matchesArtifactEditIntent("move slide 3 after the title slide", {
        artifactPath: path,
        panelOpen: false,
      }),
      true
    );
  });

  it("routes color-coding and style tweaks on an open artifact", () => {
    assert.equal(
      matchesArtifactEditIntent("color-code the losses in red", {
        artifactPath: "/tmp/sheet.xlsx",
      }),
      true
    );
    assert.equal(
      matchesArtifactEditIntent("make the fonts darker", {
        artifactPath: path,
        panelOpen: true,
      }),
      true
    );
  });

  it("keeps create prompts as non-edits", () => {
    assert.equal(
      matchesArtifactEditIntent(
        "create a new presentation about Spain with 8 slides",
        { artifactPath: path }
      ),
      false
    );
  });

  it("keeps information-seeking as non-edits", () => {
    assert.equal(
      matchesArtifactEditIntent("explain how facebook changed the world", {
        artifactPath: path,
      }),
      false
    );
  });

  it("still requires a target when no LivePreview/attach exists", () => {
    assert.equal(
      matchesArtifactEditIntent("change the theme to midnight", {
        artifactPath: null,
      }),
      false
    );
  });
});

describe("missing-data detectors", () => {
  it("flags data corrections without replacement values", () => {
    assert.equal(
      isDataCorrectionWithoutValues("fix the Q2 revenue figure"),
      true
    );
    assert.equal(
      isDataCorrectionWithoutValues("fix Q2 revenue to 4.2M"),
      false
    );
  });

  it("flags image edits without a source file", () => {
    assert.equal(
      isImageEditWithoutSource("add a photo of a skyline on slide 2"),
      true
    );
    assert.equal(
      isImageEditWithoutSource("add a photo on slide 2", [
        "/tmp/skyline.png",
      ]),
      false
    );
  });
});
