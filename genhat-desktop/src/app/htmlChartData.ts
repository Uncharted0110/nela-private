/**
 * Tabular data helpers for HTML dashboard artifacts.
 * Numeric values for file-backed charts are resolved in Rust; this module
 * prepares plans and builds data context for the model.
 */

import type { HtmlPlan, HtmlSection } from "../types";

/** Bound rows loaded for dashboard / HTML artifacts. */
export const MAX_ARTIFACT_SPREADSHEET_ROWS = 10_000;

const DATE_RE =
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[.\s-]+\d{1,2}/i;

const PROFILE_SAMPLE = 200;

export type SpreadsheetData = {
  headers: string[];
  rows: string[][];
  sheetName?: string;
  truncated?: boolean;
};

export type ColumnKind = "numeric" | "date" | "categorical";

/** How a column should be used when interpreting the sheet. */
export type ColumnRole =
  | "identifier"
  | "label"
  | "dimension"
  | "quantity"
  | "money"
  | "rate"
  | "date"
  | "text";

export type WorkbookDomain =
  | "inventory"
  | "sales"
  | "hr"
  | "support"
  | "finance"
  | "generic";

export type ColumnProfile = {
  name: string;
  kind: ColumnKind;
  role: ColumnRole;
  distinctCount: number;
};

export type SheetProfile = {
  name: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  truncated: boolean;
  columns: ColumnProfile[];
  numeric: string[];
  categorical: string[];
  dateLike: string[];
  domain: WorkbookDomain;
};

export type ParsedSpreadsheetSheet = {
  sheet_name: string;
  rows: string[][];
  truncated?: boolean;
};

export type ChartBinding = {
  chart_type: "bar" | "pie" | "line";
  title: string;
  label_column: string;
  value_column?: string;
  aggregation: "sum" | "count" | "avg" | "min" | "max";
  max_points?: number;
};

function filledCount(row: string[] | undefined): number {
  return row?.filter((c) => String(c ?? "").trim() !== "").length ?? 0;
}

function isNumericCell(raw: string): boolean {
  const v = raw.trim().replace(/[,$\u20b9\u20ac\u00a3%\s]/g, "");
  if (!v) return false;
  const n = Number(v.replace(/^\((.+)\)$/, "-$1"));
  return !Number.isNaN(n);
}

