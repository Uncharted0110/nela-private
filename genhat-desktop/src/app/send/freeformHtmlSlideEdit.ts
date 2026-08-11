/**
 * Deterministic slide insert/remove for freeform HTML decks (cloud / custom HTML
 * with `.slide` elements) — no LLM and no NELA deck-shell rewrite.
 */

/**
 * Prefer short tags (class before huge style attrs). Fallback walker handles
 * `style="…huge…" class="slide"` and odd tag names.
 */
const SLIDE_OPEN_SOURCE =
  "<[a-zA-Z][\\w:-]*\\b(?=[^>]{0,500}\\bclass\\s*=\\s*[\"'][^\"']*\\bslide\\b)[^>]*>";

function slideOpenRe(): RegExp {
  return new RegExp(SLIDE_OPEN_SOURCE, "gi");
}

function findSlideStartsFallback(html: string): number[] {
  const starts: number[] = [];
  const classRe = /\bclass\s*=\s*(["'])([^"']*\bslide\b[^"']*)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(html)) !== null) {
    // Walk back to the opening '<' of this tag.
    let i = m.index;
    while (i > 0 && html[i] !== "<") i -= 1;
    if (html[i] !== "<") continue;
    // Skip closing tags / comments.
    if (html[i + 1] === "/" || html[i + 1] === "!") continue;
    starts.push(i);
  }
  // De-dupe + sort (class attrs can appear more than once theoretically).
  return [...new Set(starts)].sort((a, b) => a - b);
}

function findSlideStarts(html: string): number[] {
  const starts: number[] = [];
  const re = slideOpenRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    starts.push(m.index);
  }
  if (starts.length >= 2) return starts;
  const fallback = findSlideStartsFallback(html);
  return fallback.length > starts.length ? fallback : starts;
}

/** Count freeform slides (never reuse a sticky /g lastIndex). */
export function countFreeformSlides(html: string): number {
  return findSlideStarts(html).length;
}

/** True when HTML looks like a multi-slide deck we can surgically edit. */
export function isHtmlSlideDeck(content: string): boolean {
  return countFreeformSlides(content) >= 2;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tagNameAt(html: string, openStart: number): string {
  const m = html.slice(openStart).match(/^<\/?([a-zA-Z][\w:-]*)/);
  return (m?.[1] ?? "div").toLowerCase();
}

/** End offset (exclusive) of the slide element that starts at `openStart`. */
function findMatchingElementEnd(html: string, openStart: number): number {
  const name = tagNameAt(html, openStart);
  const openTagEnd = html.indexOf(">", openStart);
  if (openTagEnd < 0) {
    throw new Error("Malformed slide opening tag");
  }
  // Self-closing
  const openTag = html.slice(openStart, openTagEnd + 1);
  if (/\/\s*>$/.test(openTag)) return openTagEnd + 1;

  let depth = 1;
  const tagRe = new RegExp(`</?${name}\\b[^>]*>`, "gi");
  tagRe.lastIndex = openTagEnd + 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    if (tag.startsWith("</") || /^<\//.test(tag)) {
      depth -= 1;
      if (depth === 0) return m.index + tag.length;
    } else if (!/\/\s*>$/.test(tag)) {
      depth += 1;
    }
  }
  throw new Error("Unclosed slide element");
}

export type FreeformSlideContent = {
  title: string;
  bullets?: string[];
  paragraphs?: string[];
  summary?: string;
  imageDataUri?: string;
  /** Match alternating image/text columns when synthesizing a layout. */
  imageOnLeft?: boolean;
  bodyStyle?: "paragraphs" | "bullets" | "mixed";
  /**
   * Fallback only when the deck has no usable neighbor slide to clone.
   * Prefer cloning an existing content slide's markup for any PPT theme.
   */
  layoutTheme?: "split" | "content-layout" | "generic";
  kicker?: string;
  /** When true, leave existing <img src> alone if no new image is provided. */
  preserveImage?: boolean;
};

function scoreSlideAsTemplate(block: string): number {
  const text = stripTags(block).toLowerCase();
  if (
    /thank you|gracias|the end|questions\?|fin\.|fin\b/.test(text) &&
    text.length < 120
  ) {
    return -100;
  }
  let score = 0;
  if (/<h2\b/i.test(block)) score += 5;
  if (/<img\b/i.test(block)) score += 3;
  if (/<ul\b/i.test(block)) score += 2;
  if (/<p\b/i.test(block)) score += 1;
  // Title/hero slides are poor templates.
  if (/<h1\b/i.test(block) && !/<h2\b/i.test(block)) score -= 4;
  return score;
}

