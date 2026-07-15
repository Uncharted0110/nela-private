/**
 * Build spreadsheet plans directly from extracted web tables — bypasses the LLM
 * for WRITE_DATA so box-office / list queries use authoritative source values.
 */

import type { ExtractedWebTable, SpreadsheetPlan } from "../types";
import { normalizeSpreadsheetPlan, sanitizeExcelSheetName } from "./spreadsheetPlan";

function slugifySpreadsheetName(text: string): string {
  return text
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "spreadsheet";
}

/** Minimum rows required before trusting a web-extracted table. */
const MIN_WEB_TABLE_ROWS = 2;

const COLUMN_ALIASES: Record<string, string[]> = {
  rank: ["rank", "peak", "#", "no.", "no", "number", "pos", "position"],
  title: ["title", "film", "movie", "name"],
  year: ["year", "release year", "released", "release"],
  boxOffice: [
    "worldwide gross",
    "gross",
    "box office",
    "worldwide",
    "revenue",
    "earnings",
    "worldwide box office",
  ],
};

function headerIndex(headers: string[], aliases: string[]): number | null {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const alias of aliases) {
    const exact = lower.findIndex((h) => h === alias);
    if (exact >= 0) return exact;
    const partial = lower.findIndex((h) => h.includes(alias));
    if (partial >= 0) return partial;
  }
  return null;
}

/**
 * Map extracted columns to the fields the user asked for (e.g. Rank, Title, Year, Box Office).
 */
export function remapTableColumnsForPrompt(
  table: ExtractedWebTable,
  prompt: string
): ExtractedWebTable {
  const lower = prompt.toLowerCase();
  const requested: { key: string; label: string }[] = [];

  if (/\brank\b/i.test(prompt)) requested.push({ key: "rank", label: "Rank" });
  if (/\btitle\b|\bmovie\b|\bfilm\b/i.test(prompt)) {
    requested.push({ key: "title", label: "Title" });
  }
  if (/\byear\b/i.test(prompt)) requested.push({ key: "year", label: "Year" });
  if (/box office|gross|revenue/i.test(prompt)) {
    requested.push({ key: "boxOffice", label: "Box Office" });
  }

  // Default column set for highest-grossing movie queries.
  if (
    requested.length === 0 &&
    (lower.includes("grossing") ||
      lower.includes("box office") ||
      lower.includes("movie") ||
      lower.includes("film"))
  ) {
    requested.push(
      { key: "rank", label: "Rank" },
      { key: "title", label: "Title" },
      { key: "year", label: "Year" },
      { key: "boxOffice", label: "Box Office" }
    );
  }

  if (requested.length === 0) {
    return table;
  }

  const indices = requested.map(({ key }) => {
    const aliases = COLUMN_ALIASES[key] ?? [];
    return headerIndex(table.headers, aliases);
  });

  // If we cannot map any columns, keep the source table as-is.
  if (indices.every((idx) => idx === null)) {
    return table;
  }

  const headers = requested.map(({ label }) => label);
  const rows = table.rows.map((row) =>
    indices.map((idx, i) => {
      if (idx !== null && idx < row.length) return row[idx] ?? "";
      // Fall back to positional mapping when headers are misaligned.
      return row[i] ?? "";
    })
  );

  return { ...table, headers, rows };
}

export function buildSpreadsheetPlanFromWebTable(
  table: ExtractedWebTable,
  prompt: string
): SpreadsheetPlan {
  const mapped = remapTableColumnsForPrompt(table, prompt);
  const sheetName = sanitizeExcelSheetName(slugifySpreadsheetName(prompt));
  return {
    ops: [
      {
        op: "WRITE_DATA",
        headers: [...mapped.headers],
        rows: mapped.rows.map((r) => [...r]),
      },
      { op: "RENAME_SHEET", name: sheetName },
    ],
    output_name: slugifySpreadsheetName(prompt),
  };
}

/**
 * When web search returns a structured table, build a plan without calling the LLM.
 * Returns null if the table is too small or unreliable.
 */
export function tryBuildDeterministicWebSpreadsheetPlan(
  tables: ExtractedWebTable[] | undefined,
  prompt: string,
  expectedRows: number | null
): SpreadsheetPlan | null {
  if (!tables?.length) return null;

  const table = tables[0];
  if (!table.headers?.length || table.rows.length < MIN_WEB_TABLE_ROWS) {
    return null;
  }

  // Reject historical silent-era tables that slipped through scoring.
  const firstRow = table.rows[0]?.join(" ").toLowerCase() ?? "";
  if (
    firstRow.includes("birth of a nation") ||
    firstRow.includes("1915") ||
    (table.headers[0]?.toLowerCase() === "year" &&
      !table.headers.some((h) => h.toLowerCase() === "rank"))
  ) {
    return null;
  }

  if (expectedRows && table.rows.length < Math.min(expectedRows, 3)) {
    return null;
  }

  let rows = table.rows;
  if (expectedRows && expectedRows > 0 && rows.length > expectedRows) {
    rows = rows.slice(0, expectedRows);
  }

  const trimmed: ExtractedWebTable = { ...table, rows };
  const raw = buildSpreadsheetPlanFromWebTable(trimmed, prompt);
  return normalizeSpreadsheetPlan(raw as unknown as Record<string, unknown>, {
    prompt,
    hasSourceData: false,
    expectedRowCount: expectedRows,
  });
}
