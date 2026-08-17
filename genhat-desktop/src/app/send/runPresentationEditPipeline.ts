/**
 * LLM-first presentation edit pipeline (preview edit bar + chat edits).
 *
 * 1. Resolve "this slide" against the slide open in the preview iframe.
 * 2. The planner LLM decides everything: which ops to emit (deterministic
 *    Rust ops vs. generated content), whether to search the web, and with
 *    what query + depth.
 * 3. Execute commands (batched Rust ops / freeform DOM transforms).
 * 4. Only when the planner can't answer (model error, offline, unusable JSON)
 *    does the deterministic regex parser take over, so common edits keep
 *    working without a model.
 *
 * Returns false when unhandled — the router falls back to the legacy
 * full-replan / diff-patch paths.
 */

import type { PipelineStageKind } from "../../components/ProgressSlate";
import { isPresentationFullRewriteRequest } from "../artifactEdit";
import { applyPresentationEditCommands } from "./applyPresentationEditCommands";
import {
  normalizeThisSlideReferences,
  parseEditCommands,
} from "./presentationEditCommand";
import type { GenerationOptions, SendHandlerContext } from "./types";

type UpdateEditMsg = (
  stage: PipelineStageKind,
  path?: string | null,
  contentOverride?: string
) => void;

/**
 * "Change the title of the presentation" with no new title named — ask instead
 * of burning a cloud call or a full replan.
 */
const TITLE_CHANGE_WITHOUT_VALUE =
  /\b(?:change|rename|update|set|edit)\b[\s\S]{0,40}\b(?:title|name)\b[\s\S]{0,40}\b(?:presentation|deck|ppt|pptx|powerpoint)\b/i;

const TITLE_HAS_NEW_VALUE =
  /\b(?:to|as|:)\s*["']?.{2,}/i;

function isUnderspecifiedTitleChange(text: string): boolean {
  if (!TITLE_CHANGE_WITHOUT_VALUE.test(text)) return false;
  return !TITLE_HAS_NEW_VALUE.test(text);
}

export async function runPresentationEditPipeline(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  generationOptions: GenerationOptions,
  updateEditMsg: UpdateEditMsg,
  options?: { activeSlideIndex?: number | null }
): Promise<boolean> {
  // Explicit full rewrites go straight to the replan fallback.
  if (isPresentationFullRewriteRequest(text)) return false;

  const normalized = normalizeThisSlideReferences(
    text,
    options?.activeSlideIndex
  );
  if (normalized.usedFallback) {
    updateEditMsg(
      "CrunchingMetrics",
      null,
      "Couldn't detect which slide is open — assuming slide 1."
    );
  }

  if (isUnderspecifiedTitleChange(normalized.text)) {
    updateEditMsg("CrunchingMetrics", null, "Waiting for your answers…");
    const { executeAskFollowUp, formatFollowUpIntoPrompt } = await import(
      "./askFollowUp"
    );
    const follow = await executeAskFollowUp(
      {
        reason: "What should the new title be?",
        questions: [
          {
            id: "new_title",
            prompt: "Enter the new presentation title",
            input_type: "text",
          },
        ],
        allow_attachments: false,
      },
      {
        signal: ctrl.signal,
        onStatus: (msg) => {
          if (msg) updateEditMsg("CrunchingMetrics", null, msg);
        },
      }
    );
    if (follow.status !== "answered") {
      ctx.updateSession(sid, { loading: false });
      updateEditMsg(
        "LivePreview",
        artifactPath,
        "Edit cancelled — no title change applied."
      );
      return true;
    }
    const title =
      follow.answers.new_title?.trim() ||
      follow.freeformNote?.trim() ||
      "";
    if (!title) {
      ctx.updateSession(sid, { loading: false });
      updateEditMsg(
        "LivePreview",
        artifactPath,
        "No title provided — no changes applied."
      );
      return true;
    }
    const continued = formatFollowUpIntoPrompt(
      `change the title of the presentation to ${title}`,
      follow
    );
    // Fall through to planner with a fully specified prompt.
    const { runPresentationEditPlanner } = await import("./presentationEditPlanner");
    const plannedCommands = await runPresentationEditPlanner({
      text: continued,
      artifactPath,
      ctx,
      ctrl,
      generationOptions,
      updateEditMsg,
      activeSlideIndex: options?.activeSlideIndex,
    });
    if (plannedCommands?.length) {
      const handled = await applyPresentationEditCommands({
        commands: plannedCommands,
        artifactPath,
        sid,
        ctx,
        updateEditMsg,
      });
      if (handled) return true;
    }
    const parsed = parseEditCommands(continued);
    if (parsed.commands.length === 0) return false;
    return applyPresentationEditCommands({
      commands: parsed.commands,
      artifactPath,
      sid,
      ctx,
      updateEditMsg,
    });
  }

  // The planner runs for EVERY request: it picks the ops (and therefore which
  // work is deterministic) and drives its own web research.
  const { runPresentationEditPlanner } = await import("./presentationEditPlanner");
  const plannedCommands = await runPresentationEditPlanner({
    text: normalized.text,
    artifactPath,
    ctx,
    ctrl,
    generationOptions,
    updateEditMsg,
    activeSlideIndex: options?.activeSlideIndex,
  });

  if (plannedCommands?.length) {
    const handled = await applyPresentationEditCommands({
      commands: plannedCommands,
      artifactPath,
      sid,
      ctx,
      updateEditMsg,
    });
    if (handled) return true;
  }

  // Planner unavailable (offline / model error / unusable JSON) or its ops
  // didn't apply — fall back to the deterministic parser.
  const parsed = parseEditCommands(normalized.text);
  if (parsed.commands.length === 0) return false;

  return applyPresentationEditCommands({
    commands: parsed.commands,
    artifactPath,
    sid,
    ctx,
    updateEditMsg,
  });
}
