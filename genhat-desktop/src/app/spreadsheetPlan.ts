/**
 * Spreadsheet artifact plan helpers — prompts, data context, and post-processing.
 */

import {
  extractSpreadsheetPlanFallback,
  parseJsonCandidates,
} from "./artifactPlanJson";
import type { SpreadsheetOp, SpreadsheetPlan } from "../types";

export interface SpreadsheetDataContext {
  headers?: string[];
  rows?: string[][];
  ambientContent?: string;
}

/** Build the user-message data context block for spreadsheet plan generation. */
export function buildSpreadsheetDataContext(ctx: SpreadsheetDataContext): string {
  if (ctx.headers && ctx.headers.length > 0) {
    const sampleRows = (ctx.rows ?? []).slice(0, 5);
    const sampleLines = sampleRows
      .map((row, i) => {
        const pairs = row
          .map((cell, j) => `${ctx.headers![j] ?? `col${j}`}=${cell}`)
          .join(", ");
        return `  Row ${i + 1}: ${pairs}`;
      })
      .join("\n");

    return (
      `ATTACHED SOURCE DATA (injected automatically — do NOT duplicate with WRITE_DATA):\n` +
      `Columns: [${ctx.headers.join(", ")}]\n` +
      `Row count: ${ctx.rows?.length ?? 0}\n` +
      (sampleLines ? `Sample rows:\n${sampleLines}\n` : "") +
      `\nUse transform operations (SORT, FILTER, SUM_COLUMN, COUNT_BY_GROUP, AVERAGE_BY_GROUP, ADD_COLUMN, PIVOT) on this data.\n` +
      `Column names in every op must EXACTLY match the column names above.\n\n`
    );
  }

  if (ctx.ambientContent && ctx.ambientContent.trim().length > 0) {
    return (
      `SOURCE DOCUMENT (no structured table attached — extract tabular data from this):\n` +
      `${ctx.ambientContent}\n\n` +
      `You MUST include a WRITE_DATA operation as the FIRST op with:\n` +
      `- "headers": clear, human-readable column names derived from the document\n` +
      `- "rows": one row per logical record; every row must have the same number of cells as headers\n` +
      `Extract only information present in the source. Map fields to columns systematically (e.g. Field, Value pairs for form data).\n\n`
    );
  }

  return (
    `NO SOURCE DATA ATTACHED.\n` +
    `You MUST include a WRITE_DATA operation as the FIRST op with realistic headers and rows that fulfill the user request.\n\n`
  );
}

const MAX_SPREADSHEET_ROWS = 500;

/**
 * Detect an explicit row/list count in the user prompt (e.g. "top 10 movies").
 */
export function extractSpreadsheetRowCount(text: string): {
  count: number | null;
  explicit: boolean;
} {
  const lower = text.toLowerCase();

  const patterns = [
    /\btop\s+(\d{1,3})\b/,
    /\b(\d{1,3})\s+(?:best|top|greatest|biggest|leading)\s+/,
    /\b(\d{1,3})\s+(?:movies?|films?|shows?|songs?|books?|games?|items?|entries|rows?|records|companies|products|countries|cities|people|names)\b/,
    /\b(?:list|create|make|generate|build)\s+(?:of\s+)?(?:the\s+)?(?:top\s+)?(\d{1,3})\b/,
    /\bexactly\s+(\d{1,3})\b/,
    /\b(\d{1,3})\s+row(?:s)?\b/,
  ];

  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      return {
        count: Math.min(MAX_SPREADSHEET_ROWS, n),
        explicit: true,
      };
    }
  }

  return { count: null, explicit: false };
}

