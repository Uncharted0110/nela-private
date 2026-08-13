/**
 * Persist Claude-style streamed artifact bodies to disk via existing generators.
 */

import { Api } from "../api";
import type { ArtifactResult } from "../types";
import {
  embedPoolImagesInHtml,
  type ImagePoolEntry,
} from "./artifactImagePool";
import {
  embedPoolChartsInHtml,
  type ChartPoolEntry,
} from "./artifactChartPool";
import { parseCSV } from "./send/csvParse";
import { extractCsvSheetArtifacts } from "./sanitizeCsvArtifact";
import {
  deriveArtifactFilename,
  extractWorkbookFilename,
} from "./artifactFilename";
import {
  normalizeSpreadsheetPlan,
  sanitizeExcelSheetName,
} from "./spreadsheetPlan";
import {
  parseHtmlArtifactOutput,
  parsePresentationHtmlArtifactOutput,
  looksLikeHtmlPageJsonPlan,
  looksLikePresentationJsonPlan,
} from "./artifactHtmlOutput";
import type { NelaArtifactMime } from "./streamArtifactParser";
import { applyThemeFromPrompt } from "./send/freeformHtmlThemeEdit";

function withThemeOverride(html: string, topic: string): string {
  try {
    // Skip NELA shell decks — they already use CSS vars / named themes.
    if (
      html.includes("deck-container") &&
      html.includes("slide-stage") &&
      html.includes('class="slide')
    ) {
      return html;
    }
    return applyThemeFromPrompt(html, topic).html;
  } catch (err) {
    console.warn("Theme palette inject failed:", err);
    return html;
  }
}

function withMediaEmbeds(
  html: string,
  imagePool?: ImagePoolEntry[],
  chartPool?: ChartPoolEntry[]
): string {
  let out = html;
  if (imagePool?.length) out = embedPoolImagesInHtml(out, imagePool);
  if (chartPool?.length) out = embedPoolChartsInHtml(out, chartPool);
  return out;
}

export async function saveStreamedHtmlArtifact(input: {
  rawBody: string;
  topic: string;
  filename?: string;
  asPresentation?: boolean;
  imagePool?: ImagePoolEntry[];
  chartPool?: ChartPoolEntry[];
}): Promise<ArtifactResult> {
  const embed = (html: string) =>
    withMediaEmbeds(html, input.imagePool, input.chartPool);

  if (input.asPresentation) {
    if (looksLikePresentationJsonPlan(input.rawBody)) {
      throw new Error("MODEL_RETURNED_JSON_SLIDE_PLAN");
    }
    const parsed = parsePresentationHtmlArtifactOutput(input.rawBody, input.topic);
    const themed = withThemeOverride(embed(parsed.html), input.topic);
    const outputName = deriveArtifactFilename({
      llmName: input.filename || extractWorkbookFilename(input.rawBody),
      htmlTitle: parsed.title,
      topic: input.topic,
      fallback: "presentation",
    });
    return Api.generateHtml({
      title: parsed.title,
      archetype: "landing",
      sections: [],
      html: themed,
      output_name: outputName,
    });
  }

  if (looksLikeHtmlPageJsonPlan(input.rawBody)) {
    throw new Error("MODEL_RETURNED_JSON_HTML_PLAN");
  }
  const parsed = parseHtmlArtifactOutput(input.rawBody, input.topic);
  const themed = withThemeOverride(embed(parsed.html), input.topic);
  const outputName = deriveArtifactFilename({
    llmName: input.filename || extractWorkbookFilename(input.rawBody),
    htmlTitle: parsed.title,
    topic: input.topic,
    fallback: "webpage",
  });
  return Api.generateHtml({
    title: parsed.title,
    archetype: "landing",
    sections: [],
    html: themed,
    output_name: outputName,
  });
}

export async function saveStreamedCsvArtifact(input: {
  rawBody: string;
  topic: string;
  title?: string;
  filename?: string;
}): Promise<ArtifactResult> {
  const sheetArtifacts = extractCsvSheetArtifacts(input.rawBody);
  if (!sheetArtifacts.length) {
    throw new Error("Streamed CSV was empty after removing artifact tags");
  }

  const sheets = sheetArtifacts
    .map((sheet, idx) => {
      const { headers, rows } = parseCSV(sheet.csv);
      const cleanHeaders = headers.filter((h) => !/<\/?nela-artifact\b/i.test(h));
      const cleanRows = rows.filter(
        (row) => !row.some((cell) => /<\/?nela-artifact\b/i.test(cell || ""))
      );
      if (!cleanHeaders.length) return null;
      const name = sanitizeExcelSheetName(
        sheet.title || input.title || `Sheet${idx + 1}`
      );
      return {
        name,
        ops: [
          { op: "WRITE_DATA" as const, headers: cleanHeaders, rows: cleanRows },
        ],
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  if (!sheets.length) {
    throw new Error("Streamed CSV had no header row");
  }

  const outputName = deriveArtifactFilename({
    llmName:
      input.filename ||
      extractWorkbookFilename(input.rawBody) ||
      null,
    topic: input.topic,
    fallback: "spreadsheet",
  });

  return Api.generateSpreadsheet(
    normalizeSpreadsheetPlan(
      {
        sheets,
        ops: [],
        output_name: outputName,
      },
      { prompt: input.topic, hasSourceData: false }
    )
  );
}

export async function saveStreamedArtifact(input: {
  type: NelaArtifactMime;
  rawBody: string;
  topic: string;
  title?: string;
  filename?: string;
  asPresentation?: boolean;
  imagePool?: ImagePoolEntry[];
  chartPool?: ChartPoolEntry[];
}): Promise<ArtifactResult> {
  if (input.type === "text/csv") {
    return saveStreamedCsvArtifact({
      rawBody: input.rawBody,
      topic: input.topic,
      title: input.title,
      filename: input.filename,
    });
  }
  return saveStreamedHtmlArtifact({
    rawBody: input.rawBody,
    topic: input.topic,
    filename: input.filename,
    asPresentation: input.asPresentation,
    imagePool: input.imagePool,
    chartPool: input.chartPool,
  });
}
