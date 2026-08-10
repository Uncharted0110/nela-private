/**
 * Persist Claude-style streamed artifact bodies to disk via existing generators.
 */

import { Api } from "../api";
import type { ArtifactResult } from "../types";
import {
  embedPoolImagesInHtml,
  type ImagePoolEntry,
} from "./artifactImagePool";
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

export async function saveStreamedHtmlArtifact(input: {
  rawBody: string;
  topic: string;
  asPresentation?: boolean;
  imagePool?: ImagePoolEntry[];
}): Promise<ArtifactResult> {
  const withImages = (html: string) =>
    input.imagePool?.length
      ? embedPoolImagesInHtml(html, input.imagePool)
      : html;

  if (input.asPresentation) {
    if (looksLikePresentationJsonPlan(input.rawBody)) {
      throw new Error("MODEL_RETURNED_JSON_SLIDE_PLAN");
    }
    const parsed = parsePresentationHtmlArtifactOutput(input.rawBody, input.topic);
    return Api.generateHtml({
      title: parsed.title,
      archetype: "landing",
      sections: [],
      html: withImages(parsed.html),
      output_name: parsed.output_name,
    });
  }

  if (looksLikeHtmlPageJsonPlan(input.rawBody)) {
    throw new Error("MODEL_RETURNED_JSON_HTML_PLAN");
  }
  const parsed = parseHtmlArtifactOutput(input.rawBody, input.topic);
  return Api.generateHtml({
    title: parsed.title,
    archetype: "landing",
    sections: [],
    html: withImages(parsed.html),
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
  });
}
