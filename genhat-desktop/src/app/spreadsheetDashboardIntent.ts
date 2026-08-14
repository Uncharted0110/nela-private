/**
 * Routing helpers: attached spreadsheet + dashboard/chart language → HTML artifact.
 * "Make a new Excel" stays spreadsheet_synthesis; plain Q&A stays chat.
 */

export const SPREADSHEET_PATH_RE = /\.(xlsx|xls|ods|csv|tsv)$/i;

export const DASHBOARD_HTML_TOOL = "mcp-server-html";
export const DASHBOARD_HTML_SCHEMA = "html_synthesis";

const DASHBOARD_LANGUAGE_RE =
  /\b(dashboard|kpi|kpis|analytics|visuali[sz]e|visuali[sz]ation|data visualization|pie chart|bar chart|bar graph|line chart|line graph|charts?|plots?)\b/i;

const INFO_SEEKING_RE =
  /^(explain\b|why\b|how does\b|how did\b|how do\b|how can\b|what is\b|what are\b|what was\b|what were\b|what does\b|what did\b|who\b|when\b|where\b|tell me\b|describe\b|summarize\b|can you explain|could you explain|please explain)/i;

const CREATE_VERB_RE =
  /\b(create|make|build|generate|synthesis|synthesize|render|output|write|give me|show me|put in|convert)\b/i;

const EXCEL_ARTIFACT_RE = /\b(excel|spreadsheet|xlsx|workbook)\b/i;

export function isSpreadsheetPath(path: string): boolean {
  return SPREADSHEET_PATH_RE.test(path);
}

export function hasSpreadsheetAttach(paths: string[] | undefined | null): boolean {
  return Boolean(paths?.some((p) => isSpreadsheetPath(p)));
}

/** User wants a new .xlsx artifact, not an HTML dashboard from an attached file. */
export function wantsNewSpreadsheetArtifact(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  if (!CREATE_VERB_RE.test(lower) || !EXCEL_ARTIFACT_RE.test(lower)) return false;
  return !/\bdashboard\b/i.test(lower);
}

/** Attached workbook should become an HTML dashboard / chart page. */
export function wantsSpreadsheetDashboard(prompt: string): boolean {
  if (wantsNewSpreadsheetArtifact(prompt)) return false;
  if (INFO_SEEKING_RE.test(prompt.trim())) return false;
  return DASHBOARD_LANGUAGE_RE.test(prompt);
}
