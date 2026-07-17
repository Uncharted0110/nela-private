export function parseCSV(content: string): { headers: string[]; rows: string[][] } {
  const lines = content.split(/\r?\n/).map(line => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += c;
      }
    }
    result.push(current.trim());
    return result;
  }).filter(line => line.length > 0 && line.some(cell => cell !== ""));

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = lines[0];
  const rows = lines.slice(1);
  return { headers, rows };
}