/** Stable spreadsheet schema — cacheable across cloud artifact requests. */
export const SPREADSHEET_SCHEMA_STATIC = `You are a professional assistant that generates precise structural JSON plans for creating Excel spreadsheets.
You must return ONLY a JSON object conforming to the schema contract. Do NOT include markdown formatting, code fences (e.g. \`\`\`json), or thinking/explanations.

Schema Contract:
{"ops": [{"op": "SUM_COLUMN" | "AVERAGE_BY_GROUP" | "PIVOT" | "SORT_DESC" | "SORT_ASC" | "FILTER_ROWS" | "COUNT_BY_GROUP" | "ADD_COLUMN" | "RENAME_SHEET" | "WRITE_DATA", ...}], "output_name": "optional_filename_without_extension"}

Allowed Operations:
- SUM_COLUMN: { "col": "col_name", "label": "optional_label" } — adds a total row for a numeric column
- AVERAGE_BY_GROUP: { "value_col": "col_name", "group_col": "col_name" }
- PIVOT: { "row_col": "col_name", "col_col": "col_name", "value_col": "col_name" }
- SORT_DESC: { "col": "col_name" }
- SORT_ASC: { "col": "col_name" }
- FILTER_ROWS: { "col": "col_name", "value": "value_to_match" }
- COUNT_BY_GROUP: { "group_col": "col_name" }
- ADD_COLUMN: { "name": "new_col_name", "formula": "col_a + col_b" } — simple arithmetic using column names
- RENAME_SHEET: { "name": "sheet_name" } — short tab name only (max 31 characters, e.g. "Top Movies")
- WRITE_DATA: { "headers": ["col1", "col2"], "rows": [["v1", "v2"], ...] }

Output rules:
- Include "output_name" (no extension) describing the spreadsheet topic.
- Include RENAME_SHEET with a SHORT tab name (31 characters max — e.g. "Top Movies", not the full request).
- For document/form extraction, prefer columns like "Field" and "Value", or logical domain columns.
- When web search excerpts are provided, treat them as the only source of truth — never fabricate data not in those excerpts.
- Keep cell values as strings; numbers without currency symbols unless requested.`;

export type SpreadsheetSystemParts = {
  cacheable: string;
  dynamic: string;
};

