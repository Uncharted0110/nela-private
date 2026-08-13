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
  let firstTagIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    if (firstTagIndex < 0) firstTagIndex = match.index;
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

  if (sheets.length > 0) {
    // Streamed body often has sheet 1 untagged, then tagged sheet 2+.
    if (firstTagIndex > 0) {
      const prefix = sanitizeCsvInner(s.slice(0, firstTagIndex));
      if (prefix && looksLikeCsvTable(prefix)) {
        sheets.unshift({ title: "Sheet1", csv: prefix });
      }
    }
    return uniquifySheetTitles(sheets);
  }

  // No tags: try markdown/section-separated tables (common model failure mode).
  const sectioned = splitCsvBySections(s);
  if (sectioned.length > 1) return uniquifySheetTitles(sectioned);

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

/**
 * Split a single CSV-ish blob into sheets using markdown headings or
 * blank-line-separated tables with different header rows.
 */
function splitCsvBySections(raw: string): CsvSheetArtifact[] {
  const cleaned = raw
    .replace(/<nela-artifact\b[^>]*>/gi, "\n")
    .replace(/<\/nela-artifact\s*>/gi, "\n")
    .replace(/^```(?:csv|CSV)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!cleaned) return [];

  const headingSplit = cleaned.split(/(?=^#{1,3}\s+\S+)/m);
  if (headingSplit.length > 1) {
    const out: CsvSheetArtifact[] = [];
    for (const part of headingSplit) {
      const lines = part.split(/\r?\n/);
      const heading = lines[0]?.match(/^#{1,3}\s+(.+)$/)?.[1]?.trim();
      const body = sanitizeCsvInner(
        heading ? lines.slice(1).join("\n") : part
      );
      if (!body || !looksLikeCsvTable(body)) continue;
      out.push({
        title: (heading || `Sheet${out.length + 1}`).slice(0, 31),
        csv: body,
      });
    }
    if (out.length > 1) return out;
  }

  // Do NOT split on blank lines. Live streams often insert blank rows, and
  // treating each block as a sheet re-parses the whole workbook every paint.

  return [];
}

function looksLikeCsvTable(csv: string): boolean {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  return countCsvColumns(lines[0]!) >= 2;
}

function uniquifySheetTitles(sheets: CsvSheetArtifact[]): CsvSheetArtifact[] {
  const seen = new Map<string, number>();
  return sheets.map((sheet, idx) => {
    let base = (sheet.title || `Sheet${idx + 1}`).trim().slice(0, 31) || `Sheet${idx + 1}`;
    const key = base.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) {
      const suffix = ` (${n})`;
      base = (base.slice(0, Math.max(1, 31 - suffix.length)) + suffix).slice(0, 31);
    }
    return { ...sheet, title: base };
  });
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
