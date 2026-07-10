/**
 * Tabular data helpers for HTML dashboard artifacts.
 * Numeric values for file-backed charts are resolved in Rust; this module
 * prepares plans and builds data context for the model.
 */

import type { HtmlPlan, HtmlSection } from "../types";

export type SpreadsheetData = {
  headers: string[];
  rows: string[][];
};

/** Load headers + body rows from parseSpreadsheetData output. */
export function spreadsheetFromParsed(rows: string[][]): SpreadsheetData | null {
  if (!rows.length) return null;
  const headers = rows[0].map((h) => h.trim());
  const body = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
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

export function buildHtmlDataContext(
  data: SpreadsheetData | null,
  sampleRows = 5
): string {
  if (!data) return "";
  const nums = numericColumns(data.headers, data.rows);
  const sample = data.rows
    .slice(0, sampleRows)
    .map((row) => row.map((c) => c.trim()).join(" | "))
    .join("\n");

  return (
    `ATTACHED DATA (use exact column names — do NOT invent numbers):\n` +
    `Columns: [${data.headers.join(", ")}]\n` +
    `Numeric columns: [${nums.join(", ")}]\n` +
    `Row count: ${data.rows.length}\n` +
    `Sample rows:\n${sample}\n\n` +
    `For CHART sections: set label_column and value_column to real column names. ` +
    `Leave items empty or omit items — values are computed from the file. ` +
    `Use aggregation: sum | count | avg | min | max.\n\n`
  );
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

export function isChartSection(section: HtmlSection): boolean {
  return section.kind === "CHART";
}
