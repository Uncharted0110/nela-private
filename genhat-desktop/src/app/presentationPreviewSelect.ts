/**
 * Preview-only click-to-select for presentation HTML (iframe srcDoc).
 * Injected at preview time — never persisted to the saved artifact.
 */

import { isNelaPresentationDeckHtml } from "./artifactEdit";
import { htmlLooksLikePresentation } from "./htmlToPptx/slideRoots";

export const NELA_SELECT_STYLE_ID = "nela-comp-select-style";
export const NELA_SELECT_SCRIPT_ID = "nela-comp-select-script";

export type SelectedComponentRole =
  | "title"
  | "subtitle"
  | "body"
  | "bullet"
  | "image"
  | "card"
  | "stat"
  | "quote"
  | "chart"
  | "section";

export type SelectedComponentPayload = {
  type: "nela-select-component";
  slideIndex: number;
  role: SelectedComponentRole;
  tagName: string;
  textPreview: string;
  selectorHint: string;
  bulletIndex?: number;
  libId?: number;
  hasImage?: boolean;
  /** 0-based <img> index within the slide when role === "image". */
  imageIndex?: number;
};

export type ComponentTextEditMessage = {
  type: "nela-commit-text-edit";
  slideIndex: number;
  role: SelectedComponentRole | string;
  tagName: string;
  selectorHint: string;
  bulletIndex?: number;
  oldText: string;
  newText: string;
  newInnerHTML?: string;
  /** Full style attribute after in-preview format (color, font, size). */
  style?: string;
};

/** NELA shell or freeform deck with a slide root (`.slide` preferred). */
export function isPresentationPreviewHtml(html: string): boolean {
  if (!html) return false;
  if (isNelaPresentationDeckHtml(html)) return true;
  return htmlLooksLikePresentation(html);
}

function injectInHead(html: string, chunk: string): string {
  const idx = html.lastIndexOf("</head>");
  if (idx >= 0) return html.slice(0, idx) + chunk + html.slice(idx);
  return chunk + html;
}

function injectBeforeBodyClose(html: string, chunk: string): string {
  const idx = html.lastIndexOf("</body>");
  if (idx >= 0) return html.slice(0, idx) + chunk + html.slice(idx);
  return html + chunk;
}

function stripSelectBlocks(html: string): string {
  let out = html;
  for (const id of [NELA_SELECT_STYLE_ID, NELA_SELECT_SCRIPT_ID]) {
    const marker = `id="${id}"`;
    const mi = out.indexOf(marker);
    if (mi < 0) continue;
    const tagStart = out.lastIndexOf("<", mi);
    const isStyle = out
      .slice(tagStart, tagStart + 10)
      .toLowerCase()
      .includes("style");
    const close = isStyle ? "</style>" : "</script>";
    const end = out.indexOf(close, mi);
    if (tagStart >= 0 && end >= 0) {
      out = out.slice(0, tagStart) + out.slice(end + close.length);
    }
  }
  return out;
}

