/**
 * HTML artifact download / export helpers (PPTX, PDF, DOCX, HTML).
 */

import { save } from "@tauri-apps/plugin-dialog";
import { Api } from "../api";
import {
  exportPresentation,
  presentationExportBaseName,
  writePresentationExport,
  type DeckExportFormat,
} from "./exportDeck";
import { documentExportBaseName, htmlToDocxBase64 } from "./htmlToDocx";
import { isPresentationPreviewHtml } from "./presentationPreviewSelect";

function baseNameFromPath(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? "artifact";
  return name.replace(/\.[^.]+$/, "");
}

function extensionOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function looksLikePresentationTitle(title?: string, path?: string): boolean {
  const hay = `${title ?? ""} ${path ?? ""}`;
  return /\b(slide|deck|presentation|pptx?|pitch)\b/i.test(hay);
}

export async function isHtmlPresentationArtifact(path: string): Promise<boolean> {
  const ext = extensionOf(path);
  if (ext !== "html" && ext !== "htm") return false;
  try {
    const html = await Api.readFileText(path);
    return isPresentationPreviewHtml(html);
  } catch {
    return false;
  }
}

function ensureExtension(path: string, ext: string): string {
  const current = extensionOf(path);
  if (current === ext) return path;
  if (["html", "htm", "pdf", "pptx", "ppt", "docx", "doc"].includes(current)) {
    return path.replace(/\.[^.]+$/, `.${ext}`);
  }
  return `${path}.${ext}`;
}

/**
 * Copy the artifact to a user-chosen path.
 * Slide decks default to PowerPoint; documents also offer Word.
 */
export async function downloadArtifactCopy(sourcePath: string): Promise<string | null> {
  const ext = extensionOf(sourcePath) || "bin";

  if (ext === "html" || ext === "htm") {
    try {
      const html = await Api.readFileText(sourcePath);
      if (isPresentationPreviewHtml(html)) {
        return downloadPresentationArtifact(sourcePath, html);
      }
      return downloadHtmlDocumentArtifact(sourcePath, html);
    } catch (err) {
      console.warn("Could not inspect HTML artifact for export:", err);
    }
  }

  const filterName =
    ext === "html" || ext === "htm"
      ? "HTML Document"
      : ext === "xlsx" || ext === "xls"
        ? "Spreadsheet"
        : ext === "pptx" || ext === "ppt"
          ? "Presentation"
          : "File";

  const targetPath = await save({
    defaultPath: `${baseNameFromPath(sourcePath)}.${ext}`,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (!targetPath) return null;

  await Api.copyFileToPath(sourcePath, targetPath);
  return targetPath;
}

async function downloadPresentationArtifact(
  sourcePath: string,
  html: string
): Promise<string | null> {
  const base = presentationExportBaseName(html, sourcePath);
  const targetPath = await save({
    defaultPath: `${base}.pptx`,
    filters: [
      { name: "PowerPoint Presentation", extensions: ["pptx"] },
      { name: "PDF Document", extensions: ["pdf"] },
      { name: "Word Document", extensions: ["docx"] },
      { name: "HTML Document", extensions: ["html"] },
    ],
  });
  if (!targetPath) return null;

  let format: DeckExportFormat | "html" | "docx" = "html";
  const picked = extensionOf(targetPath);
  if (picked === "pptx" || picked === "ppt") format = "pptx";
  else if (picked === "pdf") format = "pdf";
  else if (picked === "docx" || picked === "doc") format = "docx";
  else if (picked === "html" || picked === "htm") format = "html";
  else format = "pptx";

  const finalPath = ensureExtension(
    targetPath,
    format === "html" ? "html" : format
  );
  if (format === "html") {
    await Api.copyFileToPath(sourcePath, finalPath);
  } else if (format === "docx") {
    const base64 = await htmlToDocxBase64(html);
    await Api.saveBinaryFile(finalPath, base64);
  } else {
    await writePresentationExport(sourcePath, finalPath, format);
  }
  return finalPath;
}

async function downloadHtmlDocumentArtifact(
  sourcePath: string,
  html: string
): Promise<string | null> {
  const base = documentExportBaseName(html, sourcePath);
  const targetPath = await save({
    defaultPath: `${base}.docx`,
    filters: [
      { name: "Word Document", extensions: ["docx"] },
      { name: "HTML Document", extensions: ["html"] },
    ],
  });
  if (!targetPath) return null;

  const picked = extensionOf(targetPath);
  if (picked === "html" || picked === "htm") {
    const finalPath = ensureExtension(targetPath, "html");
    await Api.copyFileToPath(sourcePath, finalPath);
    return finalPath;
  }

  const finalPath = ensureExtension(targetPath, "docx");
  const base64 = await htmlToDocxBase64(html);
  await Api.saveBinaryFile(finalPath, base64);
  return finalPath;
}

export async function exportArtifactDeck(
  htmlPath: string,
  format: DeckExportFormat
): Promise<string | null> {
  return exportPresentation(htmlPath, format);
}

export async function exportArtifactDocx(htmlPath: string): Promise<string | null> {
  const html = await Api.readFileText(htmlPath);
  const base = isPresentationPreviewHtml(html)
    ? presentationExportBaseName(html, htmlPath)
    : documentExportBaseName(html, htmlPath);
  const targetPath = await save({
    defaultPath: `${base}.docx`,
    filters: [{ name: "Word Document", extensions: ["docx"] }],
  });
  if (!targetPath) return null;
  const finalPath = ensureExtension(targetPath, "docx");
  const base64 = await htmlToDocxBase64(html);
  await Api.saveBinaryFile(finalPath, base64);
  return finalPath;
}

/** True when the user asked for a Word/DOCX deliverable (not just any document). */
export function wantsWordDocument(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\b(word|docx?)\b|\bmicrosoft\s+word\b/.test(t)) return false;
  return /\b(document|file|essay|report|paper|convert|save|create|make|generate|write|export|download)\b/.test(
    t
  );
}

/**
 * Convert a saved HTML artifact into a sibling .docx in the artifacts folder
 * (no save dialog). Used when the user asked for Word and the model emitted HTML.
 */
export async function materializeHtmlAsDocxArtifact(
  htmlPath: string
): Promise<string> {
  const html = await Api.readFileText(htmlPath);
  const base = documentExportBaseName(html, htmlPath);
  const stamp = Date.now().toString(36);
  const dir = htmlPath.replace(/[/\\][^/\\]+$/, "");
  const sep = htmlPath.includes("\\") ? "\\" : "/";
  const dest = `${dir}${sep}${base}-${stamp}.docx`;
  const base64 = await htmlToDocxBase64(html);
  await Api.saveBinaryFile(dest, base64);
  return dest;
}

export { looksLikePresentationTitle };
