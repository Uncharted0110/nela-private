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

export async function handleArtifactEdit(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  options?: { attachedPaths?: string[] }
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

  ctx.updateSession(sid, (prev) => ({
    loading: true,
    artifactStage: "CrunchingMetrics",
    messages: [
      ...prev.messages,
      {
        role: "assistant",
        content: `Applying edits to **${artifactPath.split(/[/\\]/).pop()}**: "${text}"`,
        artifactStage: "CrunchingMetrics",
        artifactPath,
      },
    ],
  }));

  const updateEditMsg = (
    stage: PipelineStageKind,
    path: string | null = null,
    contentOverride?: string
  ) => {
    ctx.updateSession(sid, (prev) => {
      const updated = [...prev.messages];
      const idx = updated
        .map((m, i) => ({ m, i }))
        .reverse()
        .find(({ m }) => m.role === "assistant" && m.artifactStage !== undefined)?.i;
      if (idx !== undefined && updated[idx]) {
        updated[idx] = {
          ...updated[idx],
          artifactStage: stage,
          ...(path !== null ? { artifactPath: path } : {}),
          ...(contentOverride !== undefined ? { content: contentOverride } : {}),
        };
      }
      return {
        artifactStage: stage,
        ...(path !== null ? { artifactPath: path } : {}),
        messages: updated,
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
    ctx.updateSession(sid, { loading: false });
    updateEditMsg("Error", null, friendlyErrorFromUnknown(message));
  }
}