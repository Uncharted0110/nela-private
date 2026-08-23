import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IN_H,
  IN_W,
  cssColorToHex,
  letterboxFrame,
  pxToPt,
  rectToInches,
} from "./geometry.ts";
import {
  htmlLooksLikePresentation,
  isMediaHostSelectorMatch,
  isTextHostTag,
} from "./slideRoots.ts";
import { isNestedTextHost } from "./textHosts.ts";
import {
  cssNeedsRaster,
  isBackgroundClipText,
  isHiddenComputed,
  isOpaqueCssColor,
  parseLinearGradient,
} from "./cssFill.ts";
import { insetRectByPadding } from "./walkSlide.ts";
import { slideIrLooksCollapsed } from "./irQuality.ts";

describe("htmlToPptx geometry", () => {
  it("maps 16:9 slides to full-bleed inches", () => {
    const f = letterboxFrame(1920, 1080);
    assert.ok(Math.abs(f.offsetX) < 0.02);
    assert.ok(Math.abs(f.offsetY) < 0.02);
    assert.ok(Math.abs(f.contentW - IN_W) < 0.02);
    assert.ok(Math.abs(f.contentH - IN_H) < 0.02);
    const box = rectToInches({ x: 0, y: 0, w: 1920, h: 1080 }, f);
    assert.ok(Math.abs(box.w - IN_W) < 0.05);
    assert.ok(Math.abs(box.h - IN_H) < 0.05);
  });

  it("letterboxes a taller-than-16:9 slide without stretching", () => {
    const f = letterboxFrame(800, 800);
    assert.ok(f.offsetX > 0.5);
    assert.ok(Math.abs(f.offsetY) < 0.05);
    assert.ok(f.contentW < IN_W);
    const box = rectToInches({ x: 0, y: 0, w: 800, h: 800 }, f);
    assert.ok(Math.abs(box.w - box.h) < 0.05);
  });

  it("converts px and CSS colors", () => {
    assert.equal(pxToPt(16), 12);
    assert.equal(cssColorToHex("#2D429B"), "2d429b");
    assert.equal(cssColorToHex("rgb(14, 80, 113)"), "0e5071");
    assert.equal(cssColorToHex("transparent", ""), "");
  });
});

describe("htmlToPptx slide roots and text hosts", () => {
  it("detects .slide and data-nela-slide as presentation HTML", () => {
    assert.equal(htmlLooksLikePresentation('<div class="slide">x</div>'), true);
    assert.equal(
      htmlLooksLikePresentation('<section data-nela-slide>x</section>'),
      true
    );
    assert.equal(htmlLooksLikePresentation("<p>hello</p>"), false);
  });

  it("classifies text vs media host tags", () => {
    assert.equal(isTextHostTag("H2"), true);
    assert.equal(isTextHostTag("div"), false);
    assert.equal(
      isMediaHostSelectorMatch({ tagName: "SVG" }),
      true
    );
    assert.equal(
      isMediaHostSelectorMatch({
        tagName: "DIV",
        className: "echarts",
        hasAttribute: () => false,
      }),
      true
    );
    assert.equal(
      isMediaHostSelectorMatch({
        tagName: "DIV",
        className: "card",
        hasAttribute: () => false,
      }),
      false
    );
  });

  it("treats li as a top-level text host inside ul, not nested in p", () => {
    const slide = { tagName: "DIV" } as unknown as Element;
    const ul = { tagName: "UL", parentElement: slide } as unknown as Element;
    const li = { tagName: "LI", parentElement: ul } as unknown as Element;
    Object.assign(ul, { parentElement: slide });
    Object.assign(li, { parentElement: ul });
    assert.equal(isNestedTextHost(li, slide), false);

    const p = { tagName: "P", parentElement: slide } as unknown as Element;
    const spanHost = { tagName: "P", parentElement: p } as unknown as Element;
    assert.equal(isNestedTextHost(spanHost, slide), true);
  });
});

