import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import {
  editedOutputName,
  isNelaPresentationDeckHtml,
  isPresentationSlideRemoveRequest,
  parseSlideRemoveIndex,
} from "../artifactEdit";
import {
  countFreeformSlides,
  isHtmlSlideDeck,
  listFreeformSlideTitles,
  removeSlideFromFreeformHtml,
} from "./freeformHtmlSlideEdit";
import type { SendHandlerContext } from "./types";
import { friendlyErrorFromUnknown } from "../friendlyError";

/**
 * Deterministic slide removal — no LLM. Freeform HTML, NELA decks, and PPTX.
 */
export async function runDeterministicSlideRemove(
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
  if (!isPresentationSlideRemoveRequest(text)) return false;

  updateEditMsg("SearchingDisk");
  const lower = artifactPath.toLowerCase();
  const isPptx = lower.endsWith(".pptx") || lower.endsWith(".ppt");
  const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");
  const outputName = editedOutputName(artifactPath);

  // Freeform HTML decks must never hit the NELA/PPTX parser.
  if (!isPptx && isHtml) {
    let html: string;
    try {
      html = await Api.readFileText(artifactPath);
    } catch (err: unknown) {
      console.warn("Deterministic slide-remove read failed:", err);
      return false;
    }

    if (!isNelaPresentationDeckHtml(html)) {
      const slideCount = countFreeformSlides(html);
      if (!isHtmlSlideDeck(html) && slideCount < 1) {
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          "Couldn't find `.slide` sections in this HTML page, so I can't remove a slide."
        );
        return true;
      }

      const titles = listFreeformSlideTitles(html);
      const target = parseSlideRemoveIndex(
        text,
        titles.length || slideCount,
        titles
      );
      if (!target) {
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          "Couldn't tell which slide to remove. Try “remove the Thank You slide” or “remove the last slide”."
        );
        return true;
      }

      updateEditMsg("WritingCode");
      try {
        const next = removeSlideFromFreeformHtml(html, target.index);
        const newPath = await Api.writeArtifactCopy(artifactPath, next, outputName);
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
          `Removed ${target.label} (${filename})`
        );
        return true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          friendlyErrorFromUnknown(`Failed to remove slide: ${message}`)
        );
        return true;
      }
    }
  }

  if (!isPptx && !isHtml) return false;

  let parsedDeck: Awaited<ReturnType<typeof Api.parsePresentationDeck>>;
  try {
    parsedDeck = await Api.parsePresentationDeck(artifactPath);
  } catch (err: unknown) {
    console.warn("Deterministic slide-remove parse failed:", err);
    // For HTML we already tried freeform — surface a real error instead of falling through to LLM.
    if (isHtml) {
      ctx.updateSession(sid, { loading: false });
      updateEditMsg(
        "Error",
        null,
        "Couldn't remove that slide from this deck. Try “remove the last slide” from the preview Edit chat."
      );
      return true;
    }
    return false;
  }

  const titles = (parsedDeck.slides ?? []).map((s) => {
    const title = (s as { title?: unknown }).title;
    return typeof title === "string" ? title : "";
  });
  const target = parseSlideRemoveIndex(text, parsedDeck.slideCount, titles);
  if (!target) {
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      "Couldn't tell which slide to remove. Try “remove the Thank You slide” or “remove the last slide”."
    );
    return true;
  }

  updateEditMsg("WritingCode");
  try {
    const result = await Api.applyPresentationOps({
      path: artifactPath,
      outputName,
      ops: [{ op: "remove_slide", index: target.index }],
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
      `Removed ${target.label} (${filename})`
    );
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("Deterministic slide-remove apply failed:", message);
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      friendlyErrorFromUnknown(`Failed to remove slide: ${message}`)
    );
    return true;
  }
}
