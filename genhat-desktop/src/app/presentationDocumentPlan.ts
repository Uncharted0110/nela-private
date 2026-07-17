/**
 * Deterministic presentation plans from attached document text.
 * Used when the LLM fails or returns unparseable JSON so PPT generation
 * still works from user-uploaded PDFs/DOCX.
 */

import { extractFieldValueRowsFromText } from "./spreadsheetPlan";
import { cleanPresentationTopic } from "./artifactPlanNormalize";

export interface PresentationDocumentFallback {
  userPrompt: string;
  ambientContent: string;
  theme?: string;
  targetSlideCount?: number;
}

function chunkRows(
  rows: string[][],
  perSlide: number
): string[][][] {
  const chunks: string[][][] = [];
  for (let i = 0; i < rows.length; i += perSlide) {
    chunks.push(rows.slice(i, i + perSlide));
  }
  return chunks;
}

function inferDeckTitle(prompt: string, ambient: string): string {
  const topic = cleanPresentationTopic(prompt);
  if (topic && !/^(presentation|deck|slides?)$/i.test(topic)) {
    return topic.slice(0, 80);
  }

  const fileMatch = ambient.match(/File:\s*"([^"]+)"/i);
  if (fileMatch?.[1]) {
    return fileMatch[1].replace(/\.[^.]+$/, "").slice(0, 80);
  }

  const firstLine = ambient
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(
      (l) =>
        l.length > 8 &&
        !/^file:/i.test(l) &&
        !/^content:/i.test(l) &&
        !/^===/i.test(l) &&
        !/privacy statement/i.test(l)
    );
  return (firstLine ?? "Document Overview").slice(0, 80);
}

/** Build bullet text from Field/Value pairs. */
function fieldBullets(rows: string[][]): string[] {
  return rows
    .map(([field, value]) => {
      const f = (field ?? "").trim();
      const v = (value ?? "").trim();
      if (!f || !v) return "";
      return `${f}: ${v}`;
    })
    .filter(Boolean);
}

/**
 * Extract paragraph-ish lines when field/value parsing finds nothing useful.
 */
function extractContentLines(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => {
      if (l.length < 12 || l.length > 220) return false;
      if (/^file:/i.test(l) || /^content:/i.test(l) || /^===/i.test(l)) return false;
      if (/privacy statement|dentsu\.com/i.test(l)) return false;
      if (/^-- \d+ of \d+ --$/i.test(l)) return false;
      if (/page \d+ of \d+/i.test(l)) return false;
      if (/^\(Content could not be extracted/i.test(l)) return false;
      return true;
    });

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
    if (unique.length >= 40) break;
  }
  return unique;
}

/**
 * Build a usable presentation plan directly from document text.
 * Returns null only when there is essentially no extractable content.
 */
export function buildPresentationFallbackPlan(
  opts: PresentationDocumentFallback
): Record<string, unknown> | null {
  const ambient = opts.ambientContent?.trim() ?? "";
  if (!ambient || /\(Content could not be extracted/i.test(ambient)) {
    return null;
  }

  const title = inferDeckTitle(opts.userPrompt, ambient);
  const target = Math.max(3, Math.min(12, opts.targetSlideCount ?? 6));
  const theme = opts.theme || "corporate";

  const extracted = extractFieldValueRowsFromText(ambient);
  const slides: Record<string, unknown>[] = [
    {
      title,
      layout: "TITLE",
      bullets: [
        "Generated from your attached document",
        "Key facts below are taken directly from the source",
      ],
    },
  ];

  if (extracted.rows.length >= 2) {
    const groups = chunkRows(extracted.rows, 5);
    const maxContentSlides = Math.max(1, target - 2);
    for (let i = 0; i < Math.min(groups.length, maxContentSlides); i++) {
      const bullets = fieldBullets(groups[i]);
      if (bullets.length === 0) continue;
      slides.push({
        title: i === 0 ? "Key Details" : `Details (${i + 1})`,
        layout: "BULLET",
        bullets,
      });
    }
  } else {
    const lines = extractContentLines(ambient);
    if (lines.length === 0) return null;
    const perSlide = 4;
    const maxContentSlides = Math.max(1, target - 2);
    for (let i = 0; i < Math.min(Math.ceil(lines.length / perSlide), maxContentSlides); i++) {
      const bullets = lines.slice(i * perSlide, (i + 1) * perSlide);
      slides.push({
        title: i === 0 ? "Document Highlights" : `Highlights (${i + 1})`,
        layout: "BULLET",
        bullets,
      });
    }
  }

  if (slides.length < 2) return null;

  slides.push({
    title: "Summary",
    layout: "CENTERED",
    bullets: [
      `Overview of ${title} based on the attached source document.`,
      "Regenerate with a clearer request if you want a different structure.",
    ],
  });

  const slug = title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return {
    slides,
    theme,
    output_name: slug || "document_presentation",
    _from_document_fallback: true,
  };
}