describe("htmlToPptx CSS fill mapping", () => {
  it("parses linear-gradient stops and angle", () => {
    const g = parseLinearGradient(
      "linear-gradient(180deg, #2D429B 0%, #0E5071 55%, #ffffff 100%)"
    );
    assert.ok(g);
    assert.equal(g!.angle, 180);
    assert.equal(g!.colors[0]?.color, "2d429b");
    assert.equal(g!.colors[2]?.color, "ffffff");
  });

  it("flags radial gradients and filters for raster, not linear", () => {
    assert.equal(
      cssNeedsRaster({
        backgroundImage: "linear-gradient(90deg, #000 0%, #fff 100%)",
        filter: "none",
        mixBlendMode: "normal",
        clipPath: "none",
        transform: "none",
      }),
      false
    );
    assert.equal(
      cssNeedsRaster({
        backgroundImage: "radial-gradient(circle, #000 0%, #fff 100%)",
        filter: "none",
        mixBlendMode: "normal",
        clipPath: "none",
        transform: "none",
      }),
      true
    );
    assert.equal(
      cssNeedsRaster({
        backgroundImage: "none",
        filter: "blur(4px)",
        mixBlendMode: "normal",
        clipPath: "none",
        transform: "none",
      }),
      true
    );
  });

  it("treats hidden and transparent fills correctly", () => {
    assert.equal(isHiddenComputed("hidden", "block", "1"), true);
    assert.equal(isHiddenComputed("visible", "none", "1"), true);
    assert.equal(isHiddenComputed("visible", "block", "0"), true);
    assert.equal(isHiddenComputed("visible", "block", "1"), false);
    assert.equal(isOpaqueCssColor("transparent"), false);
    assert.equal(isOpaqueCssColor("rgb(45, 66, 155)"), true);
  });

  it("detects background-clip:text", () => {
    assert.equal(isBackgroundClipText({ backgroundClip: "text" }), true);
    assert.equal(isBackgroundClipText({ webkitBackgroundClip: "text" }), true);
    assert.equal(isBackgroundClipText({ backgroundClip: "border-box" }), false);
  });
});

describe("htmlToPptx IR quality", () => {
  it("insets padding from text boxes", () => {
    const box = insetRectByPadding(
      { x: 10, y: 20, w: 200, h: 80 },
      {
        paddingLeft: "8px",
        paddingRight: "12px",
        paddingTop: "4px",
        paddingBottom: "6px",
      } as CSSStyleDeclaration
    );
    assert.equal(box.x, 18);
    assert.equal(box.y, 24);
    assert.equal(box.w, 180);
    assert.equal(box.h, 70);
  });

  it("flags left-collapsed walks and empty IR", () => {
    assert.equal(slideIrLooksCollapsed([], 1280, 720), true);
    const leftDump = [0, 1, 2, 3].map((i) => ({
      kind: "text" as const,
      rect: { x: 20, y: 80 + i * 40, w: 180, h: 30 },
      text: "x",
      fontSizePt: 14,
      fontFace: "Arial",
      bold: false,
      italic: false,
      color: "111111",
      align: "left" as const,
    }));
    assert.equal(slideIrLooksCollapsed(leftDump, 1280, 720), true);
    const spread = [
      {
        kind: "text" as const,
        rect: { x: 100, y: 80, w: 1080, h: 60 },
        text: "Title",
        fontSizePt: 28,
        fontFace: "Arial",
        bold: true,
        italic: false,
        color: "111111",
        align: "left" as const,
      },
      {
        kind: "text" as const,
        rect: { x: 100, y: 200, w: 1080, h: 200 },
        text: "Body",
        fontSizePt: 16,
        fontFace: "Arial",
        bold: false,
        italic: false,
        color: "111111",
        align: "left" as const,
      },
    ];
    assert.equal(slideIrLooksCollapsed(spread, 1280, 720), false);
  });
});
