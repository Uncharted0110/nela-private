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
import { sanitizeCsvArtifactBody } from "./sanitizeCsvArtifact";
import { normalizeSpreadsheetPlan } from "./spreadsheetPlan";
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
    return Api.generateHtml({
      title: parsed.title,
      archetype: "landing",
      sections: [],
      html: themed,
      output_name: parsed.output_name,
    });
  }

  if (looksLikeHtmlPageJsonPlan(input.rawBody)) {
    throw new Error("MODEL_RETURNED_JSON_HTML_PLAN");
  }
  const parsed = parseHtmlArtifactOutput(input.rawBody, input.topic);
  const themed = withThemeOverride(embed(parsed.html), input.topic);
  return Api.generateHtml({
    title: parsed.title,
    archetype: "landing",
    sections: [],
    html: themed,
    output_name: parsed.output_name,
  });
}

export async function saveStreamedCsvArtifact(input: {
  rawBody: string;
  topic: string;
  title?: string;
}): Promise<ArtifactResult> {
  let csv = sanitizeCsvArtifactBody(input.rawBody);
  if (!csv) {
    throw new Error("Streamed CSV was empty after removing artifact tags");
  }
  const { headers, rows } = parseCSV(csv);
  // Drop any residual tag rows that survived as "data".
  const cleanHeaders = headers.filter((h) => !/<\/?nela-artifact\b/i.test(h));
  const cleanRows = rows.filter(
    (row) => !row.some((cell) => /<\/?nela-artifact\b/i.test(cell || ""))
  );
  if (!cleanHeaders.length) {
    throw new Error("Streamed CSV had no header row");
  }
  const outputName = (input.title || input.topic || "spreadsheet")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return Api.generateSpreadsheet(
    normalizeSpreadsheetPlan(
      {
        ops: [
          { op: "WRITE_DATA", headers: cleanHeaders, rows: cleanRows },
          {
            op: "RENAME_SHEET",
            name: (outputName || "Sheet").slice(0, 31),
          },
        ],
        output_name: outputName || "spreadsheet",
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
  asPresentation?: boolean;
  imagePool?: ImagePoolEntry[];
  chartPool?: ChartPoolEntry[];
}): Promise<ArtifactResult> {
  if (input.type === "text/csv") {
    return saveStreamedCsvArtifact({
      rawBody: input.rawBody,
      topic: input.topic,
      title: input.title,
    });
  }
  return saveStreamedHtmlArtifact({
    rawBody: input.rawBody,
    topic: input.topic,
    asPresentation: input.asPresentation,
    imagePool: input.imagePool,
    chartPool: input.chartPool,
  });
}
