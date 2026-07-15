import { openUrl } from "@tauri-apps/plugin-opener";
import { Api } from "../api";

/** Open a generated artifact with the OS default application. */
export async function openArtifactInOs(path: string): Promise<void> {
  try {
    await Api.openPathInOs(path);
    return;
  } catch (primaryErr) {
    console.warn("openPathInOs failed, trying fallbacks:", primaryErr);
  }

  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm") {
    const normalized = path.replace(/\\/g, "/");
    const url = normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
    try {
      await openUrl(url);
      return;
    } catch (urlErr) {
      console.warn("file:// open failed:", urlErr);
    }
  }

  await Api.revealInExplorer(path);
}
