/**
 * Apply a library image (or a freshly searched pick) onto a freeform HTML deck
 * and persist a copy. Shared by the edit-bar picker path and in-canvas library clicks.
 */

import { Api } from "../../api";
import { editedOutputName } from "../artifactEdit";
import {
  applyLibraryImageToSlide,
  findLibraryIdForCandidate,
  upsertImageLibrary,
} from "./deckImageLibrary";
import type { SlideImageCandidate } from "./slideImageCandidates";
import type { SendHandlerContext } from "./types";

export async function writeDeckHtmlCopy(args: {
  artifactPath: string;
  html: string;
  sid: string;
  ctx: SendHandlerContext;
}): Promise<string> {
  const outputName = editedOutputName(args.artifactPath);
  const newPath = await Api.writeArtifactCopy(
    args.artifactPath,
    args.html,
    outputName
  );
  args.ctx.updateSession(args.sid, {
    loading: false,
    artifactPath: newPath,
    artifactStage: "LivePreview",
    artifactPanelOpen: true,
    streamingArtifactHtml: args.html,
  });
  return newPath;
}

/** Persist searched candidates into the deck library (may write even on cancel). */
export function mergeCandidatesIntoDeckHtml(
  html: string,
  candidates: SlideImageCandidate[]
): {
  html: string;
  entries: ReturnType<typeof upsertImageLibrary>["entries"];
  addedIds: number[];
} {
  return upsertImageLibrary(html, candidates);
}

export async function applyPickedCandidateToDeck(args: {
  html: string;
  artifactPath: string;
  sid: string;
  ctx: SendHandlerContext;
  slideIndex: number;
  pick: SlideImageCandidate;
  entries: ReturnType<typeof upsertImageLibrary>["entries"];
}): Promise<string> {
  const libId =
    findLibraryIdForCandidate(args.entries, args.pick) ??
    args.entries[args.entries.length - 1]?.id;
  if (libId == null) {
    throw new Error("Picked image is not in the deck library");
  }
  const next = applyLibraryImageToSlide(args.html, args.slideIndex, libId);
  return writeDeckHtmlCopy({
    artifactPath: args.artifactPath,
    html: next,
    sid: args.sid,
    ctx: args.ctx,
  });
}

/**
 * Parent-panel handler: apply an existing library thumb to a slide.
 * No LLM / no new search.
 */
export async function applyDeckLibraryImageChoice(args: {
  artifactPath: string;
  sid: string;
  ctx: SendHandlerContext;
  libId: number;
  slideIndex: number;
}): Promise<{ path: string; html: string }> {
  const html = await Api.readFileText(args.artifactPath);
  const next = applyLibraryImageToSlide(html, args.slideIndex, args.libId);
  const path = await writeDeckHtmlCopy({
    artifactPath: args.artifactPath,
    html: next,
    sid: args.sid,
    ctx: args.ctx,
  });
  return { path, html: next };
}
