import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import {
  isPresentationSlideImageChangeRequest,
  parseSlideExpandIndex,
  parseSlideImageChangeTopic,
} from "../artifactEdit";
import {
  countFreeformSlides,
  isHtmlSlideDeck,
  listFreeformSlideTitles,
} from "./freeformHtmlSlideEdit";
import {
  fetchSlideImageCandidates,
  listDeckImageSources,
} from "./slideImageCandidates";
import { openImagePicker } from "../../stores/imagePickerStore";
import {
  applyPickedCandidateToDeck,
  mergeCandidatesIntoDeckHtml,
  writeDeckHtmlCopy,
} from "./applyDeckLibraryImage";
import type { SendHandlerContext } from "./types";
import { friendlyErrorFromUnknown } from "../friendlyError";

/**
 * Deterministic slide image replace — model/regex-authored query → candidate
 * thumbnails → user pick → HTML src swap via the in-deck image library.
 */
export async function runDeterministicSlideImageChange(
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
  if (!isPresentationSlideImageChangeRequest(text)) return false;

  updateEditMsg("SearchingDisk");
  const lower = artifactPath.toLowerCase();
  const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");
  if (!isHtml) {
    return false;
  }

  let html: string;
  try {
    html = await Api.readFileText(artifactPath);
  } catch (err: unknown) {
    console.warn("Deterministic image-change read failed:", err);
    return false;
  }

  if (!isHtmlSlideDeck(html) && countFreeformSlides(html) < 1) {
    return false;
  }

  const titles = listFreeformSlideTitles(html);
  const slideCount = Math.max(titles.length, countFreeformSlides(html));
  const target = parseSlideExpandIndex(text, slideCount, titles);
  if (!target) {
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      "Say which slide’s image to change — e.g. “change the image on slide 1”."
    );
    return true;
  }

  const topicHint = parseSlideImageChangeTopic(text);
  const query =
    topicHint ||
    titles[target.index]?.trim() ||
    `slide ${target.index + 1}`;
  const slideLabel = target.label;

  updateEditMsg(
    "CrunchingMetrics",
    null,
    `Finding images for **${query}**…`
  );

  let candidates;
  try {
    candidates = await fetchSlideImageCandidates({
      query,
      count: 6,
      excludeSources: listDeckImageSources(html),
      onStatus: (msg) => updateEditMsg("CrunchingMetrics", null, msg),
    });
  } catch (err) {
    console.warn("Slide image enrichment failed:", err);
    candidates = [];
  }

  if (!candidates.length) {
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      `Couldn't find a usable image for “${query}”. Try naming the subject, e.g. “change the image on slide 1 to Park Güell”.`
    );
    return true;
  }

  const merged = mergeCandidatesIntoDeckHtml(html, candidates);
  html = merged.html;

  updateEditMsg(
    "CrunchingMetrics",
    null,
    `Pick an image for ${slideLabel}…`
  );
  const pick = await openImagePicker({
    slideLabel,
    query,
    candidates,
  });

  if (!pick) {
    try {
      const newPath = await writeDeckHtmlCopy({
        artifactPath,
        html,
        sid,
        ctx,
      });
      updateEditMsg(
        "LivePreview",
        newPath,
        `Kept the existing image on ${slideLabel}. New images are in the Images sidebar.`
      );
    } catch (err) {
      console.warn("Failed to persist image library on cancel:", err);
      ctx.updateSession(sid, { loading: false });
      updateEditMsg(
        "LivePreview",
        artifactPath,
        `Kept the existing image on ${slideLabel}.`
      );
    }
    return true;
  }

  updateEditMsg("WritingCode", null, `Updating image on ${slideLabel}…`);
  try {
    const newPath = await applyPickedCandidateToDeck({
      html,
      artifactPath,
      sid,
      ctx,
      slideIndex: target.index,
      pick,
      entries: merged.entries,
    });
    const filename = newPath.split(/[/\\]/).pop();
    updateEditMsg(
      "LivePreview",
      newPath,
      `Updated the image on ${slideLabel} (**${query}**) → **${filename}**`
    );
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      friendlyErrorFromUnknown(`Failed to change slide image: ${message}`)
    );
    return true;
  }
}
