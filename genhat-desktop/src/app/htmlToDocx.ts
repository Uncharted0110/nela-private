/**
 * HTML → DOCX (semantic). Claude-style: map headings/paragraphs/lists/tables,
 * not pixel layout. Slide decks become one Word section per .slide.
 */

import {
  Document as DocxDocument,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
  PageBreak,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ImageRun,
} from "docx";
import { SLIDE_ROOT_SELECTOR } from "./htmlToPptx/slideRoots";

const SKIP_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "noscript",
  "svg",
  "canvas",
  "button",
  "nav",
  "iframe",
]);

const SKIP_SELECTORS =
  "#nela-image-library, .nela-image-library, .deck-footer, footer.controls, #footer, .slide-nav";

type DocChild = Paragraph | Table;

function visibleText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function headingLevel(tag: string): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (tag) {
    case "h1":
      return HeadingLevel.HEADING_1;
    case "h2":
      return HeadingLevel.HEADING_2;
    case "h3":
      return HeadingLevel.HEADING_3;
    case "h4":
      return HeadingLevel.HEADING_4;
    default:
      return HeadingLevel.HEADING_2;
  }
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; type: "png" | "jpg" | "gif" | "bmp" } | null {
  const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|gif|bmp);base64,(.+)$/i);
  if (!m) return null;
  const raw = m[2];
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  let type: "png" | "jpg" | "gif" | "bmp" = "png";
  const t = m[1].toLowerCase();
  if (t === "jpeg" || t === "jpg") type = "jpg";
  else if (t === "gif") type = "gif";
  else if (t === "bmp") type = "bmp";
  return { bytes, type };
}

function shouldSkip(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return true;
  if (el.matches?.(SKIP_SELECTORS)) return true;
  return false;
}

function walkNode(node: Node, out: DocChild[], listDepth = 0): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (t) out.push(new Paragraph({ children: [new TextRun(t)] }));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (shouldSkip(el)) return;

  const tag = el.tagName.toLowerCase();

  if (tag === "img") {
    const src = (el as HTMLImageElement).getAttribute("src") || "";
    const decoded = dataUrlToBytes(src);
    if (decoded) {
      out.push(
        new Paragraph({
          children: [
            new ImageRun({
              type: decoded.type,
              data: decoded.bytes,
              transformation: { width: 480, height: 270 },
            }),
          ],
        })
      );
    } else {
      const alt = el.getAttribute("alt") || "Image";
      out.push(new Paragraph({ children: [new TextRun(`[${alt}]`)] }));
    }
    return;
  }

  if (/^h[1-6]$/.test(tag)) {
    const text = visibleText(el);
    if (text) {
      out.push(
        new Paragraph({
          text,
          heading: headingLevel(tag),
          spacing: { after: 200 },
        })
      );
    }
    return;
  }

  if (tag === "p" || tag === "blockquote" || tag === "figcaption") {
    const text = visibleText(el);
    if (text) {
      out.push(
        new Paragraph({
          children: [
            new TextRun({
              text,
              italics: tag === "blockquote",
            }),
          ],
          spacing: { after: 160 },
        })
      );
    }
    return;
  }

  if (tag === "li") {
    const text = visibleText(el);
    if (text) {
      out.push(
        new Paragraph({
          text,
          bullet: { level: Math.min(listDepth, 4) },
          spacing: { after: 80 },
        })
      );
    }
    return;
  }

  if (tag === "ul" || tag === "ol") {
    for (const child of Array.from(el.children)) {
      if (child.tagName.toLowerCase() === "li") {
        walkNode(child, out, listDepth);
      }
    }
    return;
  }

  if (tag === "table") {
    const rows = Array.from(el.querySelectorAll("tr"));
    if (rows.length === 0) return;
    const tableRows = rows.map((tr) => {
      const cells = Array.from(tr.querySelectorAll("th,td"));
      return new TableRow({
        children: cells.map(
          (cell) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: [new TextRun(visibleText(cell) || " ")],
                }),
              ],
              width: { size: Math.floor(9000 / Math.max(cells.length, 1)), type: WidthType.DXA },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
                left: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
                right: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
              },
            })
        ),
      });
    });
    out.push(
      new Table({
        rows: tableRows,
        width: { size: 9000, type: WidthType.DXA },
      })
    );
    out.push(new Paragraph({ text: "" }));
    return;
  }

  // Containers: walk children (avoid double-walking nested text hosts)
  for (const child of Array.from(el.childNodes)) {
    walkNode(child, out, listDepth);
  }
}

function collectRoots(doc: Document): Element[] {
  const slides = Array.from(doc.querySelectorAll(SLIDE_ROOT_SELECTOR));
  if (slides.length > 0) return slides as Element[];
  const main =
    doc.querySelector("main, article, [role=main], .content, #content") ||
    doc.body;
  return main ? [main] : [];
}

/** Convert HTML string to a DOCX file as base64. */
export async function htmlToDocxBase64(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const roots = collectRoots(doc);
  if (roots.length === 0) {
    throw new Error("No document content found to export.");
  }

  const children: DocChild[] = [];
  roots.forEach((root, idx) => {
    if (idx > 0) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
    const title =
      root.querySelector("h1,h2,h3")?.textContent?.replace(/\s+/g, " ").trim() ||
      "";
    if (title && roots.length > 1 && idx === 0) {
      /* title will be walked */
    }
    walkNode(root, children);
  });

  if (children.length === 0) {
    children.push(
      new Paragraph({
        children: [new TextRun("Empty document")],
      })
    );
  }

  const document = new DocxDocument({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return Packer.toBase64String(document);
}

/** Lightweight title for save dialogs. */
export function documentExportBaseName(html: string, fallbackPath: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const t =
      doc.querySelector("title")?.textContent?.trim() ||
      doc.querySelector("h1")?.textContent?.trim() ||
      "";
    if (t) {
      return t
        .replace(/[^\w\s-]+/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 48) || "document";
    }
  } catch {
    /* ignore */
  }
  const file = fallbackPath.split(/[/\\]/).pop() ?? "document";
  return file.replace(/\.[^.]+$/, "") || "document";
}