/**
 * Pick a nearby content slide's outer HTML so we can reuse that PPT's real
 * markup/classes instead of hardcoding one theme.
 */
export function pickNeighborSlideTemplate(
  html: string,
  insertIndex: number
): string | null {
  const starts = findSlideStarts(html);
  if (starts.length === 0) return null;
  const blocks = starts.map((s) =>
    html.slice(s, findMatchingElementEnd(html, s))
  );

  const ranked: { i: number; score: number }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const base = scoreSlideAsTemplate(blocks[i]);
    if (base < 2) continue;
    // Prefer the slide just before the insert point (same visual chapter).
    const dist = Math.min(
      Math.abs(i - insertIndex),
      Math.abs(i - (insertIndex - 1))
    );
    ranked.push({ i, score: base * 10 - dist });
  }
  if (ranked.length === 0) {
    const any = blocks.findIndex((b) => /<h2\b/i.test(b));
    return any >= 0 ? blocks[any] : null;
  }
  ranked.sort((a, b) => b.score - a.score);
  return blocks[ranked[0].i];
}

/** Fill a cloned neighbor slide with new title / body / image. */
export function fillFromNeighborTemplate(
  template: string,
  content: FreeformSlideContent
): string {
  let out = template;

  // Drop `active` so the new slide isn't shown immediately.
  out = out.replace(/\sclass=(["'])([^"']*)\1/gi, (_m, q: string, cls: string) => {
    const next = cls.replace(/\bactive\b/g, " ").replace(/\s+/g, " ").trim();
    return ` class=${q}${next}${q}`;
  });

  if (/<h2\b/i.test(out)) {
    out = out.replace(
      /<h2(\b[^>]*)>[\s\S]*?<\/h2>/i,
      `<h2$1>${escapeHtml(content.title)}</h2>`
    );
  } else {
    out = out.replace(
      /<h1(\b[^>]*)>[\s\S]*?<\/h1>/i,
      `<h1$1>${escapeHtml(content.title)}</h1>`
    );
  }

  if (content.kicker) {
    out = out.replace(
      /(<p\b[^>]*\bkicker\b[^>]*>)([\s\S]*?)(<\/p>)/i,
      `$1${escapeHtml(content.kicker)}$3`
    );
  }

  const bullets = content.bullets ?? [];
  const paragraphs = (content.paragraphs ?? []).filter((p) => p.trim());
  const summary = content.summary?.trim() ?? "";
  const style =
    content.bodyStyle ?? (paragraphs.length ? "paragraphs" : "bullets");

  if (style === "paragraphs" && bullets.length === 0) {
    out = out.replace(/<ul\b[^>]*>[\s\S]*?<\/ul>/i, "");
  }

  if (bullets.length > 0 && /<ul\b/i.test(out) && style !== "paragraphs") {
    const lis = bullets
      .map((b) => `          <li>${escapeHtml(b)}</li>`)
      .join("\n");
    out = out.replace(
      /<ul(\b[^>]*)>[\s\S]*?<\/ul>/i,
      `<ul$1>\n${lis}\n        </ul>`
    );
  }

  const paras =
    style === "bullets" && bullets.length > 0
      ? summary
        ? [summary]
        : []
      : paragraphs.length > 0
        ? paragraphs
        : summary
          ? [summary]
          : [];

  if (paras.length > 0) {
    let pi = 0;
    out = out.replace(
      /<p(\b[^>]*)>([\s\S]*?)<\/p>/gi,
      (full, attrs: string) => {
        if (/\bkicker\b/i.test(attrs) || /\bkicker\b/i.test(full)) return full;
        if (pi >= paras.length) return "";
        const text = paras[pi++];
        return `<p${attrs}>${escapeHtml(text)}</p>`;
      }
    );
    if (pi < paras.length) {
      const extra = paras
        .slice(pi)
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join("\n        ");
      // Append leftover paragraphs after the last body </p>, else after the title.
      const closes = [...out.matchAll(/<\/p>/gi)];
      const lastClose = closes.length ? closes[closes.length - 1] : null;
      if (lastClose && lastClose.index != null) {
        const at = lastClose.index + lastClose[0].length;
        out = out.slice(0, at) + `\n        ${extra}` + out.slice(at);
      } else if (/<\/h2>/i.test(out)) {
        out = out.replace(/<\/h2>/i, `</h2>\n        ${extra}`);
      } else if (/<\/h1>/i.test(out)) {
        out = out.replace(/<\/h1>/i, `</h1>\n        ${extra}`);
      }
    }
  }

  // If we have bullets but the template has no list, inject one after the title.
  if (
    bullets.length > 0 &&
    !/<ul\b/i.test(out) &&
    style !== "paragraphs"
  ) {
    const listClass =
      content.layoutTheme === "split" ? ' class="dest-list"' : "";
    const lis = bullets
      .map((b) => `          <li>${escapeHtml(b)}</li>`)
      .join("\n");
    const list = `<ul${listClass}>\n${lis}\n        </ul>`;
    if (/<\/h2>/i.test(out)) {
      out = out.replace(/<\/h2>/i, `</h2>\n        ${list}`);
    } else if (/<\/h1>/i.test(out)) {
      out = out.replace(/<\/h1>/i, `</h1>\n        ${list}`);
    }
  }

  if (content.imageDataUri && /<img\b/i.test(out)) {
    out = out.replace(
      /(<img\b[^>]*\bsrc\s*=\s*["'])([^"']*)(["'])/i,
      `$1${content.imageDataUri}$3`
    );
    if (/\balt\s*=/i.test(out)) {
      out = out.replace(
        /(<img\b[^>]*\balt\s*=\s*["'])([^"']*)(["'])/i,
        `$1${escapeHtml(content.title)}$3`
      );
    }
  } else if (
    !content.imageDataUri &&
    /<img\b/i.test(out) &&
    !content.preserveImage
  ) {
    // Keep layout slot, clear the previous photo.
    out = out.replace(/(<img\b[^>]*\bsrc\s*=\s*["'])([^"']*)(["'])/i, `$1$3`);
  }

  return out.startsWith("\n") ? out : `\n${out}\n`;
}

/** Hardcoded shells — only used when no neighbor slide can be cloned. */
function buildFreeformSlideHtml(content: FreeformSlideContent): string {
  const theme = content.layoutTheme ?? "generic";
  if (theme === "split") return buildSplitThemeSlideHtml(content);
  if (theme === "content-layout") return buildContentLayoutSlideHtml(content);
  return buildGenericConstrainedSlideHtml(content);
}

function buildBodyParts(content: FreeformSlideContent): {
  paraHtml: string;
  listHtml: string;
  body: string;
} {
  const bullets = content.bullets ?? [];
  const paragraphs = (content.paragraphs ?? []).filter((p) => p.trim());
  const summary = content.summary?.trim() ?? "";
  const style =
    content.bodyStyle ?? (paragraphs.length ? "paragraphs" : "bullets");

  const paraHtml = (() => {
    if (style === "bullets" && bullets.length > 0 && paragraphs.length === 0) {
      // Still allow a lead sentence above dest-list style bullets.
      return summary ? `<p>${escapeHtml(summary)}</p>` : "";
    }
    const paras =
      paragraphs.length > 0 ? paragraphs : summary ? [summary] : [];
    return paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n        ");
  })();

  const listClass =
    content.layoutTheme === "split" ? ' class="dest-list"' : "";
  const listHtml = (() => {
    if (style === "paragraphs" && paragraphs.length > 0 && bullets.length === 0)
      return "";
    if (bullets.length === 0) return "";
    return `<ul${listClass}>\n${bullets
      .map((b) => `          <li>${escapeHtml(b)}</li>`)
      .join("\n")}\n        </ul>`;
  })();

  const body =
    paraHtml || listHtml
      ? `${paraHtml}${paraHtml && listHtml ? "\n        " : ""}${listHtml}`
      : `<p>${escapeHtml(summary || `Discover ${content.title}.`)}</p>`;

  return { paraHtml, listHtml, body };
}

/** Matches decks using `.split` + `.side-img` + `.dest-list` (common travel themes). */
function buildSplitThemeSlideHtml(content: FreeformSlideContent): string {
  const safeTitle = escapeHtml(content.title);
  const kicker = escapeHtml(content.kicker || "Place to visit");
  const { body } = buildBodyParts({ ...content, layoutTheme: "split" });
  const text = `
      <div class="text">
        <p class="kicker">${kicker}</p>
        <h2>${safeTitle}</h2>
        ${body}
      </div>`;
  const img = content.imageDataUri
    ? `\n      <img src="${content.imageDataUri}" alt="${safeTitle}" class="side-img">`
    : "";
  // Default for this theme: text left, constrained side image right.
  const inner =
    content.imageOnLeft && img
      ? `${img}\n${text}`
      : `${text}${img}`;
  return `
  <section class="slide">
    <div class="split">
${inner}
    </div>
  </section>
`;
}

/** Legacy freeform decks using content-layout / image-side / text-side. */
function buildContentLayoutSlideHtml(content: FreeformSlideContent): string {
  const safeTitle = escapeHtml(content.title);
  const { body } = buildBodyParts(content);
  const textBlock = `
            <div class="text-side">
                <h2>${safeTitle}</h2>
                ${body}
            </div>`;
  const imageBlock = content.imageDataUri
    ? `
            <div class="image-side">
                <img src="${content.imageDataUri}" alt="${safeTitle}" style="width:100%;height:74vh;max-height:74vh;object-fit:cover;border-radius:18px;" />
            </div>`
    : "";

  if (imageBlock) {
    const leftFirst = content.imageOnLeft !== false;
    return `
    <div class="slide">
        <div class="content-layout">
            ${leftFirst ? imageBlock + textBlock : textBlock + imageBlock}
        </div>
    </div>
`;
  }
  return `
    <div class="slide">
        <div class="content-layout">
            ${textBlock}
        </div>
    </div>
`;
}

/** Unknown theme — still constrain the image so bullets stay visible. */
function buildGenericConstrainedSlideHtml(content: FreeformSlideContent): string {
  const safeTitle = escapeHtml(content.title);
  const { body } = buildBodyParts(content);
  const text = `<div style="flex:1.2;min-width:0;">
        <h2>${safeTitle}</h2>
        ${body}
      </div>`;
  const img = content.imageDataUri
    ? `<img src="${content.imageDataUri}" alt="${safeTitle}" style="flex:1;width:42%;max-width:42%;height:74vh;object-fit:cover;border-radius:18px;box-shadow:0 18px 40px rgba(0,0,0,.25);" />`
    : "";
  const row =
    content.imageOnLeft && img
      ? `${img}\n      ${text}`
      : `${text}\n      ${img}`;
  return `
  <section class="slide" style="display:flex;align-items:center;justify-content:center;padding:5vh 6vw;box-sizing:border-box;">
    <div style="display:flex;align-items:center;gap:4vw;width:100%;">
      ${row}
    </div>
  </section>
`;
}

function bumpSlideCounter(html: string, newCount: number): string {
  // "Slide <span id="current-slide-num">1</span> / 7"
  let next = html.replace(
    /(id=["']current-slide-num["'][\s\S]*?<\/span>\s*\/\s*)\d+/i,
    `$1${newCount}`
  );
  // Themed decks: <span id="counter">1 / 9</span>
  next = next.replace(
    /(id=["']counter["'][^>]*>\s*\d+\s*\/\s*)\d+/i,
    `$1${newCount}`
  );
  // Plain " / 7" near a Slide label
  next = next.replace(
    /(Slide\s*(?:<[^>]+>\s*)*\d*(?:<\/span>)?\s*\/\s*)\d+/i,
    `$1${newCount}`
  );
  return next;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Best-effort titles from each freeform `.slide` block (h1–h3). */
export function listFreeformSlideTitles(html: string): string[] {
  const starts = findSlideStarts(html);
  return starts.map((start) => {
    const end = findMatchingElementEnd(html, start);
    const block = html.slice(start, end);
    const heading = block.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    return heading ? stripTags(heading[1]) : "";
  });
}

/** Outer HTML for the slide at 0-based `index`. */
export function getFreeformSlideBlock(html: string, index: number): string {
  const starts = findSlideStarts(html);
  if (starts.length < 1) return "";
  const at = Math.max(0, Math.min(index, starts.length - 1));
  return html.slice(starts[at], findMatchingElementEnd(html, starts[at]));
}

/** Replace the outer HTML of one slide block. */
export function replaceFreeformSlideBlock(
  html: string,
  index: number,
  newBlock: string
): string {
  const starts = findSlideStarts(html);
  if (starts.length < 1) {
    throw new Error("No slides found in HTML deck");
  }
  const at = Math.max(0, Math.min(index, starts.length - 1));
  const blockStart = starts[at];
  const blockEnd = findMatchingElementEnd(html, blockStart);
  return html.slice(0, blockStart) + newBlock + html.slice(blockEnd);
}

/**
 * Replace an <img> on a freeform slide with a new data URI / URL.
 * Uses quote-aware attribute rewriting so multi-megabyte data: URIs do not
 * break a second replace. Optional `libId` stamps data-nela-lib-id.
 * `imageIndex` is 0-based among <img> tags inside the slide (default 0).
 */
export function replaceImageOnFreeformSlide(
  html: string,
  index: number,
  imageSrc: string,
  sourceUrl?: string | null,
  libId?: number | null,
  imageIndex = 0
): string {
  const starts = findSlideStarts(html);
  if (starts.length < 1) {
    throw new Error("No slides found in HTML deck");
  }
  const at = Math.max(0, Math.min(index, starts.length - 1));
  const blockStart = starts[at];
  const blockEnd = findMatchingElementEnd(html, blockStart);

  const want = Math.max(0, Math.floor(imageIndex));
  let imgStart = -1;
  let found = -1;
  let searchFrom = blockStart;
  while (searchFrom < blockEnd) {
    const next = indexOfImgInRange(html, searchFrom, blockEnd);
    if (next < 0) break;
    found += 1;
    if (found === want) {
      imgStart = next;
      break;
    }
    const tagEnd = findQuotedTagEnd(html, next);
    searchFrom = tagEnd > 0 ? tagEnd : next + 4;
  }
  if (imgStart < 0) {
    throw new Error(
      want === 0
        ? `Slide ${at + 1} has no image to replace`
        : `Slide ${at + 1} has no image at index ${want}`
    );
  }
  const imgEnd = findQuotedTagEnd(html, imgStart);
  if (imgEnd < 0) {
    throw new Error(`Could not update image src on slide ${at + 1}`);
  }

  let tag = html.slice(imgStart, imgEnd);
  tag = setImgAttr(tag, "src", imageSrc);
  if (sourceUrl?.trim()) {
    tag = setImgAttr(tag, "data-nela-img-src", sourceUrl.trim());
  }
  if (libId != null && Number.isFinite(libId) && libId >= 0) {
    tag = setImgAttr(tag, "data-nela-lib-id", String(Math.floor(libId)));
  }

  return html.slice(0, imgStart) + tag + html.slice(imgEnd);
}

/** Find `<img` within [from, to) without slurping attribute values. */
function indexOfImgInRange(html: string, from: number, to: number): number {
  const re = /<img\b/gi;
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m || m.index >= to) return -1;
  return m.index;
}

/** End offset after `>` closing a tag, respecting quoted attribute values. */
function findQuotedTagEnd(html: string, tagStart: number): number {
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

function setImgAttr(tag: string, name: string, value: string): string {
  const safe = value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  const re = new RegExp(
    `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(["'])`,
    "i"
  );
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
  if (valueEnd >= tag.length) return tag;
  return (
    tag.slice(0, m.index) +
    `${name}=${quote}${safe}${quote}` +
    tag.slice(valueEnd + 1)
  );
}

/** Expand / rewrite body copy on an existing slide (keeps title + image). */
export function expandSlideInFreeformHtml(
  html: string,
  index: number,
  content: FreeformSlideContent
): string {
  const starts = findSlideStarts(html);
  if (starts.length < 1) {
    throw new Error("No slides found in HTML deck");
  }
  const at = Math.max(0, Math.min(index, starts.length - 1));
  const end = findMatchingElementEnd(html, starts[at]);
  const block = html.slice(starts[at], end);
  const heading = block.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  const existingTitle = heading ? stripTags(heading[1]) : content.title;
  const filled = fillFromNeighborTemplate(block, {
    ...content,
    title: existingTitle || content.title,
    preserveImage: content.preserveImage !== false,
  });
  // Restore active class if the original slide was showing.
  let nextBlock = filled.trim();
  if (/\bactive\b/i.test(block) && !/\bactive\b/i.test(nextBlock)) {
    nextBlock = nextBlock.replace(
      /\sclass=(["'])([^"']*)\1/i,
      (_m, q: string, cls: string) => ` class=${q}${(cls + " active").trim()}${q}`
    );
  }
  return html.slice(0, starts[at]) + nextBlock + html.slice(end);
}

/** Remove the slide at 0-based `index`. */
export function removeSlideFromFreeformHtml(html: string, index: number): string {
  const starts = findSlideStarts(html);
  if (starts.length < 2) {
    throw new Error("Need at least two slides to remove one");
  }
  const at = Math.max(0, Math.min(index, starts.length - 1));
  const end = findMatchingElementEnd(html, starts[at]);
  // Trim surrounding blank lines so the deck stays tidy.
  let from = starts[at];
  let to = end;
  while (from > 0 && (html[from - 1] === "\n" || html[from - 1] === "\r")) {
    from -= 1;
    if (html[from] === "\n") break;
  }
  while (to < html.length && (html[to] === "\n" || html[to] === "\r" || html[to] === " ")) {
    to += 1;
    if (html[to - 1] === "\n") break;
  }
  const next = html.slice(0, from) + html.slice(to);
  return bumpSlideCounter(next, starts.length - 1);
}

/**
 * Move a slide from one 0-based index to another (JS splice semantics).
 * Counter unchanged — slide count stays the same.
 */
export function moveSlideInFreeformHtml(
  html: string,
  fromIndex: number,
  toIndex: number
): string {
  const starts = findSlideStarts(html);
  if (starts.length < 2) {
    throw new Error("Need at least two slides to reorder");
  }
  const from = Math.max(0, Math.min(fromIndex, starts.length - 1));
  const to = Math.max(0, Math.min(toIndex, starts.length - 1));
  if (from === to) return html;

  const end = findMatchingElementEnd(html, starts[from]);
  let block = html.slice(starts[from], end);
  if (!block.startsWith("\n")) block = `\n${block}`;
  if (!block.endsWith("\n")) block = `${block}\n`;

  let fromStart = starts[from];
  let fromEnd = end;
  while (
    fromStart > 0 &&
    (html[fromStart - 1] === "\n" || html[fromStart - 1] === "\r")
  ) {
    fromStart -= 1;
    if (html[fromStart] === "\n") break;
  }
  while (
    fromEnd < html.length &&
    (html[fromEnd] === "\n" || html[fromEnd] === "\r" || html[fromEnd] === " ")
  ) {
    fromEnd += 1;
    if (html[fromEnd - 1] === "\n") break;
  }

  const without = html.slice(0, fromStart) + html.slice(fromEnd);
  const newStarts = findSlideStarts(without);
  if (newStarts.length < 1) {
    throw new Error("Slide reorder failed — no slides left after extract");
  }

  // Same as: arr.splice(from,1); arr.splice(to,0,item)
  const insertAt = Math.max(0, Math.min(to, newStarts.length));
  if (insertAt >= newStarts.length) {
    const lastEnd = findMatchingElementEnd(
      without,
      newStarts[newStarts.length - 1]
    );
    return without.slice(0, lastEnd) + block + without.slice(lastEnd);
  }
  return (
    without.slice(0, newStarts[insertAt]) +
    block +
    without.slice(newStarts[insertAt])
  );
}

/**
 * Insert a slide into freeform HTML. `insertIndex` is 0-based
 * (0 = beginning, slideCount = end).
 */
export function insertSlideIntoFreeformHtml(
  html: string,
  content: FreeformSlideContent,
  insertIndex: number
): string {
  const starts = findSlideStarts(html);
  if (starts.length < 1) {
    throw new Error("No slides found in HTML deck");
  }
  const at = Math.max(0, Math.min(insertIndex, starts.length));
  // Prefer cloning a neighbor slide so any PPT keeps its own theme/classes.
  const neighbor = pickNeighborSlideTemplate(html, at);
  const slideHtml = neighbor
    ? fillFromNeighborTemplate(neighbor, content)
    : buildFreeformSlideHtml(content);

  let next: string;
  if (at >= starts.length) {
    const lastEnd = findMatchingElementEnd(html, starts[starts.length - 1]);
    next = html.slice(0, lastEnd) + slideHtml + html.slice(lastEnd);
  } else {
    next = html.slice(0, starts[at]) + slideHtml + html.slice(starts[at]);
  }

  return bumpSlideCounter(next, starts.length + 1);
}
