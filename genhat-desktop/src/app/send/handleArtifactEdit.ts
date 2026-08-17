import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import { friendlyErrorFromUnknown } from "../friendlyError";
import {
  artifactKindFromPath,
  findSessionArtifactPath,
  isEditableArtifactPath,
  type ArtifactEditKind,
} from "../artifactEdit";
import { extractAmbientSearchQuery } from "../ambientSearch";
import type { SendHandlerContext } from "./types";

export type ArtifactEditOptions = {
  attachedPaths?: string[];
  /** Edit from the preview panel — keep panel open; report status via onStatus. */
  previewMode?: boolean;
  onStatus?: (message: string, kind: "progress" | "done" | "error") => void;
  /** 0-based slide currently visible in the preview iframe ("this slide"). */
  activeSlideIndex?: number;
  /** Keep the side panel open for chat-bar edits of a LivePreview artifact. */
  keepPanelOpen?: boolean;
};

export async function handleArtifactEdit(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  options?: ArtifactEditOptions
): Promise<void> {
  const session = ctx.sessions.find((s) => s.id === sid);

  if (!artifactPath) {
    artifactPath = findSessionArtifactPath(session!) ?? "";
  }
  if (!artifactPath && options?.attachedPaths?.length) {
    artifactPath =
      options.attachedPaths.find(isEditableArtifactPath) ?? options.attachedPaths[0];
  }

  if (!artifactPath) {
    const searchQuery = extractAmbientSearchQuery(text);
    try {
      const md = await Api.queryKnowledgeBase(searchQuery);
      const matches = [...md.matchAll(/\(File:\s*([^)]+)\)/g)].map((m) => m[1].trim());
      const match = matches.find((p) => isEditableArtifactPath(p));
      if (match) artifactPath = match;
    } catch (err) {
      console.warn("Doc-graph search for artifact edit failed:", err);
    }
  }

  if (!artifactPath) {
    ctx.updateSession(sid, (prev) => ({
      loading: false,
      messages: [
        ...prev.messages,
        {
          role: "assistant" as const,
          content:
            "I couldn't find an HTML page, spreadsheet, or presentation to edit. " +
            "Open an artifact in the chat, attach a `.html` / `.xlsx` / `.pptx` file, or name the file path.",
        },
      ],
    }));
    return;
  }

  const editKind: ArtifactEditKind | null = artifactKindFromPath(artifactPath);
  if (!editKind) {
    ctx.updateSession(sid, (prev) => ({
      loading: false,
      messages: [
        ...prev.messages,
        {
          role: "assistant" as const,
          content: `Unsupported file type for editing: \`${artifactPath}\`. Supported: HTML, XLSX/CSV, PPTX.`,
        },
      ],
    }));
    return;
  }

  const previewMode = !!options?.previewMode;
  const keepPanelOpen = previewMode || !!options?.keepPanelOpen;
  const fileLabel = artifactPath.split(/[/\\]/).pop() ?? "artifact";

  ctx.updateSession(sid, (prev) => ({
    loading: true,
    artifactStage: "CrunchingMetrics",
    ...(keepPanelOpen ? { artifactPanelOpen: true } : {}),
    messages: previewMode
      ? prev.messages
      : [
          ...prev.messages,
          {
            role: "assistant" as const,
            content: `Applying edits to **${fileLabel}**: "${text}"`,
            artifactStage: "CrunchingMetrics" as const,
            artifactPath,
          },
        ],
  }));

  options?.onStatus?.(`Editing **${fileLabel}**…`, "progress");

  const updateEditMsg = (
    stage: PipelineStageKind,
    path: string | null = null,
    contentOverride?: string
  ) => {
    if (contentOverride) {
      const kind =
        stage === "Error" ? "error" : stage === "LivePreview" ? "done" : "progress";
      options?.onStatus?.(contentOverride, kind);
    }
    ctx.updateSession(sid, (prev) => {
      const nextPath = path !== null ? path : prev.artifactPath;
      // Never leave the panel stuck on Error after an edit attempt — that hid Edit.
      const sessionStage: PipelineStageKind =
        stage === "Error" && nextPath ? "LivePreview" : stage;
      const updated = [...prev.messages];
      if (!previewMode) {
        const idx = updated
          .map((m, i) => ({ m, i }))
          .reverse()
          .find(({ m }) => m.role === "assistant" && m.artifactStage !== undefined)?.i;
        if (idx !== undefined && updated[idx]) {
          updated[idx] = {
            ...updated[idx],
            artifactStage: sessionStage,
            ...(path !== null ? { artifactPath: path } : {}),
            ...(contentOverride !== undefined ? { content: contentOverride } : {}),
          };
        }
      }
      return {
        artifactStage: sessionStage,
        ...(path !== null ? { artifactPath: path } : {}),
        ...(keepPanelOpen ? { artifactPanelOpen: true } : {}),
        ...(previewMode ? {} : { messages: updated }),
        ...(sessionStage === "LivePreview" || stage === "Error"
          ? { loading: false }
          : {}),
      };
    });
  };

  // Missing facts → sparse ask_followup before any invent/apply.
  let effectiveText = text;
  let attachedPaths = [...(options?.attachedPaths ?? [])];
  try {
    const { maybeAskFollowUpForArtifactEdit } = await import("./askFollowUp");
    const follow = await maybeAskFollowUpForArtifactEdit({
      prompt: text,
      attachedPaths,
      signal: ctrl.signal,
      onStatus: (msg) => options?.onStatus?.(msg, "progress"),
    });
    if (follow.status === "cancelled") {
      updateEditMsg(
        "LivePreview",
        artifactPath,
        "Edit cancelled — no changes applied."
      );
      return;
    }
    if (follow.status === "answered") {
      if (follow.augmentedPrompt) effectiveText = follow.augmentedPrompt;
      if (follow.attachedPaths.length) {
        attachedPaths = [
          ...attachedPaths,
          ...follow.attachedPaths.filter((p) => !attachedPaths.includes(p)),
        ];
      }
      options?.onStatus?.("Got your answers — continuing edit…", "progress");
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    console.warn("ask_followup precheck failed:", err);
  }

  // Attachments may inform image/data edits even when the planner only sees text.
  if (attachedPaths.length > 0 && attachedPaths !== options?.attachedPaths) {
    const note = attachedPaths
      .map((p) => p.split(/[/\\]/).pop() ?? p)
      .join(", ");
    if (!effectiveText.includes(note)) {
      effectiveText = `${effectiveText}\n\n[User attached files for this edit: ${attachedPaths.join(", ")}]`;
    }
  }

  const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

  try {
    let effectiveEditKind: ArtifactEditKind | null = editKind;
    if (editKind === "html") {
      try {
        const preview = await Api.readFileText(artifactPath);
        if ((await import("../artifactEdit")).isNelaPresentationDeckHtml(preview)) {
          effectiveEditKind = "presentation_deck";
        }
      } catch (err) {
        console.warn("Could not inspect HTML artifact for deck format:", err);
      }
    }

    if (effectiveEditKind === "presentation_deck") {
      // Hybrid pipeline: deterministic command parse (0 LLM calls), else one
      // planner call — structural runners are reused inside the executor.
      const { runPresentationEditPipeline } = await import(
        "./runPresentationEditPipeline"
      );
      const handled = await runPresentationEditPipeline(
        effectiveText,
        artifactPath,
        sid,
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg,
        { activeSlideIndex: options?.activeSlideIndex }
      );
      if (handled) return;

      // Last resort: full deck replan.
      const { runPresentationDeckEdit } = await import("./runPresentationDeckEdit");
      await runPresentationDeckEdit(
        effectiveText,
        artifactPath,
        sid,
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg
      );
      return;
    }

    if (effectiveEditKind === "html") {
      // Freeform HTML slide decks route through the same hybrid pipeline.
      // On non-deck HTML the pipeline bails without any LLM call and the
      // request falls through to theme edit / diff patch below.
      {
        const { runPresentationEditPipeline } = await import(
          "./runPresentationEditPipeline"
        );
        const handled = await runPresentationEditPipeline(
          effectiveText,
          artifactPath,
          sid,
          ctx,
          ctrl,
          generationOptions,
          updateEditMsg,
          { activeSlideIndex: options?.activeSlideIndex }
        );
        if (handled) return;
      }
      const { runDeterministicThemeEdit } = await import("./runDeterministicThemeEdit");
      if (await runDeterministicThemeEdit(effectiveText, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }
      const { runHtmlArtifactPatch } = await import("./runHtmlArtifactPatch");
      await runHtmlArtifactPatch(
        effectiveText,
        artifactPath,
        sid,
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg
      );
      return;
    }

    if (effectiveEditKind === "spreadsheet") {
      const { runSpreadsheetArtifactEdit } = await import("./runSpreadsheetArtifactEdit");
      await runSpreadsheetArtifactEdit(
        effectiveText,
        artifactPath,
        sid,
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg
      );
      return;
    }

    // Native PPTX / PPT — same hybrid pipeline, then full regen fallback.
    {
      const { runPresentationEditPipeline } = await import(
        "./runPresentationEditPipeline"
      );
      const handled = await runPresentationEditPipeline(
        effectiveText,
        artifactPath,
        sid,
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg,
        { activeSlideIndex: options?.activeSlideIndex }
      );
      if (handled) return;
    }

    const { runPresentationArtifactEdit } = await import("./runPresentationArtifactEdit");
    await runPresentationArtifactEdit(
      effectiveText,
      artifactPath,
      sid,
      ctx,
      ctrl,
      generationOptions,
      updateEditMsg
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Artifact edit failed:", err);
    const busy = /\bbusy\b|overloaded|rate limit|\b429\b|\b503\b/i.test(message);
    updateEditMsg(
      "Error",
      null,
      busy
        ? "NELA Cloud is busy right now. Wait a moment and try again — or switch to Auto/Local mode."
        : friendlyErrorFromUnknown(message)
    );
  }
}