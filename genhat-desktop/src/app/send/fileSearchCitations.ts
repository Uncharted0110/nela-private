/**
 * Turn Doc Graph `query_knowledge_base` markdown into citation hits so the
 * chat UI can render the same [n] link-icons used for web_search.
 *
 * Assembler format (per source):
 *   ### Source N: file_name
 *   - **Location:** … (File: /abs/path)
 *   - **Context:**
 *   …
 */

import type { SearchHit, WebSearchResult } from "../../types";

/** True when a hit URL points at a local filesystem path. */
export function isLocalFileHitUrl(url: string): boolean {
  const u = url.trim();
  return (
    u.startsWith("file://") ||
    /^[a-zA-Z]:[/\\]/.test(u) ||
    (u.startsWith("/") && !u.startsWith("//")) ||
    u.startsWith("\\\\")
  );
}

/** Build a stable file:// URL from an absolute OS path. */
export function pathToFileUrl(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("file://")) return trimmed;
  const normalized = trimmed.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized)}`;
  }
  return `file://${encodeURI(normalized)}`;
}

/** Decode file:// (or raw path) back to an OS path for open/reveal. */
export function fileUrlToPath(url: string): string {
  let path = url.trim();
  if (path.startsWith("file://")) {
    path = decodeURIComponent(path.replace(/^file:\/\//, ""));
    if (/^\/[a-zA-Z]:/.test(path)) {
      path = path.slice(1);
    }
  }
  const isWindows = /^[a-zA-Z]:[/\\]/.test(path) || path.includes("\\");
  return isWindows ? path.replace(/\//g, "\\") : path.replace(/\\/g, "/");
}

/**
 * Parse numbered Source blocks from KB markdown into SearchHits.
 * Dedupes by absolute file path; keeps first snippet context.
 */
export function parseKnowledgeBaseSources(md: string): SearchHit[] {
  if (!md.trim()) return [];

  const sections = md.split(/(?=^### Source \d+:)/m);
  const byPath = new Map<string, SearchHit>();

  for (const section of sections) {
    const header = section.match(/^### Source\s+(\d+):\s*(.+)$/m);
    if (!header) continue;
    const titleFromHeader = header[2]!.split(/\s*>\s*/)[0]!.trim();
    const locMatch = section.match(/\(File:\s*(.+?)\)\s*$/m);
    const path = (locMatch?.[1] ?? "").trim();
    if (!path) continue;

    const contextMatch = section.match(
      /- \*\*Context:\*\*\s*\n([\s\S]*?)(?=\n---|\n### Source |\s*$)/
    );
    const snippet = (contextMatch?.[1] ?? section)
      .replace(/^[\s\-*>]+/gm, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);

    const key = path.replace(/\\/g, "/").toLowerCase();
    if (byPath.has(key)) continue;

    const fileName =
      titleFromHeader ||
      path.split(/[/\\]/).pop() ||
      path;

    byPath.set(key, {
      title: fileName,
      snippet,
      url: pathToFileUrl(path),
    });
  }

  return Array.from(byPath.values());
}

/** Wrap KB markdown as a WebSearchResult so chat citations / disclosure reuse the web UI. */
export function knowledgeBaseToSearchResult(
  query: string,
  md: string
): WebSearchResult | null {
  const results = parseKnowledgeBaseSources(md);
  if (!results.length) return null;

  const numbered = results
    .map((h, i) => {
      const path = fileUrlToPath(h.url);
      return `[${i + 1}] ${h.title} — ${path}`;
    })
    .join("\n");

  return {
    query,
    queries: [query],
    results,
    formatted_context:
      `Local knowledge-base sources (cite as [n]):\n${numbered}\n\n${md}`.slice(
        0,
        48_000
      ),
  };
}
