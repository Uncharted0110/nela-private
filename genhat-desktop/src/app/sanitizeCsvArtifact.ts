/**
 * Clean model CSV output before parse/save/preview.
 * Models often leave <nela-artifact> tags or chat prose around the table.
 */

export function sanitizeCsvArtifactBody(raw: string): string {
  let s = (raw || "").trim();
  if (!s) return "";

  // Prefer the interior of a complete artifact wrapper.
  const wrapped = s.match(
    /<nela-artifact\b[^>]*>([\s\S]*?)<\/nela-artifact\s*>/i
  );
  if (wrapped?.[1] != null) {
    s = wrapped[1].trim();
  } else {
    // Drop open/close tags if the model left them as stray lines.
    s = s
      .replace(/<nela-artifact\b[^>]*>/gi, "\n")
      .replace(/<\/nela-artifact\s*>/gi, "\n")
      .trim();
  }

  // Markdown fences
  s = s.replace(/^```(?:csv|CSV)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const lines = s.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (/<\/?nela-artifact\b/i.test(line)) continue;
    // Skip chat prose that sometimes precedes the table.
    if (
      /^(?:here(?:'s| is)|i(?:'ll| will)|sure|below|this (?:is|sheet)|i've|i have)\b/i.test(
        line
      ) &&
      line.split(",").length < 3
    ) {
      continue;
    }
    // A usable header/data line has at least two columns.
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

  // Trim trailing empty lines
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
