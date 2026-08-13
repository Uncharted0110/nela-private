export function parseCSV(
  content: string,
  options?: { maxRows?: number }
): { headers: string[]; rows: string[][] } {
  const maxRows = options?.maxRows;
  const lines: string[][] = [];
  const rawLines = content.split(/\r?\n/);

  for (const line of rawLines) {
    if (maxRows !== undefined && lines.length >= maxRows + 1) break;
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += c;
      }
    }
    result.push(current.trim());
    if (result.length > 0 && result.some((cell) => cell !== "")) {
      lines.push(result);
    }
  }

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = lines[0]!;
  const rows = lines.slice(1);
  return { headers, rows };
}