export function buildSpreadsheetSystemParts(
  hasSourceData: boolean,
  rowCount?: number | null
): SpreadsheetSystemParts {
  const dataRules = hasSourceData
    ? `- Source data is already attached. Do NOT use WRITE_DATA to duplicate it.
- Use transform ops: SORT_ASC, SORT_DESC, FILTER_ROWS, SUM_COLUMN, COUNT_BY_GROUP, AVERAGE_BY_GROUP, ADD_COLUMN, PIVOT.
- Every "col", "group_col", "value_col", "row_col", "col_col" must EXACTLY match an attached column name.`
    : `- No source table is attached. Your FIRST op MUST be WRITE_DATA with complete "headers" and "rows".
- Populate rows from the source document context or from the user request. Do not leave rows empty.
- Use additional ops after WRITE_DATA only when needed (SORT, FILTER, RENAME_SHEET, etc.).`;

  const rowCountRule =
    rowCount && rowCount > 0
      ? `- The user requested EXACTLY ${rowCount} data rows in WRITE_DATA (not counting the header row).
- WRITE_DATA.rows MUST contain precisely ${rowCount} entries — do not stop at ${rowCount - 1}.
- Include a Rank or # column numbered 1 through ${rowCount} when listing ranked items.`
      : "";

  const dynamic = [
    "Data rules:",
    dataRules,
    rowCountRule ? `Row count rules:\n${rowCountRule}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { cacheable: SPREADSHEET_SCHEMA_STATIC, dynamic };
}

/** System prompt for spreadsheet synthesis plans. */
export function buildSpreadsheetSystemPrompt(
  hasSourceData: boolean,
  rowCount?: number | null
): string {
  const parts = buildSpreadsheetSystemParts(hasSourceData, rowCount);
  return `${parts.cacheable}\n\n${parts.dynamic}`;
}

function slugifySpreadsheetName(text: string): string {
  const slug = text
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return slug || "spreadsheet";
}

/** Excel worksheet names: max 31 chars; no \\ / * ? : [ ] */
export function sanitizeExcelSheetName(name: string): string {
  let cleaned = name.trim();
  const codeMatch = cleaned.match(/set_name\s*\(\s*["'](.+?)["']\s*\)/i);
  if (codeMatch) cleaned = codeMatch[1];
  cleaned = cleaned.replace(/^["']+|["']+$/g, "").trim();
  cleaned = cleaned.replace(/[\\/*?:\[\]]/g, "_");
  const chars = [...cleaned];
  const truncated = chars.slice(0, 31).join("").trim();
  return truncated || "Sheet1";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? ""));
}

function asStringMatrix(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => asStringArray(row));
}

function normalizeOp(raw: Record<string, unknown>): SpreadsheetOp | null {
  const op = String(raw.op ?? "").toUpperCase();
  if (!op) return null;

  switch (op) {
    case "SUM_COLUMN":
      return {
        op: "SUM_COLUMN",
        col: String(raw.col ?? ""),
        ...(raw.label != null ? { label: String(raw.label) } : {}),
      };
    case "AVERAGE_BY_GROUP":
      return {
        op: "AVERAGE_BY_GROUP",
        value_col: String(raw.value_col ?? ""),
        group_col: String(raw.group_col ?? ""),
      };
    case "PIVOT":
      return {
        op: "PIVOT",
        row_col: String(raw.row_col ?? ""),
        col_col: String(raw.col_col ?? ""),
        value_col: String(raw.value_col ?? ""),
      };
    case "SORT_DESC":
      return { op: "SORT_DESC", col: String(raw.col ?? "") };
    case "SORT_ASC":
      return { op: "SORT_ASC", col: String(raw.col ?? "") };
    case "FILTER_ROWS":
      return {
        op: "FILTER_ROWS",
        col: String(raw.col ?? ""),
        value: String(raw.value ?? ""),
      };
    case "COUNT_BY_GROUP":
      return { op: "COUNT_BY_GROUP", group_col: String(raw.group_col ?? "") };
    case "ADD_COLUMN":
      return {
        op: "ADD_COLUMN",
        name: String(raw.name ?? ""),
        formula: String(raw.formula ?? ""),
      };
    case "RENAME_SHEET":
      return {
        op: "RENAME_SHEET",
        name: sanitizeExcelSheetName(String(raw.name ?? "")),
      };
    case "WRITE_DATA":
      return {
        op: "WRITE_DATA",
        headers: asStringArray(raw.headers),
        rows: asStringMatrix(raw.rows),
      };
    default:
      return null;
  }
}

/** Normalize and validate a spreadsheet plan before sending to the Excel sidecar. */
export function normalizeSpreadsheetPlan(
  plan: Record<string, unknown>,
  options: { prompt: string; hasSourceData: boolean; expectedRowCount?: number | null }
): SpreadsheetPlan {
  const rawOps = Array.isArray(plan.ops) ? plan.ops : [];
  let ops: SpreadsheetOp[] = rawOps
    .map((item) =>
      item && typeof item === "object"
        ? normalizeOp(item as Record<string, unknown>)
        : null
    )
    .filter((op): op is SpreadsheetOp => op !== null);

  if (options.hasSourceData) {
    ops = ops.filter((op) => op.op !== "WRITE_DATA");
  } else {
    const writeIdx = ops.findIndex((op) => op.op === "WRITE_DATA");
    if (writeIdx > 0) {
      const writeOp = ops[writeIdx];
      ops = [writeOp, ...ops.filter((_, i) => i !== writeIdx)];
    }
  }

  if (!options.hasSourceData) {
    const writeOp = ops.find((op) => op.op === "WRITE_DATA");
    if (writeOp && writeOp.op === "WRITE_DATA") {
      const width = writeOp.headers.length;
      writeOp.rows = writeOp.rows
        .map((row) => {
          const padded = [...row];
          while (padded.length < width) padded.push("");
          return padded.slice(0, width);
        })
        .filter((row) => row.some((cell) => cell.trim().length > 0));

      const expected = options.expectedRowCount;
      if (expected && expected > 0 && writeOp.rows.length < expected) {
        console.warn(
          `WRITE_DATA has ${writeOp.rows.length} data rows but ${expected} were requested.`
        );
      }
    }
  }

  const hasRename = ops.some((op) => op.op === "RENAME_SHEET");
  if (!hasRename) {
    ops.push({
      op: "RENAME_SHEET",
      name: sanitizeExcelSheetName(slugifySpreadsheetName(options.prompt)),
    });
  } else {
    for (const op of ops) {
      if (op.op === "RENAME_SHEET") {
        op.name = sanitizeExcelSheetName(op.name);
      }
    }
  }

  const output_name =
    typeof plan.output_name === "string" && plan.output_name.trim()
      ? plan.output_name.trim()
      : slugifySpreadsheetName(options.prompt);

  const normalized: SpreadsheetPlan = {
    ops,
    output_name,
  };

  if (options.hasSourceData && Array.isArray(plan.headers) && Array.isArray(plan.source_rows)) {
    normalized.headers = asStringArray(plan.headers);
    normalized.source_rows = asStringMatrix(plan.source_rows);
  }

  return normalized;
}

/** Estimate plan token budget from expected WRITE_DATA size. */
export function spreadsheetPlanMaxTokens(
  hasSourceData: boolean,
  ambientContent?: string,
  rowCount?: number | null
): number {
  if (hasSourceData) return 800;
  const ambientLen = ambientContent?.length ?? 0;
  if (rowCount && rowCount > 0) {
    return Math.min(2048, 512 + rowCount * 180);
  }
  if (ambientLen > 6000) return 2048;
  if (ambientLen > 2000) return 1536;
  return 1200;
}

/**
 * Extract Field/Value rows from unstructured document text (PDF forms, onboarding docs).
 * Used when the model fails to emit valid WRITE_DATA JSON.
 */
export function extractFieldValueRowsFromText(text: string): {
  headers: string[];
  rows: string[][];
} {
  const headers = ["Field", "Value"];
  const rows: string[][] = [];
  const seen = new Set<string>();

  const pushRow = (field: string, value: string) => {
    const f = field.replace(/\s+/g, " ").trim();
    const v = value.replace(/\s+/g, " ").trim();
    if (!f || !v || f === v) return;
    const key = `${f}\0${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push([f, v]);
  };

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const metadataValues = new Set([
    "yes",
    "no",
    "primary",
    "private",
    "public was private",
    "usage",
    "visibility",
    "wa",
    "s",
  ]);

  const isNoise = (line: string): boolean => {
    const lower = line.toLowerCase().trim();
    if (!lower || lower.length <= 1) return true;
    if (metadataValues.has(lower)) return true;
    if (/privacy statement|dentsu\.com/i.test(line)) return true;
    if (/^tasks to complete/i.test(line)) return true;
    if (/^you can access/i.test(line)) return true;
    if (/^-- \d+ of \d+ --$/i.test(line)) return true;
    if (/page \d+ of \d+/i.test(line)) return true;
    if (/^\(\d+\)$/.test(line)) return true;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}page/i.test(lower)) return true;
    return false;
  };

  const isSectionHeader = (line: string): boolean =>
    /^(change home contact information|change personal information|place of birth|nationality|health|last medical exam)$/i.test(
      line.trim()
    );

  const findLabelBefore = (index: number): string | null => {
    for (let j = index - 1; j >= 0 && j >= index - 12; j--) {
      const candidate = lines[j];
      if (isNoise(candidate) || isSectionHeader(candidate)) continue;
      if (candidate.length > 80) continue;
      return candidate;
    }
    return null;
  };

  // Pass 1: "value added" markers (common in HR onboarding exports).
  for (let i = 0; i < lines.length; i++) {
    const addedMatch = lines[i].match(/^(.+?)\s+added$/i);
    if (!addedMatch) continue;
    const value = addedMatch[1].trim();
    const field = findLabelBefore(i);
    if (field) pushRow(field, value);
  }

  // Pass 2: consecutive label → value pairs.
  for (let i = 0; i < lines.length - 1; i++) {
    if (isNoise(lines[i]) || isNoise(lines[i + 1])) continue;
    if (isSectionHeader(lines[i])) continue;
    if (/\s+added$/i.test(lines[i + 1])) continue;

    const field = lines[i];
    let value = lines[i + 1];

    // Skip repeated header lines before the value (e.g. "Legal Name" x3 then value).
    if (value === field && i + 2 < lines.length) {
      value = lines[i + 2];
      i += 2;
    } else {
      i += 1;
    }

    if (isNoise(value) || isSectionHeader(value)) continue;
    pushRow(field, value);
  }

  return { headers, rows };
}

