import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import { friendlyErrorFromUnknown } from "../friendlyError";
import {
  artifactKindFromPath,
  findSessionArtifactPath,
  isEditableArtifactPath,
  isPresentationSlideAddRequest,
  isPresentationSlideExpandRequest,
  isPresentationSlideMoveRequest,
  isPresentationSlideRemoveRequest,
  type ArtifactEditKind,
} from "../artifactEdit";
import { extractAmbientSearchQuery } from "../ambientSearch";
import type { SendHandlerContext } from "./types";

export type ArtifactEditOptions = {
  attachedPaths?: string[];
  /** Edit from the preview panel — keep panel open; report status via onStatus. */
  previewMode?: boolean;
  onStatus?: (message: string, kind: "progress" | "done" | "error") => void;
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
  const fileLabel = artifactPath.split(/[/\\]/).pop() ?? "artifact";

  ctx.updateSession(sid, (prev) => ({
    loading: true,
    artifactStage: "CrunchingMetrics",
    ...(previewMode ? { artifactPanelOpen: true } : {}),
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
        ...(previewMode ? { artifactPanelOpen: true } : {}),
        ...(previewMode ? {} : { messages: updated }),
        ...(sessionStage === "LivePreview" || stage === "Error"
          ? { loading: false }
          : {}),
      };
    });
  };

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
      // Slide add/remove/move + theme are deterministic — never wait on a local/cloud model.
      const { runDeterministicSlideRemove } = await import("./runDeterministicSlideRemove");
      if (await runDeterministicSlideRemove(text, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }
      const { runDeterministicSlideAdd } = await import("./runDeterministicSlideAdd");
      if (await runDeterministicSlideAdd(text, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }
      const { runDeterministicSlideMove } = await import("./runDeterministicSlideMove");
      if (await runDeterministicSlideMove(text, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }
      const { runDeterministicSlideExpand } = await import("./runDeterministicSlideExpand");
      if (await runDeterministicSlideExpand(text, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }
      const { runDeterministicThemeEdit } = await import("./runDeterministicThemeEdit");
      if (await runDeterministicThemeEdit(text, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }

      const { runPptxArtifactOps } = await import("./runPptxArtifactOps");
      const surgical = await runPptxArtifactOps(
        text,
        artifactPath,
        sid,
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg
      );
      if (surgical) return;

      const { runPresentationDeckEdit } = await import("./runPresentationDeckEdit");
      await runPresentationDeckEdit(
        text,
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
      // Freeform HTML slide decks — add/remove/move/theme without LLM.
      if (
        isPresentationSlideAddRequest(text) ||
        isPresentationSlideRemoveRequest(text) ||
        isPresentationSlideMoveRequest(text) ||
        isPresentationSlideExpandRequest(text)
      ) {
        const { runDeterministicSlideRemove } = await import("./runDeterministicSlideRemove");
        if (await runDeterministicSlideRemove(text, artifactPath, sid, ctx, updateEditMsg)) {
          return;
        }
        const { runDeterministicSlideAdd } = await import("./runDeterministicSlideAdd");
        if (await runDeterministicSlideAdd(text, artifactPath, sid, ctx, updateEditMsg)) {
          return;
        }
        const { runDeterministicSlideMove } = await import("./runDeterministicSlideMove");
        if (await runDeterministicSlideMove(text, artifactPath, sid, ctx, updateEditMsg)) {
          return;
        }
        const { runDeterministicSlideExpand } = await import("./runDeterministicSlideExpand");
        if (await runDeterministicSlideExpand(text, artifactPath, sid, ctx, updateEditMsg)) {
          return;
        }
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          "Couldn't find slide markers in this HTML page, so I can't edit slides. " +
            "Open the presentation preview, then try again."
        );
        return;
      }
      const { runDeterministicThemeEdit } = await import("./runDeterministicThemeEdit");
      if (await runDeterministicThemeEdit(text, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }
      const { runHtmlArtifactPatch } = await import("./runHtmlArtifactPatch");
      await runHtmlArtifactPatch(
        text,
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
        text,
        artifactPath,
        sid,
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg
      );
      return;
    }

    // Native PPTX / PPT — deterministic slide/theme ops first, then surgical ops, then full regen.
    {
      const { runDeterministicSlideRemove } = await import("./runDeterministicSlideRemove");
      if (await runDeterministicSlideRemove(text, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }
      const { runDeterministicSlideAdd } = await import("./runDeterministicSlideAdd");
      if (await runDeterministicSlideAdd(text, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }
      const { runDeterministicSlideMove } = await import("./runDeterministicSlideMove");
      if (await runDeterministicSlideMove(text, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }
      const { runDeterministicSlideExpand } = await import("./runDeterministicSlideExpand");
      if (await runDeterministicSlideExpand(text, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }
      const { runDeterministicThemeEdit } = await import("./runDeterministicThemeEdit");
      if (await runDeterministicThemeEdit(text, artifactPath, sid, ctx, updateEditMsg)) {
        return;
      }

      const { runPptxArtifactOps } = await import("./runPptxArtifactOps");
      const surgical = await runPptxArtifactOps(
        text,
        artifactPath,
        sid,
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg
      );
      if (surgical) return;
    }

    const { runPresentationArtifactEdit } = await import("./runPresentationArtifactEdit");
    await runPresentationArtifactEdit(
      text,
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
    updateEditMsg("Error", null, friendlyErrorFromUnknown(message));
  }
}