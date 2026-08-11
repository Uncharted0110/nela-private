/**
 * Persistent in-deck image library (#nela-image-library).
 *
 * Web-searched candidates accumulate here so the user can re-apply any of them
 * to the active slide without another search. Lives outside `.slide` elements.
 */

import {
  canonicalImageKey,
  contentFingerprint,
  type SlideImageCandidate,
} from "./slideImageCandidates";
import {
  countFreeformSlides,
  replaceImageOnFreeformSlide,
} from "./freeformHtmlSlideEdit";

export const NELA_IMAGE_LIBRARY_ID = "nela-image-library";
export const NELA_LIB_ID_ATTR = "data-nela-lib-id";
export const LIBRARY_MAX_ENTRIES = 24;

export type LibraryImageEntry = {
  id: number;
  dataUri: string;
  sourceUrl: string;
  caption: string;
};

const STYLE_ID = "nela-image-library-style";
const SCRIPT_ID = "nela-image-library-script";

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** Parse library entries from the aside (if present). */
export function extractImageLibrary(html: string): LibraryImageEntry[] {
  const start = html.indexOf(`id="${NELA_IMAGE_LIBRARY_ID}"`);
  if (start < 0) return [];
  const asideStart = html.lastIndexOf("<", start);
  if (asideStart < 0) return [];
  const asideEnd = html.indexOf("</aside>", start);
  if (asideEnd < 0) return [];
  const block = html.slice(asideStart, asideEnd + "</aside>".length);

  const entries: LibraryImageEntry[] = [];
  let pos = 0;
  while (pos < block.length) {
    const btnIdx = block.toLowerCase().indexOf("<button", pos);
    if (btnIdx < 0) break;
    const btnTagEnd = findTagEnd(block, btnIdx);
    if (btnTagEnd < 0) break;
    const btnOpen = block.slice(btnIdx, btnTagEnd);
    const idM = btnOpen.match(/\bdata-nela-lib-id\s*=\s*["'](\d+)["']/i);
    if (!idM) {
      pos = btnTagEnd;
      continue;
    }
    const imgIdx = indexOfImgTag(block, btnTagEnd, block.length);
    if (imgIdx < 0) {
      pos = btnTagEnd;
      continue;
    }
    const imgEnd = findTagEnd(block, imgIdx);
    if (imgEnd < 0) {
      pos = btnTagEnd;
      continue;
    }
    const imgTag = block.slice(imgIdx, imgEnd);
    const src = getAttrValue(imgTag, "src") || "";
    const sourceUrl = getAttrValue(imgTag, "data-nela-img-src") || "";
    const caption =
      getAttrValue(btnOpen, "title") ||
      getAttrValue(imgTag, "alt") ||
      "Web image";
    if (src.startsWith("data:image/")) {
      entries.push({
        id: parseInt(idM[1], 10),
        dataUri: src,
        sourceUrl,
        caption,
      });
    }
    const closeBtn = block.toLowerCase().indexOf("</button>", imgEnd);
    pos = closeBtn >= 0 ? closeBtn + 9 : imgEnd;
  }

  return entries.sort((a, b) => a.id - b.id);
}

/** Find `>` that closes a tag, respecting quoted attribute values. */
export function findTagEnd(html: string, tagStart: number): number {
  let i = tagStart;
  let quote: string | null = null;
  while (i < html.length) {
    const c = html[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i + 1;
    }
    i += 1;
  }
  return -1;
}

export function indexOfImgTag(html: string, from: number, to: number): number {
  const re = /<img\b/gi;
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m || m.index >= to) return -1;
  return m.index;
}

/**
 * Read an attribute value without a greedy regex over the whole value
 * (critical for multi-megabyte data: URIs).
 */
export function getAttrValue(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(["'])`, "i");
  const m = re.exec(tag);
  if (!m || m.index == null) return null;
  const quote = m[1]!;
  const valueStart = m.index + m[0].length;
  let valueEnd = valueStart;
  while (valueEnd < tag.length && tag[valueEnd] !== quote) valueEnd += 1;
  if (valueEnd >= tag.length) return null;
  return tag.slice(valueStart, valueEnd);
}

/** Set or replace an attribute; does not regex-match the previous value body. */
export function setAttrValue(tag: string, name: string, value: string): string {
  const safe = escapeAttr(value);
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(["'])`, "i");
  const m = re.exec(tag);
  if (!m || m.index == null) {
    if (/\s*\/>\s*$/.test(tag)) {
      return tag.replace(/\s*\/>\s*$/, ` ${name}="${safe}" />`);
    }
    if (/>\s*$/.test(tag)) {
      return tag.replace(/>\s*$/, ` ${name}="${safe}">`);
    }
    return `${tag} ${name}="${safe}"`;
  }
  const quote = m[1]!;
  const valueStart = m.index + m[0].length;
  let valueEnd = valueStart;
  while (valueEnd < tag.length && tag[valueEnd] !== quote) valueEnd += 1;
  if (valueEnd >= tag.length) {
    return tag;
  }
  // Keep the original quote style; rewrite only the value span.
  return (
    tag.slice(0, m.index) +
    `${name}=${quote}${safe}${quote}` +
    tag.slice(valueEnd + 1)
  );
}

function libraryStyleBlock(): string {
  return `<style id="${STYLE_ID}">
.nela-image-library{position:fixed;left:10px;top:50%;transform:translateY(-50%);z-index:40;width:72px;max-height:70vh;display:flex;flex-direction:column;gap:6px;padding:8px 6px;border-radius:12px;background:rgba(8,12,20,.82);backdrop-filter:blur(8px);box-shadow:0 8px 28px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);color:#f8fafc;font:600 10px/1.2 system-ui,sans-serif}
.nela-image-library-title{text-align:center;opacity:.8;letter-spacing:.04em;text-transform:uppercase;font-size:9px}
.nela-image-library-rail{overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px}
.nela-image-library-rail button{appearance:none;border:1px solid rgba(255,255,255,.18);background:#111827;border-radius:8px;padding:0;cursor:pointer;overflow:hidden;width:56px;height:42px;flex:0 0 auto}
.nela-image-library-rail button:hover,.nela-image-library-rail button:focus{border-color:#38bdf8;outline:none}
.nela-image-library-rail img{width:100%;height:100%;object-fit:cover;display:block}
@media (max-width:720px){.nela-image-library{left:50%;top:auto;bottom:64px;transform:translateX(-50%);width:auto;max-width:92vw;max-height:64px;flex-direction:row;align-items:center}.nela-image-library-title{display:none}.nela-image-library-rail{flex-direction:row;overflow-x:auto;overflow-y:hidden;max-width:92vw}}
</style>`;
}

function libraryScriptBlock(): string {
  return `<script id="${SCRIPT_ID}">
(function(){
  if (window.__nelaImageLibraryBound) return;
  window.__nelaImageLibraryBound = true;
  function activeSlideIndex(){
    try {
      if (typeof currentSlide === "number" && currentSlide >= 0) return currentSlide;
    } catch (e) {}
    var slides = document.querySelectorAll(".slide-stage > .slide, .slide.active, .slide");
    for (var i = 0; i < slides.length; i++) {
      if (slides[i].classList && slides[i].classList.contains("active")) return i;
    }
    return 0;
  }
  document.addEventListener("click", function(ev){
    var t = ev.target;
    if (!t || !t.closest) return;
    var btn = t.closest("#${NELA_IMAGE_LIBRARY_ID} button[data-nela-lib-id]");
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    var id = parseInt(btn.getAttribute("data-nela-lib-id") || "", 10);
    if (!isFinite(id)) return;
    try {
      parent.postMessage({ type: "nela-apply-library-image", libId: id, slideIndex: activeSlideIndex() }, "*");
    } catch (e) {}
  }, true);
})();
</script>`;
}

function renderLibraryAside(entries: LibraryImageEntry[]): string {
  if (!entries.length) return "";
  const buttons = entries
    .map((e) => {
      const title = escapeAttr(e.caption || "Web image");
      const src = escapeAttr(e.dataUri);
      const source = e.sourceUrl ? escapeAttr(e.sourceUrl) : "";
      const sourceAttr = source ? ` data-nela-img-src="${source}"` : "";
      return (
        `<button type="button" data-nela-lib-id="${e.id}" title="${title}">` +
        `<img src="${src}" alt="${title}"${sourceAttr}>` +
        `</button>`
      );
    })
    .join("\n");
  return (
    `<aside id="${NELA_IMAGE_LIBRARY_ID}" class="nela-image-library" aria-label="Saved images">` +
    `<div class="nela-image-library-title">Images</div>` +
    `<div class="nela-image-library-rail">\n${buttons}\n</div>` +
    `</aside>`
  );
}

function stripLibraryBlocks(html: string): string {
  let out = html;
  // Remove aside
  const idIdx = out.indexOf(`id="${NELA_IMAGE_LIBRARY_ID}"`);
  if (idIdx >= 0) {
    const start = out.lastIndexOf("<", idIdx);
    const end = out.indexOf("</aside>", idIdx);
    if (start >= 0 && end >= 0) {
      out = out.slice(0, start) + out.slice(end + "</aside>".length);
    }
  }
  // Remove style/script companions
  for (const id of [STYLE_ID, SCRIPT_ID]) {
    const marker = `id="${id}"`;
    const mi = out.indexOf(marker);
    if (mi < 0) continue;
    const tagStart = out.lastIndexOf("<", mi);
    const isStyle = out.slice(tagStart, tagStart + 10).toLowerCase().includes("style");
    const close = isStyle ? "</style>" : "</script>";
    const end = out.indexOf(close, mi);
    if (tagStart >= 0 && end >= 0) {
      out = out.slice(0, tagStart) + out.slice(end + close.length);
    }
  }
  return out;
}

function injectBeforeBodyClose(html: string, chunk: string): string {
  const idx = html.lastIndexOf("</body>");
  if (idx >= 0) return html.slice(0, idx) + chunk + html.slice(idx);
  return html + chunk;
}

function injectInHead(html: string, chunk: string): string {
  const idx = html.lastIndexOf("</head>");
  if (idx >= 0) return html.slice(0, idx) + chunk + html.slice(idx);
  return chunk + html;
}

/**
 * Merge candidates into the deck library (FIFO cap, fingerprint + URL dedupe).
 * Returns the updated HTML and the entries (with stable ids) including new ones.
 */
export function upsertImageLibrary(
  html: string,
  candidates: Array<Pick<SlideImageCandidate, "dataUri" | "sourceUrl" | "caption">>
): { html: string; entries: LibraryImageEntry[]; addedIds: number[] } {
  const existing = extractImageLibrary(html);
  const byFp = new Map<string, LibraryImageEntry>();
  const byUrl = new Map<string, LibraryImageEntry>();
  for (const e of existing) {
    byFp.set(contentFingerprint(e.dataUri), e);
    if (e.sourceUrl) byUrl.set(canonicalImageKey(e.sourceUrl), e);
  }

  const newlyAddedFps: string[] = [];
  let nextId = existing.reduce((max, e) => Math.max(max, e.id), -1) + 1;
  const merged = [...existing];

  for (const c of candidates) {
    if (!c.dataUri?.startsWith("data:image/")) continue;
    const fp = contentFingerprint(c.dataUri);
    if (byFp.has(fp)) continue;
    const urlKey = c.sourceUrl ? canonicalImageKey(c.sourceUrl) : "";
    if (urlKey && byUrl.has(urlKey)) continue;
    const entry: LibraryImageEntry = {
      id: nextId++,
      dataUri: c.dataUri,
      sourceUrl: c.sourceUrl || "",
      caption: c.caption || "Web image",
    };
    merged.push(entry);
    byFp.set(fp, entry);
    if (urlKey) byUrl.set(urlKey, entry);
    newlyAddedFps.push(fp);
  }

  const capped =
    merged.length > LIBRARY_MAX_ENTRIES
      ? merged.slice(merged.length - LIBRARY_MAX_ENTRIES)
      : merged;

  const reindexed = capped.map((e, i) => ({ ...e, id: i }));
  const addedFpSet = new Set(newlyAddedFps);
  const addedIds = reindexed
    .filter((e) => addedFpSet.has(contentFingerprint(e.dataUri)))
    .map((e) => e.id);

  let out = stripLibraryBlocks(html);
  if (reindexed.length) {
    out = injectInHead(out, libraryStyleBlock() + "\n");
    out = injectBeforeBodyClose(
      out,
      "\n" + renderLibraryAside(reindexed) + "\n" + libraryScriptBlock() + "\n"
    );
  }

  return { html: out, entries: reindexed, addedIds };
}

/** Resolve a library entry by id. */
export function getLibraryEntry(
  html: string,
  libId: number
): LibraryImageEntry | null {
  return extractImageLibrary(html).find((e) => e.id === libId) ?? null;
}

/**
 * Point a slide's first content image at a library entry (sets lib id + src).
 */
export function applyLibraryImageToSlide(
  html: string,
  slideIndex: number,
  libId: number
): string {
  const entry = getLibraryEntry(html, libId);
  if (!entry) {
    throw new Error(`Image library entry ${libId} not found`);
  }
  const count = countFreeformSlides(html);
  if (count < 1) {
    throw new Error("No slides found in HTML deck");
  }
  const idx = Math.max(0, Math.min(count - 1, slideIndex));
  return replaceImageOnFreeformSlide(
    html,
    idx,
    entry.dataUri,
    entry.sourceUrl,
    libId
  );
}

/**
 * Find library id for a candidate (by fingerprint or source URL) after upsert.
 */
export function findLibraryIdForCandidate(
  entries: LibraryImageEntry[],
  candidate: Pick<SlideImageCandidate, "dataUri" | "sourceUrl">
): number | null {
  const fp = contentFingerprint(candidate.dataUri);
  const byFp = entries.find((e) => contentFingerprint(e.dataUri) === fp);
  if (byFp) return byFp.id;
  if (candidate.sourceUrl) {
    const key = canonicalImageKey(candidate.sourceUrl);
    const byUrl = entries.find(
      (e) => e.sourceUrl && canonicalImageKey(e.sourceUrl) === key
    );
    if (byUrl) return byUrl.id;
  }
  return null;
}