export interface SpreadsheetPlanParseFallback {
  prompt: string;
  hasSourceData: boolean;
  ambientContent?: string;
}

function buildWriteDataFromText(text: string): Record<string, unknown> | null {
  const extracted = extractFieldValueRowsFromText(text);
  if (extracted.rows.length === 0) return null;
  return {
    ops: [
      {
        op: "WRITE_DATA",
        headers: extracted.headers,
        rows: extracted.rows,
      },
    ],
  };
}

function spreadsheetPlanFromAmbient(
  fallback: SpreadsheetPlanParseFallback
): Record<string, unknown> | null {
  if (fallback.ambientContent?.trim()) {
    const plan = buildWriteDataFromText(fallback.ambientContent);
    if (plan) return plan;
  }
  return null;
}

export function buildSpreadsheetFallbackPlan(
  fallback: SpreadsheetPlanParseFallback
): Record<string, unknown> | null {
  if (fallback.hasSourceData) {
    return { ops: [] };
  }
  return spreadsheetPlanFromAmbient(fallback);
}

/**
 * Parse a spreadsheet plan — tries JSON, salvages partial ops, then falls back
 * to attached source data or document field extraction. Never leaves the caller
 * without a plan when any text source is available.
 */
export function parseSpreadsheetPlanJson(
  raw: string,
  fallback: SpreadsheetPlanParseFallback
): Record<string, unknown> {
  if (!raw.trim()) {
    if (fallback.hasSourceData) {
      console.warn("Spreadsheet plan empty; using attached source data only.");
      return { ops: [] };
    }
    const ambient = spreadsheetPlanFromAmbient(fallback);
    if (ambient) return ambient;
    throw new Error("Model produced no output for spreadsheet plan.");
  }

  const direct = parseJsonCandidates(raw);
  if (direct && Array.isArray(direct.ops) && direct.ops.length > 0) {
    return direct;
  }
  if (direct && fallback.hasSourceData) {
    return direct;
  }

  const salvaged = extractSpreadsheetPlanFallback(raw);
  if (salvaged) return salvaged;

  if (fallback.hasSourceData) {
    console.warn(
      "Spreadsheet plan JSON parse failed; using attached source data only. Output preview:",
      raw.slice(0, 400)
    );
    return { ops: [] };
  }

  const ambient = spreadsheetPlanFromAmbient(fallback);
  if (ambient) {
    console.warn(
      "Spreadsheet plan JSON parse failed; built WRITE_DATA from document text. Output preview:",
      raw.slice(0, 400)
    );
    return ambient;
  }

  if (direct) return direct;

  // Last resort: try field extraction on whatever the model did output.
  const fromRaw = buildWriteDataFromText(raw);
  if (fromRaw) {
    console.warn(
      "Spreadsheet plan salvage from raw model text. Preview:",
      raw.slice(0, 400)
    );
    return fromRaw;
  }

  console.error(
    "Spreadsheet plan parse failed with no document fallback. Model output:",
    raw.slice(0, 800)
  );
  throw new Error("No valid JSON object found in model output.");
}
