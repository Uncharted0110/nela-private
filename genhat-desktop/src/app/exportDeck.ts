import { toPng } from "html-to-image";
import { jsPDF } from "jspdf";
import pptxgen from "pptxgenjs";
import { save } from "@tauri-apps/plugin-dialog";
import { Api } from "../api";

export type DeckExportFormat = "pdf" | "pptx";

/** Reference slide dimensions the deck is authored at (16:9). */
const SLIDE_W = 1280;
const SLIDE_H = 720;

/** PPTX layout size in inches (standard 16:9). */
const IN_W = 13.333;
const IN_H = 7.5;

// ─────────────────────────────────────────────────────────────────────────────
// Deck document loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the deck HTML into an offscreen, same-origin iframe at its native
 * 1280x720 size and run `fn` with the live document. Fonts embedded in the
 * deck (base64 @font-face) are awaited so text measures/paints correctly.
 */
async function withDeckDocument<T>(
  html: string,
  fn: (doc: Document, win: Window) => Promise<T>
): Promise<T> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin");
  Object.assign(iframe.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${SLIDE_W}px`,
    height: `${SLIDE_H}px`,
    border: "0",
    background: "#ffffff",
  } as CSSStyleDeclaration);
  document.body.appendChild(iframe);

  try {
    await new Promise<void>((resolve, reject) => {
      iframe.onload = () => resolve();
      iframe.onerror = () => reject(new Error("Failed to load deck for export."));
      iframe.srcdoc = html;
    });

    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error("Cannot access deck document for export.");

    try {
      await (doc as Document & { fonts?: FontFaceSet }).fonts?.ready;
    } catch {
      /* fonts API unavailable — continue */
    }
    await new Promise((r) => setTimeout(r, 120));

    return await fn(doc, win);
  } finally {
    iframe.remove();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF (image-based, pixel-perfect)
// ─────────────────────────────────────────────────────────────────────────────

/** Render each slide of the deck to a high-resolution PNG data URL. */
async function captureSlides(html: string): Promise<string[]> {
  return withDeckDocument(html, async (doc, win) => {
    doc.body.classList.add("exporting");

    // The themed background lives on <body>/.deck-container; the captured
    // stage is transparent, so paint the same theme background onto it.
    const rootStyle = win.getComputedStyle(doc.documentElement);
    const bg = rootStyle.getPropertyValue("--bg").trim() || "#0d0d11";
    const surface = rootStyle.getPropertyValue("--surface").trim() || bg;
    const deckBackground = `radial-gradient(circle at top left, ${surface} 0%, ${bg} 100%)`;

    const stage = doc.getElementById("stage") as HTMLElement | null;
    const target = (stage ??
      doc.querySelector(".deck-container") ??
      doc.body) as HTMLElement;
    if (stage) stage.style.transform = "none";
    target.style.backgroundColor = bg;
    target.style.backgroundImage = deckBackground;

    const slides = Array.from(doc.querySelectorAll(".slide")) as HTMLElement[];
    if (slides.length === 0) throw new Error("No slides found in the presentation.");

    const images: string[] = [];
    for (const slide of slides) {
      slides.forEach((s) => {
        s.classList.remove("active");
        s.style.opacity = "0";
        s.style.visibility = "hidden";
      });
      slide.classList.add("active");
      slide.style.opacity = "1";
      slide.style.visibility = "visible";
      slide.style.transition = "none";
      slide.style.transform = "none";
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      const dataUrl = await toPng(target, {
        width: SLIDE_W,
        height: SLIDE_H,
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: bg,
        style: { transform: "none", margin: "0" },
      });
      images.push(dataUrl);
    }
    return images;
  });
}

/** Convert an ArrayBuffer to a base64 string in chunks (avoids call-stack limits). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Build a PDF (one slide per landscape page) and return it as base64. */
function buildPdfBase64(images: string[]): string {
  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "px",
    format: [SLIDE_W, SLIDE_H],
    compress: true,
  });
  images.forEach((img, idx) => {
    if (idx > 0) pdf.addPage([SLIDE_W, SLIDE_H], "landscape");
    pdf.addImage(img, "PNG", 0, 0, SLIDE_W, SLIDE_H, undefined, "FAST");
  });
  return arrayBufferToBase64(pdf.output("arraybuffer"));
}

// ─────────────────────────────────────────────────────────────────────────────
// PPTX (native, editable)
// ─────────────────────────────────────────────────────────────────────────────

interface DeckTheme {
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  textSecondary: string;
  accent: string;
  accentTo: string;
  fontHead: string;
  fontBody: string;
}

interface SlideData {
  layout: string;
  /** Per-slide accent variety index (0-4) from the deck's `accent-N` class. */
  accentIndex: number;
  title: string;
  subtitle: string;
  bullets: string[];
  left: string[];
  right: string[];
  statValue: string;
  statLabel: string;
  quote: string;
  quoteAttr: string;
  cards: { head: string; body: string }[];
  compareA: { label: string; items: string[] };
  compareB: { label: string; items: string[] };
  imageSrc: string;
}

/** Normalize any CSS color (`#rgb`, `#rrggbb`, `rgb()/rgba()`) to `RRGGBB` hex. */
function toHex(color: string, fallback: string): string {
  const c = (color || "").trim();
  if (!c) return fallback;
  const hexMatch = c.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hexMatch) {
    let h = hexMatch[1];
    if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
    return h.toLowerCase();
  }
  const rgb = c.match(/rgba?\(([^)]+)\)/i);
  if (rgb) {
    const parts = rgb[1].split(",").map((p) => parseFloat(p.trim()));
    if (parts.length >= 3 && parts.every((n) => !Number.isNaN(n))) {
      return parts
        .slice(0, 3)
        .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"))
        .join("");
    }
  }
  return fallback;
}

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const h = hex.length === 6 ? hex : "000000";
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: RGB): string {
  return [r, g, b]
    .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"))
    .join("");
}