/** Skip title/banner rows common in Excel templates. */
export function findHeaderRowIndex(rows: string[][]): number {
  const limit = Math.min(rows.length, 8);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] ?? []).map((c) => String(c ?? "").trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const numericShare =
      cells.filter((c) => isNumericCell(c)).length / Math.max(1, cells.length);
    if (numericShare >= 0.45) continue;
    const nextFilled = filledCount(rows[i + 1]);
    let score = cells.length;
    if (nextFilled >= Math.max(2, cells.length * 0.5)) score += 8;
    if (cells.every((c) => c.length <= 40)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Load headers + body rows from parseSpreadsheetData output. */
export function spreadsheetFromParsed(rows: string[][]): SpreadsheetData | null {
  if (!rows.length) return null;
  const headerIdx = findHeaderRowIndex(rows);
  const headers = (rows[headerIdx] ?? []).map((h) => String(h ?? "").trim());
  if (!headers.some((h) => h)) return null;
  const body = rows
    .slice(headerIdx + 1)
    .filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  return { headers, rows: body };
}

/** Detect numeric columns from sample rows. */
export function numericColumns(headers: string[], rows: string[][]): string[] {
  return headers.filter((_, colIdx) =>
    rows.some((row) => {
      const v = (row[colIdx] ?? "").trim().replace(/,/g, "");
      return v !== "" && !Number.isNaN(Number(v));
    })
  );
}

/** Simple arithmetic for model-specified transforms (percent, ratio). */
export function evalMathExpr(expr: string, variables: Record<string, number>): number | null {
  const tokens = expr
    .trim()
    .replace(/\s+/g, "")
    .match(/[a-zA-Z_][a-zA-Z0-9_]*|\d+\.?\d*|[+\-*/()]/g);
  if (!tokens?.length) return null;

  let i = 0;
  const peek = () => tokens[i];
  const consume = () => tokens[i++];

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;
    while (peek() === "*" || peek() === "/") {
      const op = consume();
      const right = parseFactor();
      if (right === null) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }

  function parseFactor(): number | null {
    if (peek() === "(") {
      consume();
      const inner = parseExpr();
      if (consume() !== ")") return null;
      return inner;
    }
    const t = consume();
    if (!t) return null;
    if (/^\d/.test(t)) return Number(t);
    if (t in variables) return variables[t];
    return null;
  }

  const result = parseExpr();
  if (i !== tokens.length) return null;
  return result;
}

/**
 * When source data is attached, strip model-invented chart numbers and keep
 * only column bindings — Rust recomputes items deterministically.
 */
export function sanitizeHtmlPlanForSourceData(plan: HtmlPlan): HtmlPlan {
  const sections = (plan.sections ?? []).map((section) => {
    if (section.kind !== "CHART") return section;
    const hasColumns = section.label_column?.trim();
    if (!hasColumns) return section;
    return {
      ...section,
      items: [],
    };
  });
  return { ...plan, sections };
}

export function sheetsFromParsed(parsed: {
  sheet_name: string;
  rows: string[][];
  truncated?: boolean;
  sheets?: ParsedSpreadsheetSheet[];
}): ParsedSpreadsheetSheet[] {
  if (parsed.sheets && parsed.sheets.length > 0) {
    return parsed.sheets;
  }
  return [
    {
      sheet_name: parsed.sheet_name || "Sheet1",
      rows: parsed.rows ?? [],
      truncated: parsed.truncated,
    },
  ];
}

function inferDomain(headers: string[]): WorkbookDomain {
  const blob = headers.join(" ").toLowerCase();
  if (
    /\b(stock|inventory|sku|reorder|hand-?in-?stock|units?\s*sold|opening stock)\b/.test(
      blob
    )
  ) {
    return "inventory";
  }
  if (
    /\b(order|invoice|revenue|customer|qty|quantity|retail price)\b/.test(blob)
  ) {
    return "sales";
  }
  if (/\b(employee|salary|department|hire date|designation)\b/.test(blob)) {
    return "hr";
  }
  if (/\b(csat|call duration|sentiment|call center)\b/.test(blob)) {
    return "support";
  }
  if (/\b(amount|balance|profit|expense|budget)\b/.test(blob)) {
    return "finance";
  }
  return "generic";
}

function inferColumnRole(
  name: string,
  kind: ColumnKind,
  distinctCount: number,
  rowCount: number
): ColumnRole {
  const n = name.toLowerCase();
  if (kind === "date") return "date";
  if (
    /\b(id|sku|code|isbn|upc|barcode|#)\b/.test(n) ||
    /^(product|item|order|employee|customer)\s*id$/.test(n)
  ) {
    return "identifier";
  }
  if (kind === "numeric") {
    if (
      /(per\s*unit|unit\s*(cost|price)|price\s*per|rate|percent|%|csat)/.test(n)
    ) {
      return "rate";
    }
    if (
      /(price|cost|revenue|sales|amount|value|total|profit|tax|salary|fee)/.test(
        n
      )
    ) {
      return "money";
    }
    return "quantity";
  }
  const uniqueRatio = rowCount > 0 ? distinctCount / rowCount : 1;
  if (
    distinctCount >= 2 &&
    distinctCount <= Math.min(16, Math.max(3, rowCount * 0.35)) &&
    uniqueRatio <= 0.55
  ) {
    return "dimension";
  }
  if (/(name|title|product|item|description)/.test(n)) return "label";
  if (uniqueRatio > 0.85 && rowCount > 8) return "identifier";
  return "text";
}

function measurePriority(name: string, role: ColumnRole): number {
  const n = name.toLowerCase();
  if (role === "rate" || role === "identifier") return -10;
  let score = role === "money" ? 6 : role === "quantity" ? 5 : 0;
  if (/units?\s*sold|qty\s*sold|quantity\s*sold/.test(n)) score += 8;
  if (/cost price total|inventory value|stock value|total (cost|value)/.test(n))
    score += 7;
  if (/revenue|net sales|sales total/.test(n)) score += 7;
  if (/hand[- ]?in[- ]?stock|closing stock|on hand|current stock/.test(n))
    score += 5;
  if (/opening stock/.test(n)) score += 2;
  if (/purchase|stock[- ]?in/.test(n)) score += 3;
  return score;
}

function pickLabelColumn(profile: SheetProfile, prompt: string): string | undefined {
  const lower = prompt.toLowerCase();
  const mentioned = profile.columns.find(
    (c) =>
      (c.role === "dimension" || c.role === "label" || c.role === "date") &&
      lower.includes(c.name.toLowerCase())
  );
  if (mentioned) return mentioned.name;
  const dim = profile.columns.find((c) => c.role === "dimension");
  if (dim) return dim.name;
  const date = profile.columns.find((c) => c.role === "date");
  if (date && /\b(over time|trend|by date|timeline)\b/.test(lower)) return date.name;
  const label = profile.columns.find((c) => c.role === "label");
  if (label) return label.name;
  const text = profile.columns.find(
    (c) => c.role === "text" && c.kind === "categorical"
  );
  return text?.name ?? date?.name;
}

function pickMeasureColumns(profile: SheetProfile, prompt: string): ColumnProfile[] {
  const lower = prompt.toLowerCase();
  const measures = profile.columns
    .filter((c) => c.role === "money" || c.role === "quantity")
    .sort((a, b) => measurePriority(b.name, b.role) - measurePriority(a.name, a.role));
  const mentioned = measures.filter((c) => lower.includes(c.name.toLowerCase()));
  const ordered = mentioned.length ? [...mentioned, ...measures] : measures;
  const seen = new Set<string>();
  const out: ColumnProfile[] = [];
  for (const col of ordered) {
    if (seen.has(col.name)) continue;
    seen.add(col.name);
    out.push(col);
  }
  return out;
}

function cellKind(raw: string): ColumnKind | "empty" {
  const v = raw.trim();
  if (!v) return "empty";
  if (isNumericCell(v)) return "numeric";
  if (DATE_RE.test(v)) return "date";
  return "categorical";
}

export function profileSheet(
  name: string,
  data: SpreadsheetData,
  truncated = false
): SheetProfile {
  const sample = data.rows.slice(0, PROFILE_SAMPLE);
  const columns: ColumnProfile[] = data.headers.map((header, colIdx) => {
    const values = sample
      .map((row) => (row[colIdx] ?? "").trim())
      .filter(Boolean);
    const kinds = values.map(cellKind).filter((k) => k !== "empty");
    const numericN = kinds.filter((k) => k === "numeric").length;
    const dateN = kinds.filter((k) => k === "date").length;
    const catN = kinds.filter((k) => k === "categorical").length;
    let kind: ColumnKind = "categorical";
    if (kinds.length > 0) {
      if (dateN >= numericN && dateN >= catN && dateN / kinds.length >= 0.5) {
        kind = "date";
      } else if (numericN >= catN && numericN / kinds.length >= 0.5) {
        kind = "numeric";
      }
    }
    const distinct = new Set(values.map((v) => v.toLowerCase()));
    const role = inferColumnRole(
      header,
      kind,
      distinct.size,
      data.rows.length
    );
    return {
      name: header,
      kind,
      role,
      distinctCount: distinct.size,
    };
  });

  return {
    name,
    headers: data.headers,
    rows: data.rows,
    rowCount: data.rows.length,
    truncated,
    columns,
    numeric: columns.filter((c) => c.kind === "numeric").map((c) => c.name),
    categorical: columns
      .filter((c) => c.kind === "categorical")
      .map((c) => c.name),
    dateLike: columns.filter((c) => c.kind === "date").map((c) => c.name),
    domain: inferDomain(data.headers),
  };
}

export function profileWorkbook(
  sheets: ParsedSpreadsheetSheet[]
): SheetProfile[] {
  const out: SheetProfile[] = [];
  for (const sheet of sheets) {
    const data = spreadsheetFromParsed(sheet.rows);
    if (!data) continue;
    out.push(
      profileSheet(sheet.sheet_name || "Sheet1", data, Boolean(sheet.truncated))
    );
  }
  return out;
}

export function pickActiveSheet(
  profiles: SheetProfile[],
  prompt: string
): SheetProfile | null {
  if (!profiles.length) return null;
  const lower = prompt.toLowerCase();
  const named = profiles.find(
    (s) => s.name.trim() && lower.includes(s.name.trim().toLowerCase())
  );
  if (named) return named;
  return [...profiles].sort((a, b) => {
    if (b.numeric.length !== a.numeric.length) {
      return b.numeric.length - a.numeric.length;
    }
    return b.rowCount - a.rowCount;
  })[0]!;
}

export function sheetToSpreadsheetData(profile: SheetProfile): SpreadsheetData {
  return {
    headers: profile.headers,
    rows: profile.rows,
    sheetName: profile.name,
    truncated: profile.truncated,
  };
}

function formatColumnLine(col: ColumnProfile): string {
  const bits = [col.kind, col.role];
  if (col.kind !== "numeric") bits.push(`${col.distinctCount} distinct`);
  return `${col.name} (${bits.join(", ")})`;
}

function domainHint(domain: WorkbookDomain): string {
  switch (domain) {
    case "inventory":
      return "This is inventory data. KPIs: product count, units on hand, units sold, inventory value. Do not chart Product ID/SKU as pie slices. Prefer Product Name (top items) for bars. Sum stock/sold/value columns; never sum unit cost.";
    case "sales":
      return "This is sales/order data. KPIs: order count, revenue, quantity. Group by customer/region if those are dimensions; otherwise top products/customers.";
    case "hr":
      return "This is employee data. KPIs: headcount, total/avg salary. Chart by department or designation — not by Employee ID.";
    case "support":
      return "This is support/call data. KPIs: call volume, avg CSAT. Chart by sentiment, channel, or call center.";
    case "finance":
      return "This is financial data. Sum amounts/totals; average rates. Chart by category or time.";
    default:
      return "Use dimensions (low-cardinality categories) for grouping. Skip identifier columns (IDs). Sum totals; average unit rates.";
  }
}

function buildInterpretation(profile: SheetProfile): string {
  const label = pickLabelColumn(profile, "");
  const measures = pickMeasureColumns(profile, "").slice(0, 3);
  const skip = profile.columns
    .filter((c) => c.role === "identifier" || c.role === "rate")
    .map((c) => c.name);
  const recCharts = suggestChartBindings(profile, "");
  const chartLines = recCharts
    .map(
      (b, i) =>
        `${i + 1}. ${b.chart_type}: ${b.title} [${b.label_column}${
          b.value_column ? ` × ${b.value_column}` : ""
        }, ${b.aggregation}]`
    )
    .join("\n");
  return (
    `INTERPRETATION (follow this — do not invent numbers):\n` +
    `Domain: ${profile.domain}\n` +
    `${domainHint(profile.domain)}\n` +
    (label ? `Preferred chart labels: ${label}\n` : "") +
    (measures.length
      ? `Preferred measures: ${measures.map((m) => `${m.name} (${m.role})`).join("; ")}\n`
      : "") +
    (skip.length ? `Do not use as chart categories or summed KPIs: ${skip.join(", ")}\n` : "") +
    (chartLines ? `Suggested charts:\n${chartLines}\n` : "")
  );
}

export function buildHtmlDataContext(
  data: SpreadsheetData | null,
  sampleRows = 5
): string {
  if (!data) return "";
  const profile = profileSheet(data.sheetName || "Sheet1", data, data.truncated);
  return buildWorkbookDataContext([profile], profile, sampleRows);
}

export function buildWorkbookDataContext(
  profiles: SheetProfile[],
  active: SheetProfile | null,
  sampleRows = 12
): string {
  if (!profiles.length || !active) return "";
  const sheetList = profiles
    .map((s) => {
      const nums = s.numeric.length ? ` numeric: ${s.numeric.join(", ")}` : "";
      const cats = s.categorical.length
        ? ` categorical: ${s.categorical.join(", ")}`
        : "";
      const trunc = s.truncated ? ", truncated" : "";
      return `- ${s.name}: ${s.rowCount} rows${trunc};${nums}${cats}`;
    })
    .join("\n");
  const colLines = active.columns.map(formatColumnLine).join("; ");
  const sample = active.rows
    .slice(0, sampleRows)
    .map((row) => row.map((c) => c.trim()).join(" | "))
    .join("\n");
  const others = profiles.filter((s) => s.name !== active.name);
  const otherNote = others.length
    ? `Other sheets (not active): ${others
        .map((s) => `${s.name} [${s.headers.join(", ")}]`)
        .join("; ")}\n`
    : "";

  return (
    `ATTACHED WORKBOOK (use exact column names — do NOT invent numbers):\n` +
    `Sheets (${profiles.length}):\n${sheetList}\n` +
    `ACTIVE SHEET: ${active.name}` +
    `${active.truncated ? " (row sample truncated)" : ""}\n` +
    `Columns: [${active.headers.join(", ")}]\n` +
    `Column types: ${colLines}\n` +
    `Row count: ${active.rowCount}\n` +
    `Sample rows:\n${sample}\n` +
    otherNote +
    `\n${buildInterpretation(active)}` +
    `\nFor CHART sections: set label_column and value_column to real column names from the ACTIVE sheet. ` +
    `Leave items empty or omit items — values are computed from the file. ` +
    `Use aggregation: sum for totals/stock/sold/value; avg for unit cost/rate/percent; count when there is no numeric measure.\n` +
    `Do not chart identifier columns (IDs, SKUs). If labels are product/item names, that is a top-N ranking, not a pie of every row.\n\n`
  );
}

export function suggestChartBindings(
  profile: SheetProfile,
  prompt: string
): ChartBinding[] {
  const lower = prompt.toLowerCase();
  const label = pickLabelColumn(profile, prompt);
  const measures = pickMeasureColumns(profile, prompt);
  if (!label) return [];

  const labelCol = profile.columns.find((c) => c.name === label);
  const highCard = (labelCol?.distinctCount ?? 0) > 12;
  const labelIsDate = labelCol?.role === "date" || profile.dateLike.includes(label);
  const wantsPie = /\bpie\b/.test(lower) && !highCard;
  const wantsLine = /\bline\b/.test(lower) || labelIsDate;

  const aggFor = (role: ColumnRole | undefined): ChartBinding["aggregation"] =>
    role === "rate" ? "avg" : "sum";

  const bindings: ChartBinding[] = [];
  const first = measures[0];
  if (first) {
    bindings.push({
      chart_type: wantsPie ? "pie" : wantsLine ? "line" : "bar",
      title: highCard ? `Top ${first.name} by ${label}` : `${first.name} by ${label}`,
      label_column: label,
      value_column: first.name,
      aggregation: aggFor(first.role),
      max_points: wantsPie ? 8 : highCard ? 12 : 24,
    });
  } else {
    bindings.push({
      chart_type: highCard ? "bar" : "pie",
      title: `Count by ${label}`,
      label_column: label,
      aggregation: "count",
      max_points: highCard ? 12 : 8,
    });
  }

  const second = measures[1];
  if (second && bindings.length < 2) {
    const pieOk = !highCard && bindings[0]?.chart_type !== "pie";
    bindings.push({
      chart_type: pieOk && second.role === "money" ? "pie" : "bar",
      title: highCard ? `Top ${second.name} by ${label}` : `${second.name} by ${label}`,
      label_column: label,
      value_column: second.name,
      aggregation: aggFor(second.role),
      max_points: pieOk ? 8 : highCard ? 12 : 24,
    });
  }
  return bindings.slice(0, 2);
}

export function attachSpreadsheetToPlan(
  plan: HtmlPlan,
  data: SpreadsheetData
): HtmlPlan {
  return sanitizeHtmlPlanForSourceData({
    ...plan,
    headers: data.headers,
    source_rows: data.rows,
  });
}

/** Fill CHART sections that omitted column bindings, using profile heuristics. */
export function ensureChartBindingsOnPlan(
  plan: HtmlPlan,
  bindings: ChartBinding[]
): HtmlPlan {
  if (!bindings.length) return plan;
  let next = 0;
  const sections = (plan.sections ?? []).map((section) => {
    if (section.kind !== "CHART") return section;
    if (section.label_column?.trim()) return section;
    const b = bindings[next++];
    if (!b) return section;
    return {
      ...section,
      label_column: b.label_column,
      value_column: b.value_column,
      aggregation: b.aggregation,
      chart_type: section.chart_type || b.chart_type,
      title: section.title?.trim() ? section.title : b.title,
      items: [],
    };
  });
  return { ...plan, sections };
}

export function isChartSection(section: HtmlSection): boolean {
  return section.kind === "CHART";
}
