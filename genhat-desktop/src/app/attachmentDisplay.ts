/** Short, user-visible labels for composer attachment chips. */

export function attachmentFileName(path: string, metaName?: string): string {
  const fromMeta = metaName?.trim();
  if (fromMeta) return fromMeta;
  return path.split(/[/\\]/).pop() || "document";
}

const EXT_LABELS: Record<string, string> = {
  pdf: "PDF",
  docx: "Word",
  pptx: "PowerPoint",
  xlsx: "Excel",
  xls: "Excel",
  ods: "Spreadsheet",
  csv: "CSV",
  tsv: "TSV",
  txt: "Text",
  md: "Markdown",
  json: "JSON",
  png: "PNG",
  jpg: "JPEG",
  jpeg: "JPEG",
  webp: "WebP",
  gif: "GIF",
};

export function attachmentKindLabel(input: {
  name: string;
  mime?: string;
  kind?: string;
}): string {
  const ext = input.name.split(".").pop()?.toLowerCase() ?? "";
  if (EXT_LABELS[ext]) return EXT_LABELS[ext];
  if (input.kind === "pdf") return "PDF";
  if (input.kind === "image") return "Image";
  const mime = (input.mime ?? "").toLowerCase();
  if (mime.includes("presentation")) return "PowerPoint";
  if (mime.includes("wordprocessing")) return "Word";
  if (mime.includes("spreadsheet") || mime.includes("excel")) return "Excel";
  if (mime.startsWith("image/")) {
    const subtype = mime.slice("image/".length);
    if (subtype && !subtype.includes(".")) return subtype.toUpperCase();
    return "Image";
  }
  if (mime.startsWith("text/")) return "Text";
  return "File";
}

export function formatAttachmentSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function sameAttachmentPath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(a) === norm(b);
}
