import { Api } from "../api";

const MAX_AMBIENT_BODY_CHARS = 8192;
/** Larger budget when grounding artifact generation on a source document. */
export const MAX_ARTIFACT_SOURCE_CHARS = 14_000;

/** Extract a local absolute file path from the user's message, if present. */
export function extractLocalFilePath(text: string): string | null {
  const unix = text.match(
    /(?:^|[\s('"`])(\/(?:[\w.-]+\/)+[\w.-]+\.(pdf|docx?|pptx?|xlsx?|xls|csv|tsv|txt|md|json|rtf|odt|ods))(?:[\s'"`.,;!?]|$)/i
  );
  if (unix?.[1]) {
    return unix[1];
  }

  const win = text.match(
    /(?:^|[\s('"`])([A-Za-z]:\\(?:[\w.\\-]+\\)+[\w.-]+\.(pdf|docx?|pptx?|xlsx?|xls|csv|tsv|txt|md|json|rtf|odt|ods))(?:[\s'"`.,;!?]|$)/i
  );
  return win?.[1] ?? null;
}

export function hasLocalFilePathReference(text: string): boolean {
  return extractLocalFilePath(text) !== null;
}

/**
 * Load readable text for a local file via on-demand read/parse.
 */
export async function loadAmbientFileBody(
  path: string,
  maxChars = MAX_AMBIENT_BODY_CHARS
): Promise<string> {
  try {
    const fileContent = await Api.readFileText(path);
    if (fileContent && fileContent.trim().length > 0) {
      return fileContent.substring(0, maxChars);
    }
  } catch (err) {
    console.warn("on-demand file read failed:", err);
  }

  return "";
}

export function formatAmbientFileSection(path: string, body: string): string {
  const filename = path.split(/[/\\]/).pop() ?? "file";
  if (body.trim().length > 0) {
    return `File: "${filename}" (Path: ${path})\nContent:\n${body}`;
  }
  return `File: "${filename}" (Path: ${path})\n(Content could not be extracted — answer using the filename/path context only.)`;
}
