import { save } from "@tauri-apps/plugin-dialog";
import { Api } from "../api";
import { exportPresentation, type DeckExportFormat } from "./exportDeck";

function baseNameFromPath(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? "artifact";
  return name.replace(/\.[^.]+$/, "");
}

/** Copy the artifact to a user-chosen path (HTML, XLSX, PPTX, etc.). */
export async function downloadArtifactCopy(sourcePath: string): Promise<string | null> {
  const ext = sourcePath.split(".").pop()?.toLowerCase() ?? "bin";
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

export async function exportArtifactDeck(
  htmlPath: string,
  format: DeckExportFormat
): Promise<string | null> {
  return exportPresentation(htmlPath, format);
}