/** CSS `hue-rotate(deg)` color matrix (per filter-effects spec). */
function hueRotate([r, g, b]: RGB, deg: number): RGB {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    r * (0.213 + c * 0.787 - s * 0.213) + g * (0.715 - c * 0.715 - s * 0.715) + b * (0.072 - c * 0.072 + s * 0.928),
    r * (0.213 - c * 0.213 + s * 0.143) + g * (0.715 + c * 0.285 + s * 0.14) + b * (0.072 - c * 0.072 - s * 0.283),
    r * (0.213 - c * 0.213 - s * 0.787) + g * (0.715 - c * 0.715 + s * 0.715) + b * (0.072 + c * 0.928 + s * 0.072),
  ];
}

/** CSS `saturate(s)` color matrix. */
function saturate([r, g, b]: RGB, sat: number): RGB {
  return [
    r * (0.213 + 0.787 * sat) + g * (0.715 - 0.715 * sat) + b * (0.072 - 0.072 * sat),
    r * (0.213 - 0.213 * sat) + g * (0.715 + 0.285 * sat) + b * (0.072 - 0.072 * sat),
    r * (0.213 - 0.213 * sat) + g * (0.715 - 0.715 * sat) + b * (0.072 + 0.928 * sat),
  ];
}

/** CSS `brightness(b)` (linear multiply). */
function brightness([r, g, b]: RGB, amt: number): RGB {
  return [r * amt, g * amt, b * amt];
}

/**
 * Replicate the deck's per-slide accent variety (`accent-N` classes apply a
 * `filter` that `getComputedStyle` can't observe). Returns the effective accent
 * hex for the given slide so each slide's headings/shapes match the preview.
 */
function accentForSlide(accentHex: string, idx: number): string {
  let rgb = hexToRgb(accentHex);
  switch (idx % 5) {
    case 1:
      rgb = saturate(hueRotate(rgb, 55), 1.15);
      break;
    case 2:
      rgb = saturate(hueRotate(rgb, -60), 1.2);
      break;
    case 3:
      rgb = saturate(hueRotate(rgb, 120), 1.1);
      break;
    case 4:
      rgb = brightness(hueRotate(rgb, -120), 1.08);
      break;
    default:
      break; // accent-0: no filter
  }
  return rgbToHex(rgb);
}

