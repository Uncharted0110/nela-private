/**
 * Deterministic theme / color edits — no local model warm-up.
 * Freeform HTML: hue-preserving OKLCH recolor of existing CSS (contrast repair).
 * NELA / PPTX: closest named theme + set_colors from the same palette.
 */

import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import {
  editedOutputName,
  isNelaPresentationDeckHtml,
  isPresentationThemeStyleRequest,
} from "../artifactEdit";
import {
  applyFiveTokenThemeToHtml,
  isTextContrastFixRequest,
} from "./freeformHtmlThemeEdit";
import {
  buildThemePaletteFromPrompt,
  describePalette,
} from "./themePaletteEngine";
import { inferPresentationTheme } from "./presentationTheme";
import { isHtmlSlideDeck } from "./freeformHtmlSlideEdit";
import type { SendHandlerContext } from "./types";
import { friendlyErrorFromUnknown } from "../friendlyError";

function nelaThemeForLabel(label: string, prompt: string): string {
  switch (label) {
    case "blue":
    case "teal":
      return "ocean";
    case "green":
      return "forest";
    case "purple":
      return "lavender";
    case "pink":
      return "rose";
    case "orange":
    case "red":
    case "yellow":
    case "sunset":
      return "sunset";
    case "slate":
      return "slate";
    default:
      return inferPresentationTheme(prompt);
  }
}

function opsForNamedTheme(prompt: string): {
  ops: Record<string, unknown>[];
  label: string;
} {
  const palette = buildThemePaletteFromPrompt(prompt);
  return {
    label: describePalette(palette),
    ops: [
      { op: "set_theme", theme: nelaThemeForLabel(palette.label, prompt) },
      {
        op: "set_colors",
        accent: palette.accent,
        background: palette.background,
      },
    ],
  };
}

/**
 * Apply a theme/style change without calling the LLM.
 * Returns true when the request was handled (success or user-facing error).
 */
export async function runDeterministicThemeEdit(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  updateEditMsg: (
    stage: PipelineStageKind,
    path?: string | null,
    contentOverride?: string
  ) => void
): Promise<boolean> {
  if (!isPresentationThemeStyleRequest(text)) return false;

  updateEditMsg("SearchingDisk");
  const lowerPath = artifactPath.toLowerCase();
  const isPptx = lowerPath.endsWith(".pptx") || lowerPath.endsWith(".ppt");
  const isHtml = lowerPath.endsWith(".html") || lowerPath.endsWith(".htm");
  const outputName = editedOutputName(artifactPath);
  const palette = buildThemePaletteFromPrompt(text);
  const label = describePalette(palette);
  const contrastFix = isTextContrastFixRequest(text);

  // Freeform HTML decks — CSS override path (never hit NELA parser).
  if (!isPptx && isHtml) {
    let html: string;
    try {
      html = await Api.readFileText(artifactPath);
    } catch (err: unknown) {
      console.warn("Deterministic theme-edit read failed:", err);
      return false;
    }

    if (!isNelaPresentationDeckHtml(html)) {
      if (!isHtmlSlideDeck(html) && !/<style\b/i.test(html)) {
        return false;
      }
      updateEditMsg(
        "WritingCode",
        null,
        contrastFix
          ? `Fixing contrast with **${label}**…`
          : `Applying **${label}**…`
      );
      try {
        const next = applyFiveTokenThemeToHtml(html, palette);
        const newPath = await Api.writeArtifactCopy(
          artifactPath,
          next,
          outputName
        );
        ctx.updateSession(sid, {
          loading: false,
          artifactPath: newPath,
          artifactStage: "LivePreview",
          artifactPanelOpen: true,
          streamingArtifactHtml: next,
        });
        const filename = newPath.split(/[/\\]/).pop();
        updateEditMsg(
          "LivePreview",
          newPath,
          `Updated theme to **${label}** → **${filename}** (original unchanged).`
        );
        return true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.updateSession(sid, { loading: false });
        updateEditMsg("Error", null, friendlyErrorFromUnknown(message));
        return true;
      }
    }
  }

  // NELA HTML decks + native PPTX — surgical ops, no LLM.
  const { ops, label: opLabel } = opsForNamedTheme(text);
  updateEditMsg("WritingCode", null, `Applying **${opLabel}**…`);
  try {
    const result = await Api.applyPresentationOps({
      path: artifactPath,
      ops,
      outputName,
    });
    ctx.updateSession(sid, {
      loading: false,
      artifactPath: result.path,
      artifactStage: "LivePreview",
      artifactPanelOpen: true,
    });
    const filename = result.path.split(/[/\\]/).pop();
    updateEditMsg(
      "LivePreview",
      result.path,
      `Updated theme to **${opLabel}** → **${filename}** (original unchanged).`
    );
    return true;
  } catch (err: unknown) {
    if (isHtml && !isPptx) {
      try {
        const html = await Api.readFileText(artifactPath);
        const next = applyFiveTokenThemeToHtml(html, palette);
        const newPath = await Api.writeArtifactCopy(
          artifactPath,
          next,
          outputName
        );
        ctx.updateSession(sid, {
          loading: false,
          artifactPath: newPath,
          artifactStage: "LivePreview",
          artifactPanelOpen: true,
          streamingArtifactHtml: next,
        });
        const filename = newPath.split(/[/\\]/).pop();
        updateEditMsg(
          "LivePreview",
          newPath,
          `Updated theme to **${label}** → **${filename}** (original unchanged).`
        );
        return true;
      } catch {
        /* fall through */
      }
    }
    console.warn("Deterministic theme ops failed:", err);
    return false;
  }
}
