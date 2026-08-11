/**
 * Clean model CSV output before parse/save/preview.
 * Models often leave <nela-artifact> tags or chat prose around the table.
 * Supports multiple CSV sheets via multiple <nela-artifact type="text/csv"> blocks.
 */

export interface CsvSheetArtifact {
  title: string;
  csv: string;
}

/** Extract every CSV nela-artifact block (multi-sheet). Falls back to one sheet. */
export function extractCsvSheetArtifacts(raw: string): CsvSheetArtifact[] {
  const s = (raw || "").trim();
  if (!s) return [];

  const re = /<nela-artifact\b([^>]*)>([\s\S]*?)<\/nela-artifact\s*>/gi;
  const sheets: CsvSheetArtifact[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    const attrs = match[1] || "";
    const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const mime = (typeMatch?.[1] || "text/csv").toLowerCase();
    if (mime !== "text/csv" && mime !== "csv") continue;

    const titleMatch = attrs.match(/\btitle\s*=\s*["']([^"']+)["']/i);
    const title = (titleMatch?.[1] || `Sheet${sheets.length + 1}`).trim();
    const csv = sanitizeCsvInner(match[2] || "");
    if (!csv) continue;
    sheets.push({ title, csv });
  }

  if (sheets.length > 0) return sheets;

  const fallback = sanitizeCsvInner(s);
  if (!fallback) return [];
  return [{ title: "Sheet1", csv: fallback }];
}

/** Sanitize a single CSV body (legacy / preview helper). Uses first artifact if present. */
export function sanitizeCsvArtifactBody(raw: string): string {
  const sheets = extractCsvSheetArtifacts(raw);
  if (sheets.length > 0) return sheets[0]!.csv;

  let s = (raw || "").trim();
  if (!s) return "";
  return sanitizeCsvInner(s);
}

function sanitizeCsvInner(raw: string): string {
  let s = (raw || "").trim();
  if (!s) return "";

  // Drop open/close tags if the model left them as stray lines.
  s = s
    .replace(/<nela-artifact\b[^>]*>/gi, "\n")
    .replace(/<\/nela-artifact\s*>/gi, "\n")
    .trim();

  // Markdown fences
  s = s.replace(/^```(?:csv|CSV)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const lines = s.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (/<\/?nela-artifact\b/i.test(line)) continue;
    if (
      /^(?:here(?:'s| is)|i(?:'ll| will)|sure|below|this (?:is|sheet)|i've|i have)\b/i.test(
        line
      ) &&
      line.split(",").length < 3
    ) {
      continue;
    }
    if (countCsvColumns(line) >= 2) {
      start = i;
      break;
    }
  }

  if (start < 0) return s;

  const kept: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (/<\/?nela-artifact\b/i.test(line)) continue;
    kept.push(line);
  }

  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
  return kept.join("\n").trim();
}

function countCsvColumns(line: string): number {
  let cols = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) cols += 1;
  }
  return cols;
}
