/**
 * Deterministic slide move / reorder — no LLM.
 */

import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import {
  editedOutputName,
  isNelaPresentationDeckHtml,
  isPresentationSlideMoveRequest,
  parseSlideMove,
} from "../artifactEdit";
import {
  countFreeformSlides,
  isHtmlSlideDeck,
  listFreeformSlideTitles,
  moveSlideInFreeformHtml,
} from "./freeformHtmlSlideEdit";
import type { SendHandlerContext } from "./types";
import { friendlyErrorFromUnknown } from "../friendlyError";

export async function runDeterministicSlideMove(
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
  if (!isPresentationSlideMoveRequest(text)) return false;

  updateEditMsg("SearchingDisk");
  const lower = artifactPath.toLowerCase();
  const isPptx = lower.endsWith(".pptx") || lower.endsWith(".ppt");
  const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");
  const outputName = editedOutputName(artifactPath);

  if (!isPptx && isHtml) {
    let html: string;
    try {
      html = await Api.readFileText(artifactPath);
    } catch (err: unknown) {
      console.warn("Deterministic slide-move read failed:", err);
      return false;
    }

    if (!isNelaPresentationDeckHtml(html)) {
      const slideCount = countFreeformSlides(html);
      if (!isHtmlSlideDeck(html) && slideCount < 2) {
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          "Couldn't find enough `.slide` sections to reorder."
        );
        return true;
      }

      const titles = listFreeformSlideTitles(html);
      const move = parseSlideMove(text, titles.length || slideCount, titles);
      if (!move) {
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          "Couldn't tell which slides to move. Try “move slide 9 to slide 4”."
        );
        return true;
      }
      if (move.from === move.to) {
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "LivePreview",
          null,
          `Slide is already at that position (${move.label}).`
        );
        return true;
      }

      updateEditMsg("WritingCode", null, `Moving ${move.label}…`);
      try {
        const next = moveSlideInFreeformHtml(html, move.from, move.to);
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
          `Moved ${move.label} (${filename})`
        );
        return true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          friendlyErrorFromUnknown(`Failed to move slide: ${message}`)
        );
        return true;
      }
    }
  }

  // NELA HTML / PPTX — surgical move op (0-based indexes).
  let parsed: Awaited<ReturnType<typeof Api.parsePresentationDeck>>;
  try {
    parsed = await Api.parsePresentationDeck(artifactPath);
  } catch (err: unknown) {
    console.warn("Deterministic slide-move parse failed:", err);
    return false;
  }

  const titles = (parsed.slides ?? []).map((s) =>
    String((s as { title?: string }).title ?? "")
  );
  const move = parseSlideMove(text, parsed.slideCount, titles);
  if (!move) {
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      "Couldn't tell which slides to move. Try “move slide 9 to slide 4”."
    );
    return true;
  }
  if (move.from === move.to) {
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "LivePreview",
      null,
      `Slide is already at that position (${move.label}).`
    );
    return true;
  }

  updateEditMsg("WritingCode", null, `Moving ${move.label}…`);
  try {
    const result = await Api.applyPresentationOps({
      path: artifactPath,
      ops: [{ op: "move_slide", from: move.from, to: move.to }],
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
      `Moved ${move.label} (${filename})`
    );
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("Deterministic slide-move ops failed:", message);
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      friendlyErrorFromUnknown(`Failed to move slide: ${message}`)
    );
    return true;
  }
}