function selectionStyleBlock(): string {
  // Broad hover affordance for freeform + NELA decks; selection outline is .nela-comp-selected.
  return `<style id="${NELA_SELECT_STYLE_ID}">
.nela-comp-selected{outline:2px solid #38bdf8!important;outline-offset:3px!important;box-shadow:0 0 0 4px rgba(56,189,248,.25)!important;cursor:pointer!important}
.nela-select-mode .slide.active :is(h1,h2,h3,h4,p,li,img,article,button,blockquote,figure,figcaption,table,a){cursor:pointer}
.nela-select-mode .slide.active :is(
  .card,.card-box,.detail-card,.highlight-card,.stat-card,.callout,.fact,.stat,.quote,
  .tl-item,.cite,.note,.kicker,.eyebrow,.subtitle,.lead,.intro,.source,
  .number,.day-icon,.stadium-mark,.big,.num,.label,.dot,
  .chip,.tag,.pill,.badge,.title-gradient,.slide-detail,.slide-header,.slide-img-wrap,
  .stat-value,.stat-label,.quote-text,.quote-attr,.quote-mark,.compare-col,
  .hero-img,.feature-img,[data-nela-chart],[data-nela-selectable]
){cursor:pointer}
.nela-select-mode .slide.active :is(.tag-row,.chips,.tags,.pills,.badges) > :is(span,a,button),
.nela-select-mode .slide.active :is(.stat-grid,.stats,.fact-row,.grid3,.timeline,.checklist,.three-points,.day-grid,.cards-grid,.compare-grid,.content-grid,.dest-list) > *{cursor:pointer}
.nela-select-mode .slide.active :is(h1,h2,h3,h4,p,li,img,article,button,blockquote,figure,.card,.card-box,.detail-card,.highlight-card,.stat-card,.callout,.fact,.stat,.quote,.tl-item,.cite,.stadium-mark,.chip,.tag,.pill,.badge,.title-gradient,.slide-detail,.slide-img-wrap,.hero-img,.feature-img,[data-nela-chart]):hover,
.nela-select-mode .slide.active :is(.tag-row,.chips,.tags,.pills,.badges) > :is(span,a,button):hover,
.nela-select-mode .slide.active :is(.stat-grid,.stats,.fact-row,.grid3,.timeline,.checklist,.three-points,.day-grid,.cards-grid,.compare-grid,.content-grid) > *:hover{outline:1px dashed rgba(56,189,248,.7);outline-offset:2px}
.nela-comp-selected[contenteditable="true"]{cursor:text!important;caret-color:#38bdf8}
/* Preview-only: hide persisted library rail unless an image is selected */
#nela-image-library{display:none!important}
#nela-image-library.nela-lib-open{display:flex!important}
@media (max-width:720px){#nela-image-library.nela-lib-open{left:50%;top:auto;bottom:64px;transform:translateX(-50%);width:auto;max-width:92vw;max-height:64px;flex-direction:row;align-items:center}}
</style>`;
}