/** Extract the first concrete family name from a CSS font-family value. */
function firstFontFamily(value: string, fallback: string): string {
  const first = (value || "").split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
  return first || fallback;
}

function readTheme(doc: Document, win: Window): DeckTheme {
  const s = win.getComputedStyle(doc.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    bg: toHex(v("--bg"), "0d0d11"),
    surface: toHex(v("--surface"), "1a1a24"),
    text: toHex(v("--text"), "e4e4eb"),
    textMuted: toHex(v("--text-muted"), "94a3b8"),
    textSecondary: toHex(v("--text-secondary"), "cbd5e1"),
    accent: toHex(v("--accent-from"), "a5b4fc"),
    accentTo: toHex(v("--accent-to"), "6366f1"),
    fontHead: firstFontFamily(v("--font-head"), "Arial"),
    fontBody: firstFontFamily(v("--font-body"), "Arial"),
  };
}

const txt = (el: Element | null | undefined): string =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const txtAll = (els: NodeListOf<Element> | Element[]): string[] =>
  Array.from(els).map((e) => txt(e)).filter((t) => t.length > 0);

function extractSlides(doc: Document): SlideData[] {
  const slideEls = Array.from(doc.querySelectorAll(".slide")) as HTMLElement[];
  return slideEls.map((el) => {
    const layout = (el.className.match(/layout-(\w+)/)?.[1] ?? "bullet").toLowerCase();
    const accentIndex = parseInt(el.className.match(/accent-(\d+)/)?.[1] ?? "0", 10) || 0;
    const data: SlideData = {
      layout,
      accentIndex,
      title: "",
      subtitle: "",
      bullets: [],
      left: [],
      right: [],
      statValue: "",
      statLabel: "",
      quote: "",
      quoteAttr: "",
      cards: [],
      compareA: { label: "", items: [] },
      compareB: { label: "", items: [] },
      imageSrc: "",
    };

    const headerTitle = txt(el.querySelector(".slide-header h2"));
    const lists = Array.from(el.querySelectorAll("ul.bullets-list")) as HTMLElement[];

    switch (layout) {
      case "title":
        data.title = txt(el.querySelector("h1"));
        data.subtitle = txt(el.querySelector("p"));
        break;
      case "section":
        data.title = txt(el.querySelector("h2"));
        data.subtitle = txt(el.querySelector("p"));
        break;
      case "centered":
        data.title = txt(el.querySelector("h2"));
        data.bullets = txtAll(el.querySelectorAll("p"));
        break;
      case "blank":
        data.title = txt(el.querySelector("h3"));
        break;
      case "stat":
        data.statValue = txt(el.querySelector(".stat-value"));
        data.statLabel = txt(el.querySelector(".stat-label"));
        data.bullets = lists[0] ? txtAll(lists[0].querySelectorAll("li")) : [];
        break;
      case "quote":
        data.quote = txt(el.querySelector(".quote-text"));
        data.quoteAttr = txt(el.querySelector(".quote-attr")).replace(/^[—-]\s*/, "");
        break;
      case "cards":
        data.title = headerTitle;
        data.cards = (Array.from(el.querySelectorAll(".card-box")) as HTMLElement[]).map((card) => {
          const head = txt(card.querySelector("strong"));
          const full = txt(card);
          const body = head && full.startsWith(head) ? full.slice(head.length).trim() : full;
          return { head: head || body, body: head ? body : "" };
        });
        break;
      case "comparison": {
        data.title = headerTitle;
        const sides = Array.from(el.querySelectorAll(".compare-side")) as HTMLElement[];
        if (sides[0]) {
          data.compareA = { label: txt(sides[0].querySelector("h3")), items: txtAll(sides[0].querySelectorAll("li")) };
        }
        if (sides[1]) {
          data.compareB = { label: txt(sides[1].querySelector("h3")), items: txtAll(sides[1].querySelectorAll("li")) };
        }
        break;
      }
      case "twocolumn":
        data.title = headerTitle;
        data.left = lists[0] ? txtAll(lists[0].querySelectorAll("li")) : [];
        data.right = lists[1] ? txtAll(lists[1].querySelectorAll("li")) : [];
        break;
      case "imageleft":
        data.title = headerTitle;
        data.bullets = lists[0] ? txtAll(lists[0].querySelectorAll("li")) : [];
        data.imageSrc =
          (el.querySelector(".slide-image") as HTMLImageElement | null)?.getAttribute("src") ?? "";
        break;
      case "bullet":
      default:
        data.title = headerTitle || txt(el.querySelector("h2"));
        data.bullets = lists[0] ? txtAll(lists[0].querySelectorAll("li")) : [];
        break;
    }
    return data;
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySlide = any;

/** Add a bulleted text block (one paragraph per item). */
function addBullets(
  slide: AnySlide,
  items: string[],
  opts: { x: number; y: number; w: number; h: number; color: string; font: string; size?: number }
) {
  if (items.length === 0) return;
  const runs = items.map((t) => ({ text: t, options: { breakLine: true } }));
  slide.addText(runs as any, {
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    fontFace: opts.font,
    fontSize: opts.size ?? 16,
    color: opts.color,
    align: "left",
    valign: "top",
    bullet: { characterCode: "2022", indent: 18 },
    lineSpacingMultiple: 1.3,
    paraSpaceAfter: 8,
  } as any);
}

const MX = 1.0; // horizontal margin (in)
const CW = IN_W - 2 * MX; // content width (in)

function renderSlide(pptx: pptxgen, theme: DeckTheme, d: SlideData) {
  const slide = pptx.addSlide();
  slide.background = { color: theme.bg };
  const head = theme.fontHead;
  const body = theme.fontBody;
  // Effective accent for this slide, matching the deck's per-slide hue variety.
  const accent = accentForSlide(theme.accent, d.accentIndex);

  const headerTitle = (size = 32) =>
    slide.addText(d.title, {
      x: MX, y: 0.55, w: CW, h: 1.0,
      fontFace: head, fontSize: size, bold: true, color: accent,
      align: "left", valign: "middle",
    } as any);

  switch (d.layout) {
    case "title":
      slide.addText(d.title, {
        x: 0.8, y: 2.5, w: IN_W - 1.6, h: 1.8,
        fontFace: head, fontSize: 54, bold: true, color: accent,
        align: "center", valign: "middle",
      } as any);
      if (d.subtitle)
        slide.addText(d.subtitle, {
          x: 1.5, y: 4.3, w: IN_W - 3.0, h: 1.0,
          fontFace: body, fontSize: 22, color: theme.textMuted,
          align: "center", valign: "top",
        } as any);
      break;

    case "section":
      slide.addShape(pptx.ShapeType.rect, {
        x: IN_W / 2 - 0.55, y: 2.7, w: 1.1, h: 0.06, fill: { color: accent },
      } as any);
      slide.addText(d.title, {
        x: 0.8, y: 2.95, w: IN_W - 1.6, h: 1.2,
        fontFace: head, fontSize: 42, bold: true, color: accent,
        align: "center", valign: "middle",
      } as any);
      if (d.subtitle)
        slide.addText(d.subtitle, {
          x: 1.5, y: 4.25, w: IN_W - 3.0, h: 0.9,
          fontFace: body, fontSize: 17, color: theme.textMuted, align: "center",
        } as any);
      break;

    case "centered":
      slide.addText(d.title, {
        x: 0.8, y: 2.3, w: IN_W - 1.6, h: 1.4,
        fontFace: head, fontSize: 46, bold: true, color: accent,
        align: "center", valign: "middle",
      } as any);
      if (d.bullets.length)
        slide.addText(d.bullets.join("\n"), {
          x: 1.5, y: 3.9, w: IN_W - 3.0, h: 2.0,
          fontFace: body, fontSize: 18, color: theme.textMuted,
          align: "center", valign: "top", lineSpacingMultiple: 1.3,
        } as any);
      break;

    case "blank":
      slide.addText(d.title, {
        x: MX, y: 3.0, w: CW, h: 1.5,
        fontFace: head, fontSize: 24, color: theme.textMuted,
        align: "center", valign: "middle",
      } as any);
      break;

    case "stat":
      slide.addText(d.statValue || d.title, {
        x: 0.8, y: 2.1, w: IN_W - 1.6, h: 1.9,
        fontFace: head, fontSize: 72, bold: true, color: accent,
        align: "center", valign: "middle",
      } as any);
      if (d.statLabel)
        slide.addText(d.statLabel, {
          x: 0.8, y: 4.0, w: IN_W - 1.6, h: 0.8,
          fontFace: body, fontSize: 19, color: theme.textMuted, align: "center",
        } as any);
      addBullets(slide, d.bullets, {
        x: 2.5, y: 4.9, w: IN_W - 5.0, h: 1.8, color: theme.textSecondary, font: body, size: 15,
      });
      break;

    case "quote":
      slide.addText("\u201C", {
        x: MX, y: 1.0, w: CW, h: 1.2,
        fontFace: head, fontSize: 80, bold: true, color: accent, align: "center",
      } as any);
      slide.addText(d.quote, {
        x: 1.5, y: 2.4, w: IN_W - 3.0, h: 2.4,
        fontFace: body, fontSize: 26, italic: true, color: theme.text,
        align: "center", valign: "middle", lineSpacingMultiple: 1.3,
      } as any);
      if (d.quoteAttr)
        slide.addText(`\u2014 ${d.quoteAttr}`, {
          x: 1.5, y: 5.0, w: IN_W - 3.0, h: 0.7,
          fontFace: body, fontSize: 16, color: theme.textMuted, align: "center",
        } as any);
      break;

    case "cards": {
      headerTitle();
      const cards = d.cards.slice(0, 4);
      const n = Math.max(cards.length, 1);
      const gap = 0.3;
      const cardW = (CW - gap * (n - 1)) / n;
      const cardY = 2.1;
      const cardH = 4.4;
      cards.forEach((c, i) => {
        const x = MX + i * (cardW + gap);
        slide.addText(
          [
            { text: c.head, options: { bold: true, fontSize: 18, color: theme.text, breakLine: true, fontFace: head } },
            ...(c.body ? [{ text: c.body, options: { fontSize: 14, color: theme.textSecondary, breakLine: true, fontFace: body } }] : []),
          ] as any,
          {
            x, y: cardY, w: cardW, h: cardH,
            fill: { color: theme.surface },
            line: { color: accent, width: 0.75 },
            rectRadius: 0.12, shape: pptx.ShapeType.roundRect,
            align: "left", valign: "top", margin: 12,
          } as any
        );
      });
      break;
    }

    case "comparison": {
      headerTitle();
      const colW = (CW - 1.0) / 2;
      const colY = 2.1;
      const colH = 4.4;
      const renderSide = (x: number, label: string, items: string[]) => {
        slide.addShape(pptx.ShapeType.roundRect, {
          x, y: colY, w: colW, h: colH,
          fill: { color: theme.surface }, line: { color: accent, width: 0.75 }, rectRadius: 0.12,
        } as any);
        slide.addText(label, {
          x: x + 0.2, y: colY + 0.2, w: colW - 0.4, h: 0.7,
          fontFace: head, fontSize: 19, bold: true, color: accent, align: "left",
        } as any);
        addBullets(slide, items, {
          x: x + 0.2, y: colY + 0.95, w: colW - 0.4, h: colH - 1.1, color: theme.textSecondary, font: body, size: 15,
        });
      };
      renderSide(MX, d.compareA.label || "Primary approach", d.compareA.items);
      slide.addText("VS", {
        x: MX + colW, y: colY + colH / 2 - 0.4, w: 1.0, h: 0.8,
        fontFace: head, fontSize: 22, bold: true, color: accent, align: "center", valign: "middle",
      } as any);
      renderSide(MX + colW + 1.0, d.compareB.label || "Alternative approach", d.compareB.items);
      break;
    }

    case "twocolumn": {
      headerTitle();
      const colW = (CW - 0.6) / 2;
      addBullets(slide, d.left, { x: MX, y: 1.9, w: colW, h: 4.8, color: theme.textSecondary, font: body, size: 17 });
      addBullets(slide, d.right, { x: MX + colW + 0.6, y: 1.9, w: colW, h: 4.8, color: theme.textSecondary, font: body, size: 17 });
      break;
    }

    case "imageleft": {
      headerTitle();
      const imgW = CW * 0.42;
      if (d.imageSrc.startsWith("data:")) {
        slide.addImage({
          data: d.imageSrc,
          x: MX,
          y: 1.9,
          w: imgW,
          h: 4.6,
          sizing: { type: "cover", w: imgW, h: 4.6 },
        } as any);
      } else {
        slide.addShape(pptx.ShapeType.roundRect, {
          x: MX, y: 1.9, w: imgW, h: 4.6,
          fill: { color: theme.surface }, line: { color: accent, width: 0.75 }, rectRadius: 0.12,
        } as any);
      }
      addBullets(slide, d.bullets, {
        x: MX + imgW + 0.6, y: 1.9, w: CW - imgW - 0.6, h: 4.6, color: theme.textSecondary, font: body, size: 17,
      });
      break;
    }

    case "bullet":
    default:
      headerTitle();
      addBullets(slide, d.bullets, { x: MX, y: 1.9, w: CW, h: 4.8, color: theme.textSecondary, font: body, size: 18 });
      break;
  }
}

/** Build an editable PPTX (native text boxes + shapes) and return it as base64. */
async function buildEditablePptxBase64(html: string): Promise<string> {
  const { theme, slides } = await withDeckDocument(html, async (doc, win) => ({
    theme: readTheme(doc, win),
    slides: extractSlides(doc),
  }));

  if (slides.length === 0) throw new Error("No slides found in the presentation.");

  const pptx = new pptxgen();
  pptx.defineLayout({ name: "NELA_16x9", width: IN_W, height: IN_H });
  pptx.layout = "NELA_16x9";

  for (const d of slides) renderSlide(pptx, theme, d);

  return (await pptx.write({ outputType: "base64" })) as string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Strip extension + directory from a path to seed the save dialog filename. */
function baseName(path: string): string {
  const file = path.split(/[/\\]/).pop() ?? "presentation";
  return file.replace(/\.[^.]+$/, "");
}

/** Decode common HTML entities and collapse whitespace. */
function decodeText(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sanitize a deck title into a safe file name (no path/extension). */
function titleToFileName(title: string): string {
  return title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Derive a default export file name from the deck's title slide. Falls back to
 * the on-disk file name if no usable title is found.
 */
function deckBaseName(html: string, htmlPath: string): string {
  // The cover slide renders the title as the first <h1>.
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const name = titleToFileName(decodeText(h1[1]));
    if (name) return name;
  }
  return baseName(htmlPath);
}

/**
 * Export a generated presentation deck to PDF or PPTX at a user-chosen path.
 *
 * - PDF  → pixel-perfect image of each slide (exact fonts/background).
 * - PPTX → fully editable native slides (text boxes + shapes) that preserve the
 *          theme background, colors, sizes, and layout. Fonts are referenced by
 *          name; PowerPoint substitutes a similar font if not installed.
 *
 * @returns The saved file path, or `null` if the user cancelled the dialog.
 */
export async function exportPresentation(
  htmlPath: string,
  format: DeckExportFormat
): Promise<string | null> {
  const html = await Api.readFileText(htmlPath);
  const defaultName = `${deckBaseName(html, htmlPath)}.${format}`;
  const filterName = format === "pdf" ? "PDF Document" : "PowerPoint Presentation";

  const targetPath = await save({
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: [format] }],
  });
  if (!targetPath) return null;

  const base64 =
    format === "pdf"
      ? buildPdfBase64(await captureSlides(html))
      : await buildEditablePptxBase64(html);

  await Api.saveBinaryFile(targetPath, base64);
  return targetPath;
}