function selectionScriptBlock(): string {
  // Inline IIFE — no template literals inside that would break the outer TS string.
  return `<script id="${NELA_SELECT_SCRIPT_ID}">
(function(){
  if (window.__nelaCompSelectBound) return;
  window.__nelaCompSelectBound = true;
  document.documentElement.classList.add("nela-select-mode");

  var SELECTED = "nela-comp-selected";

  function activeSlide(){
    var a = document.querySelector(".slide.active, [data-nela-slide].active, [data-slide].active");
    if (a) return a;
    var slides = document.querySelectorAll(".slide-stage > .slide, .slide, [data-nela-slide], [data-slide], .deck-slide, .ppt-slide");
    return slides.length ? slides[0] : null;
  }

  function activeSlideIndex(){
    try {
      if (typeof currentSlide === "number" && currentSlide >= 0) return currentSlide;
    } catch (e) {}
    var slides = document.querySelectorAll(".slide-stage > .slide, .slides-wrapper .slide, .slide, [data-nela-slide], [data-slide], .deck-slide, .ppt-slide");
    var cur = activeSlide();
    if (!cur) return 0;
    for (var i = 0; i < slides.length; i++) {
      if (slides[i] === cur) return i;
    }
    return 0;
  }

  function isIgnored(el){
    if (!el || !el.closest) return true;
    if (el.closest("#nela-image-library,.nela-image-library,[data-nela-no-select]")) {
      return true;
    }
    var slide = activeSlide();
    // Deck chrome (prev/next, footer) — only when outside slide content
    if (el.closest(".deck-footer,.controls,.nav,.deck-nav,#prev,#next")) {
      if (!slide || !slide.contains(el)) return true;
    }
    return false;
  }

  function classHas(el, names){
    if (!el || !el.classList) return false;
    for (var i = 0; i < names.length; i++) {
      if (el.classList.contains(names[i])) return true;
    }
    return false;
  }

  function classNameMatches(el, re){
    if (!el || !el.className || typeof el.className !== "string") return false;
    return re.test(el.className);
  }

  /** Cards / panels from both freeform decks + NELA shell. */
  function isCardLike(el){
    if (classHas(el, [
      "card", "card-box", "detail-card", "highlight-card", "stat-card",
      "callout", "fact", "tl-item", "note"
    ])) return true;
    return classNameMatches(el, /(?:^|\\s)\\S*(?:card|callout|panel|tile|fact)(?:\\S*)?(?:\\s|$)/i);
  }

  function isChipSpan(el){
    var tag = (el.tagName || "").toLowerCase();
    if (tag !== "span" && tag !== "button" && tag !== "a") return false;
    if (classHas(el, ["chip", "tag", "pill", "badge", "cite"])) return true;
    var p = el.parentElement;
    if (!p) return false;
    return classHas(p, [
      "tag-row", "chips", "tags", "pills", "badges", "filters", "topics", "keywords"
    ]) || classNameMatches(p, /(?:chip|tag|pill|badge)/i);
  }

  /** Direct children of known content grids (checklist rows, timeline, stats, etc.). */
  function isGridItem(el){
    var p = el.parentElement;
    if (!p || !p.classList) return false;
    if (!classHas(p, [
      "stat-grid", "stats", "fact-row", "grid3", "timeline", "checklist",
      "three-points", "day-grid", "cards-grid", "compare-grid", "content-grid",
      "dest-list", "bullets-list"
    ])) return false;
    var tag = (el.tagName || "").toLowerCase();
    // Skip pure text wrappers that are only whitespace anchors
    if (tag === "br" || tag === "script" || tag === "style") return false;
    return true;
  }

  function matchesSelectable(el){
    if (!el || el.nodeType !== 1) return false;
    if (isIgnored(el)) return false;
    var tag = (el.tagName || "").toLowerCase();

    // Media / charts
    if (tag === "img" || tag === "svg" || tag === "canvas" || tag === "video" || tag === "table") return true;
    if (tag === "figure" || tag === "figcaption" || tag === "blockquote") return true;
    if (el.hasAttribute("data-nela-chart") || el.hasAttribute("data-nela-img-src") || el.hasAttribute("data-nela-lib-id")) return true;

    // Landmarks
    if (tag === "article" || tag === "button") return true;

    // Chip / tag pills (Architecture, Parks, …) and cite badges
    if (isChipSpan(el)) return true;

    // Explicit component classes from artifact.html + artifact2.html + NELA
    if (classHas(el, [
      // NELA
      "title-gradient", "slide-detail", "slide-header", "slide-img-wrap",
      "card-box", "stat-value", "stat-label", "quote-text", "quote-attr", "quote-mark",
      "compare-col", "bullets-list",
      // artifact.html
      "card", "highlight-card", "stat-card", "fact", "tl-item", "cite", "note",
      "kicker", "subtitle", "chips", "big", "num", "label", "dest-list",
      // artifact2.html
      "detail-card", "callout", "stat", "quote", "stadium-mark", "number", "day-icon",
      "eyebrow", "lead", "intro", "source", "hero-img", "feature-img",
      // shared chip classes
      "chip", "tag", "pill", "badge"
    ])) return true;

    if (isCardLike(el)) return true;
    if (isGridItem(el)) return true;

    // Typography
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "p") return true;
    if (tag === "li") return true;

    // Standalone links that aren't nestled only as chrome (in-slide CTAs)
    if (tag === "a") {
      var p = el.parentElement;
      // Prefer selecting the parent paragraph for source footnotes; still allow lone CTAs
      if (p && (p.tagName || "").toLowerCase() === "p") return false;
      return true;
    }

    return false;
  }

  function findSelectable(start){
    var slide = activeSlide();
    if (!slide || !start) return null;
    var el = start.nodeType === 3 ? start.parentElement : start;

    // Prefer richer parents over tiny markers (A/B letter, timeline dot, day icon)
    var MARKER = /^(number|day-icon|dot|big|num|label)$/;
    if (el && el.classList) {
      for (var mi = 0; mi < el.classList.length; mi++) {
        if (MARKER.test(el.classList[mi])) {
          var up = el.parentElement;
          while (up && up !== slide) {
            if (isCardLike(up) || classHas(up, ["stat", "stat-card", "fact", "tl-item", "article"]) || (up.tagName || "").toLowerCase() === "article") {
              el = up;
              break;
            }
            up = up.parentElement;
          }
          break;
        }
      }
    }

    var node = el;
    while (node && node !== slide) {
      if (matchesSelectable(node)) return node;
      node = node.parentElement;
    }
    // Fallback: direct content child of slide
    if (start && slide.contains(start)) {
      var wrap = start.nodeType === 3 ? start.parentElement : start;
      while (wrap && wrap.parentElement !== slide) {
        wrap = wrap.parentElement;
      }
      if (
        wrap &&
        wrap.parentElement === slide &&
        !isIgnored(wrap) &&
        !(wrap.classList && (
          wrap.classList.contains("deck-footer") ||
          wrap.id === "nela-image-library"
        ))
      ) {
        return wrap;
      }
    }
    return null;
  }

  function clearSelection(){
    var prev = document.querySelectorAll("." + SELECTED);
    for (var i = 0; i < prev.length; i++) prev[i].classList.remove(SELECTED);
  }

  function setLibraryOpen(open){
    var lib = document.getElementById("nela-image-library");
    if (!lib) return;
    if (open) lib.classList.add("nela-lib-open");
    else lib.classList.remove("nela-lib-open");
  }

  function imageIndexFor(el){
    var slide = activeSlide();
    if (!slide) return 0;
    var img = (el.tagName || "").toLowerCase() === "img" ? el : (el.querySelector && el.querySelector("img"));
    if (!img) return 0;
    var imgs = slide.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i] === img) return i;
    }
    return 0;
  }

  function isTextEditableRole(role){
    return role !== "image" && role !== "chart";
  }

  var editState = null; // { el, oldText, oldHTML, oldStyle, role }
  var holdEdit = false;

  function postTextCommit(el, role, oldText){
    var payload = {
      type: "nela-commit-text-edit",
      slideIndex: activeSlideIndex(),
      role: role,
      tagName: (el.tagName || "").toLowerCase(),
      selectorHint: selectorHintFor(el),
      oldText: oldText,
      newText: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim(),
      newInnerHTML: el.innerHTML,
      style: el.getAttribute("style") || ""
    };
    var bi = bulletIndexFor(el);
    if (typeof bi === "number") payload.bulletIndex = bi;
    try {
      parent.postMessage(payload, "*");
    } catch (e) {}
  }

  function applyFormatCommand(cmd, value){
    var el = (editState && editState.el) || document.querySelector("." + SELECTED);
    if (!el) return;
    if (cmd === "foreColor" && value) {
      el.style.setProperty("color", value, "important");
      el.style.setProperty("-webkit-text-fill-color", value, "important");
      var clip = "";
      try {
        var cs = window.getComputedStyle(el);
        clip = String((cs.backgroundClip || "") + " " + (cs.webkitBackgroundClip || "")).toLowerCase();
      } catch (e) {}
      if (clip.indexOf("text") >= 0) {
        el.style.setProperty("background-image", "none", "important");
      }
    } else if (cmd === "fontName" && value) {
      el.style.setProperty("font-family", value, "important");
    } else if (cmd === "fontSizeDelta") {
      var size = 16;
      try {
        size = parseFloat(window.getComputedStyle(el).fontSize) || 16;
      } catch (e) {}
      var next = Math.max(10, Math.min(96, size + (Number(value) || 0)));
      el.style.setProperty("font-size", next + "px", "important");
    } else if (cmd === "bold") {
      var boldNow = false;
      try {
        var w = window.getComputedStyle(el).fontWeight;
        boldNow = w === "bold" || w === "bolder" || parseInt(w, 10) >= 600;
      } catch (e) {}
      el.style.setProperty("font-weight", boldNow ? "400" : "700", "important");
    } else if (cmd === "italic") {
      var italicNow = false;
      try {
        italicNow = window.getComputedStyle(el).fontStyle === "italic";
      } catch (e) {}
      el.style.setProperty("font-style", italicNow ? "normal" : "italic", "important");
    }
    var role = editState ? editState.role : roleFor(el);
    var oldText = editState ? editState.oldText : (el.innerText || el.textContent || "");
    postTextCommit(el, role, oldText);
  }

  function endContentEdit(commit){
    if (!editState) return;
    var el = editState.el;
    var oldText = editState.oldText;
    var oldHTML = editState.oldHTML;
    var oldStyle = editState.oldStyle || "";
    var role = editState.role;
    editState = null;
    try {
      el.removeAttribute("contenteditable");
      el.removeEventListener("blur", onEditBlur);
      el.removeEventListener("keydown", onEditKeydown, true);
    } catch (e) {}
    if (!commit) {
      el.innerHTML = oldHTML;
      if (oldStyle) el.setAttribute("style", oldStyle);
      else el.removeAttribute("style");
      return;
    }
    var newText = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    var oldNorm = (oldText || "").replace(/\\s+/g, " ").trim();
    var style = el.getAttribute("style") || "";
    if (newText === oldNorm && el.innerHTML === oldHTML && style === oldStyle) return;
    postTextCommit(el, role, oldText);
  }

  function onEditBlur(){
    if (holdEdit) {
      try { if (editState && editState.el) editState.el.focus(); } catch (e) {}
      return;
    }
    endContentEdit(true);
  }

  function onEditKeydown(ev){
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      endContentEdit(false);
      selectEl(null);
      return;
    }
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      ev.stopPropagation();
      elBlurCommit();
      return;
    }
    // Keep Space / arrows inside the editor — don't let deck nav see them.
    var k = ev.key;
    if (
      k === " " ||
      k === "Spacebar" ||
      k === "Space" ||
      k === "ArrowLeft" ||
      k === "ArrowRight" ||
      k === "PageUp" ||
      k === "PageDown" ||
      k === "Home" ||
      k === "End"
    ) {
      ev.stopPropagation();
    }
  }

  function elBlurCommit(){
    if (!editState) return;
    try { editState.el.blur(); } catch (e) {}
  }

  function beginContentEdit(el, role){
    endContentEdit(false);
    if (!isTextEditableRole(role)) return;
    editState = {
      el: el,
      oldText: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim(),
      oldHTML: el.innerHTML,
      oldStyle: el.getAttribute("style") || "",
      role: role
    };
    el.setAttribute("contenteditable", "true");
    el.addEventListener("keydown", onEditKeydown, true);
    el.addEventListener("blur", onEditBlur);
    try {
      el.focus();
      var sel = window.getSelection && window.getSelection();
      if (sel) {
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) {}
  }

  function roleFor(el){
    var tag = (el.tagName || "").toLowerCase();
    if (el.hasAttribute("data-nela-chart") || tag === "svg" || tag === "canvas" || tag === "table") return "chart";
    if (
      tag === "img" || tag === "figure" || tag === "video" ||
      classHas(el, ["slide-img-wrap", "hero-img", "feature-img"]) ||
      el.hasAttribute("data-nela-img-src") ||
      el.hasAttribute("data-nela-lib-id")
    ) return "image";
    if (isChipSpan(el) || classHas(el, ["chip", "tag", "pill", "badge", "cite"]) || tag === "button") {
      return "section";
    }
    if (
      tag === "article" || tag === "blockquote" ||
      isCardLike(el) ||
      classHas(el, ["callout", "tl-item"])
    ) return "card";
    if (
      classHas(el, [
        "stat", "stat-card", "stat-value", "stat-label", "fact",
        "number", "day-icon", "stadium-mark", "big", "num", "label"
      ])
    ) return "stat";
    if (classHas(el, ["quote", "quote-text", "quote-attr", "quote-mark"])) return "quote";
    if (tag === "li" || classHas(el, ["dest-list"])) return "bullet";
    if (
      tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" ||
      classHas(el, ["title-gradient", "slide-header"])
    ) return "title";
    if (classHas(el, [
      "slide-detail", "eyebrow", "kicker", "lead", "intro", "subtitle", "source", "note"
    ])) return "subtitle";
    if (tag === "p" || tag === "figcaption") return "body";
    if (classHas(el, ["compare-col"]) || isGridItem(el)) return "section";
    return "section";
  }

  function cssEscapeIdent(s){
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  }

  function selectorHintFor(el){
    var slide = activeSlide();
    var parts = [];
    if (slide) {
      var num = slide.getAttribute("data-num");
      if (num) parts.push('.slide[data-num="' + num + '"]');
      else {
        var idx = activeSlideIndex();
        parts.push(".slide:nth-of-type(" + (idx + 1) + ")");
      }
    }
    var chain = [];
    var node = el;
    while (node && node !== slide && chain.length < 6) {
      var tag = (node.tagName || "").toLowerCase();
      var bit = tag;
      if (node.id) {
        bit = "#" + cssEscapeIdent(node.id);
        chain.unshift(bit);
        break;
      }
      if (node.classList && node.classList.length) {
        var cls = [];
        for (var c = 0; c < Math.min(node.classList.length, 3); c++) {
          var name = node.classList[c];
          if (name === SELECTED || name === "active") continue;
          cls.push("." + cssEscapeIdent(name));
        }
        if (cls.length) bit += cls.join("");
      }
      if (tag === "li" && node.parentElement) {
        var lis = node.parentElement.children;
        var liIdx = 0;
        for (var j = 0; j < lis.length; j++) {
          if (lis[j] === node) { liIdx = j; break; }
        }
        bit += ":nth-child(" + (liIdx + 1) + ")";
      }
      chain.unshift(bit);
      node = node.parentElement;
    }
    return parts.concat(chain).join(" > ");
  }

  function textPreviewFor(el){
    var role = roleFor(el);
    if (role === "image") {
      var img = (el.tagName || "").toLowerCase() === "img" ? el : el.querySelector("img");
      if (img) {
        var alt = img.getAttribute("alt") || "";
        return (alt || "Image").slice(0, 80);
      }
      return "Image";
    }
    var t = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    return t.slice(0, 80);
  }

  function bulletIndexFor(el){
    if ((el.tagName || "").toLowerCase() !== "li") return undefined;
    var parent = el.parentElement;
    if (!parent) return undefined;
    var kids = parent.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === el) return i;
    }
    return undefined;
  }

  function postClear(){
    try {
      parent.postMessage({ type: "nela-select-component", clear: true }, "*");
    } catch (e) {}
  }

  function postSelect(el){
    var role = roleFor(el);
    var payload = {
      type: "nela-select-component",
      slideIndex: activeSlideIndex(),
      role: role,
      tagName: (el.tagName || "").toLowerCase(),
      textPreview: textPreviewFor(el),
      selectorHint: selectorHintFor(el),
      hasImage: role === "image"
    };
    var bi = bulletIndexFor(el);
    if (typeof bi === "number") payload.bulletIndex = bi;
    if (role === "image") {
      var ii = imageIndexFor(el);
      payload.imageIndex = ii;
      try { window.__nelaSelectedImageIndex = ii; } catch (e) {}
    } else {
      try { window.__nelaSelectedImageIndex = 0; } catch (e) {}
    }
    var libAttr =
      el.getAttribute("data-nela-lib-id") ||
      (el.querySelector && el.querySelector("[data-nela-lib-id]")
        ? el.querySelector("[data-nela-lib-id]").getAttribute("data-nela-lib-id")
        : null);
    if (libAttr != null) {
      var libId = parseInt(libAttr, 10);
      if (isFinite(libId)) payload.libId = libId;
    }
    try {
      parent.postMessage(payload, "*");
    } catch (e) {}
  }

  function selectEl(el){
    // Commit any in-progress edit before switching selection
    if (editState && (!el || editState.el !== el)) {
      endContentEdit(true);
    }
    clearSelection();
    if (!el) {
      setLibraryOpen(false);
      try { window.__nelaSelectedImageIndex = 0; } catch (e) {}
      postClear();
      return;
    }
    el.classList.add(SELECTED);
    var role = roleFor(el);
    setLibraryOpen(role === "image");
    postSelect(el);
    if (isTextEditableRole(role)) {
      beginContentEdit(el, role);
    }
  }

  document.addEventListener("click", function(ev){
    if (isIgnored(ev.target)) return;
    // Let image-library buttons keep their own handler
    if (ev.target && ev.target.closest && ev.target.closest("#nela-image-library")) return;
    // Clicks inside the active contentEditable keep focus / don't re-select
    if (editState && editState.el && editState.el.contains(ev.target)) {
      return;
    }
    var slide = activeSlide();
    if (!slide) return;
    if (!slide.contains(ev.target)) {
      // Click outside slide content clears
      if (!(ev.target && ev.target.closest && ev.target.closest(".slide, [data-nela-slide], [data-slide], .deck-slide, .ppt-slide"))) {
        selectEl(null);
      }
      return;
    }
    var hit = findSelectable(ev.target);
    if (!hit) {
      selectEl(null);
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    selectEl(hit);
  }, true);

  document.addEventListener("keydown", function(ev){
    if (ev.key === "Escape") {
      if (editState) {
        endContentEdit(false);
      }
      selectEl(null);
    }
  }, true);

  window.addEventListener("message", function(ev){
    var d = ev && ev.data;
    if (!d || typeof d.type !== "string") return;
    if (d.type === "nela-clear-selection") {
      if (editState) endContentEdit(false);
      selectEl(null);
      return;
    }
    if (d.type === "nela-set-library-visible") {
      setLibraryOpen(!!d.open);
      return;
    }
    if (d.type === "nela-hold-edit") {
      holdEdit = !!d.hold;
      if (holdEdit && editState && editState.el) {
        try { editState.el.focus(); } catch (e) {}
      }
      return;
    }
    if (d.type === "nela-format") {
      applyFormatCommand(d.cmd, d.value);
    }
  });
})();
</script>`;
}

/**
 * Inject selection CSS + script into HTML for iframe srcDoc preview only.
 * Idempotent: strips any prior injection first.
 */
export function injectPresentationSelectionRuntime(html: string): string {
  if (!html || !isPresentationPreviewHtml(html)) return html;
  let out = stripSelectBlocks(html);
  out = injectInHead(out, selectionStyleBlock() + "\n");
  out = injectBeforeBodyClose(out, "\n" + selectionScriptBlock() + "\n");
  return out;
}

const NELA_LIB_GATE_STYLE_ID = "nela-lib-gate-style";

/** Always hide the in-deck image rail in preview unless `.nela-lib-open` is set. */
export function injectPresentationLibraryGate(html: string): string {
  if (!html || !isPresentationPreviewHtml(html)) return html;
  if (!html.includes("nela-image-library")) return html;
  let out = html;
  const marker = `id="${NELA_LIB_GATE_STYLE_ID}"`;
  const mi = out.indexOf(marker);
  if (mi >= 0) {
    const tagStart = out.lastIndexOf("<", mi);
    const end = out.indexOf("</style>", mi);
    if (tagStart >= 0 && end >= 0) {
      out = out.slice(0, tagStart) + out.slice(end + "</style>".length);
    }
  }
  const gate =
    `<style id="${NELA_LIB_GATE_STYLE_ID}">` +
    `#nela-image-library,.nela-image-library{display:none!important}` +
    `#nela-image-library.nela-lib-open,.nela-image-library.nela-lib-open{display:flex!important}` +
    `@media (max-width:720px){#nela-image-library.nela-lib-open,.nela-image-library.nela-lib-open{left:50%;top:auto;bottom:64px;transform:translateX(-50%);width:auto;max-width:92vw;max-height:64px;flex-direction:row;align-items:center}}` +
    `</style>\n`;
  return injectInHead(out, gate);
}

/** Host-side type guard for postMessage payloads. */
export function isSelectComponentMessage(
  data: unknown
): data is SelectedComponentPayload & { clear?: boolean } {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (d.type !== "nela-select-component") return false;
  if (d.clear === true) return true;
  return (
    typeof d.slideIndex === "number" &&
    typeof d.role === "string" &&
    typeof d.tagName === "string" &&
    typeof d.textPreview === "string" &&
    typeof d.selectorHint === "string"
  );
}

export function isTextEditCommitMessage(
  data: unknown
): data is ComponentTextEditMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === "nela-commit-text-edit" &&
    typeof d.slideIndex === "number" &&
    typeof d.tagName === "string" &&
    typeof d.selectorHint === "string" &&
    typeof d.oldText === "string" &&
    typeof d.newText === "string"
  );
}
