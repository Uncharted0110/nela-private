import { Api } from "../../api";
import type { ChatMessage, DirectDocumentAttachment } from "../../types";
import { parseSlashCommands, slashPromptForSend } from "../slashCommands";
import { deriveTitleFromMessage } from "../sessionUtils";
import {
  findSessionArtifactPath,
  isEditableArtifactPath,
  matchesArtifactEditIntent,
} from "../artifactEdit";
import { handleSendMindmap } from "./handleSendMindmap";
import { handleSendDirectDocs } from "./handleSendDirectDocs";
import { handleSendRag } from "./handleSendRag";
import { handleSendTts } from "./handleSendTts";
import { handleSendVision } from "./handleSendVision";
import { handleSendTextChat } from "./handleSendTextChat";
import { handleArtifactGeneration } from "./handleArtifactGeneration";
import { handleArtifactEdit } from "./handleArtifactEdit";
import { friendlyErrorFromUnknown } from "../friendlyError";
import type { SendHandlerContext } from "./types";
import { buildSendHandlerContext } from "./buildContext";

/** Prefer store-backed send: call with text only. Optional ctx kept for tests. */
export async function executeHandleSend(
  text: string,
  ctx: SendHandlerContext = buildSendHandlerContext()
): Promise<void> {
  const sid = ctx.activeSessionId;
  const session = ctx.sessions.find((s) => s.id === sid);
  if (!session || session.loading) return;

  const slash = parseSlashCommands(text);
  const promptText = slashPromptForSend(slash);
  const effectiveWebEnabled = ctx.webEnabled || slash.web;
  const effectiveRagEnabled = ctx.ragEnabled || slash.rag;
  const slashFileSearch = slash.files;

  const currentVisionImagePath = ctx.chatMode === "vision" ? ctx.imagePath : null;
  const ragDocPaths = ctx.ragDocs.map((doc) => doc.file_path).filter((path) => !!path);
  const promptDocumentPaths =
    ctx.chatMode === "text" && !effectiveRagEnabled
      ? (ctx.directDocumentPaths.length > 0 ? ctx.directDocumentPaths : ragDocPaths)
      : ctx.directDocumentPaths;

  const visionAttachment =
    ctx.chatMode === "vision" && currentVisionImagePath
      ? {
          path: currentVisionImagePath,
          name: currentVisionImagePath.split(/[/\\]/).pop() ?? "image",
        }
      : undefined;

  const directDocAttachments: DirectDocumentAttachment[] | undefined =
    ctx.chatMode === "text" && ctx.directDocumentPaths.length > 0
      ? ctx.directDocumentPaths.map((path) => ({
          path,
          name: path.split(/[/\\]/).pop() ?? "document",
        }))
      : undefined;

  const newMsg: ChatMessage = {
    role: "user",
    content: promptText,
    ...(visionAttachment ? { visionImage: visionAttachment } : {}),
    ...(directDocAttachments && directDocAttachments.length > 0
      ? { directDocuments: directDocAttachments }
      : {}),
  };

  const isFirstMessage = session.messages.length === 0;
  const titlePatch = isFirstMessage ? { title: deriveTitleFromMessage(promptText) } : {};

  ctx.updateSession(sid, (prev) => ({
    messages: [...prev.messages, newMsg],
    loading: true,
    streamingContent: "",
    audioOutputs: prev.audioOutputs ?? [],
    cancelled: false,
    artifactStreamActive: false,
    artifactPanelOpen: false,
    streamingArtifactHtml: undefined,
    streamingArtifactCsv: undefined,
    streamingArtifactType: undefined,
    streamingArtifactTitle: undefined,
    ...titlePatch,
  }));

  if (ctx.chatMode === "vision" && currentVisionImagePath) {
    ctx.clearImage();
  }
  if (
    ctx.chatMode === "text" &&
    ctx.directDocumentPaths.length > 0 &&
    directDocAttachments &&
    directDocAttachments.length > 0
  ) {
    ctx.clearDirectDocuments();
  }

  const ctrl = new AbortController();
  ctx.abortControllersRef.current.set(sid, ctrl);

  let resolvedIntentKind = slashFileSearch ? "FileSearch" : "";
  const artifactOptions = {
    webEnabled: effectiveWebEnabled,
    ragEnabled: effectiveRagEnabled,
    forceFileSearch: slashFileSearch,
  };

  // ── Slash-command routing (explicit user intent) ─────────────────────────
  if (ctx.chatMode === "text" && slash.artifact) {
    const { tool, schemaId } = slash.artifact;
    await handleArtifactGeneration(
      promptText,
      tool,
      schemaId,
      sid,
      ctx,
      ctrl,
      artifactOptions
    );
    return;
  }

  // ── Intent Resolution (Revamp P3/P5) ──────────────────────────────────────
  if (ctx.chatMode === "text") {
    const sessionArtifactPath = findSessionArtifactPath(session);
    const attachedEditable = promptDocumentPaths.filter(isEditableArtifactPath);
    const editTargetPath =
      attachedEditable[0] ??
      sessionArtifactPath ??
      null;

    if (
      matchesArtifactEditIntent(promptText, {
        artifactPath: editTargetPath,
        attachedPaths: promptDocumentPaths,
      })
    ) {
      await handleArtifactEdit(
        promptText,
        editTargetPath ?? "",
        sid,
        ctx,
        ctrl,
        { attachedPaths: promptDocumentPaths }
      );
      return;
    }

    try {
      const intentExtra: Record<string, string> = {};
      if (sessionArtifactPath) {
        intentExtra.artifact_path = sessionArtifactPath;
      }
      const intent = await Api.resolveIntent(promptText, intentExtra);
      resolvedIntentKind = intent.kind.kind;
      if (intent.kind.kind === "Artifact") {
        const { tool, schema_id } = intent.kind;
        await handleArtifactGeneration(
          promptText,
          tool,
          schema_id,
          sid,
          ctx,
          ctrl,
          artifactOptions
        );
        return;
      }
      if (intent.kind.kind === "Patch") {
        const { artifact_path } = intent.kind;
        await handleArtifactEdit(
          promptText,
          artifact_path || sessionArtifactPath || "",
          sid,
          ctx,
          ctrl,
          { attachedPaths: promptDocumentPaths }
        );
        return;
      }
    } catch (err) {
      console.warn("Intent resolution failed, falling back to standard chat:", err);
    }
  }

  try {
    if (ctx.chatMode === "mindmap") {
      await handleSendMindmap(promptText, ctx);
      return;
    }

    if (ctx.chatMode === "text" && !effectiveRagEnabled && promptDocumentPaths.length > 0) {
      try {
        await handleSendDirectDocs(promptText, ctx, ctrl, promptDocumentPaths);
        return;
      } catch (e) {
        console.error("Direct-document attempt failed, falling back to normal chat:", e);
        // Fall through to text chat
      }
    }

    if (ctx.chatMode === "text" && effectiveRagEnabled && ctx.ragDocs.length > 0) {
      try {
        await handleSendRag(promptText, ctx, ctrl);
        return;
      } catch (e) {
        console.error("RAG attempt failed, falling back to normal chat:", e);
        // Fall through to text chat
      }
    }

    if (ctx.chatMode === "audio" && ctx.selectedTtsEngine) {
      await handleSendTts(text, ctx);
      return;
    }

    if (ctx.chatMode === "vision") {
      await handleSendVision(promptText, ctx, currentVisionImagePath);
      return;
    }

    // Default fallback: text chat
    await handleSendTextChat(
      promptText,
      ctx,
      ctrl,
      session,
      newMsg,
      effectiveWebEnabled,
      resolvedIntentKind,
      slashFileSearch
    );

  } catch (err) {
    if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
    ctx.setGeneralGenerating(false);
    console.error(err);
    ctx.updateSession(sid, (prev) => ({
      messages: [
        ...prev.messages,
        { role: "assistant" as const, content: friendlyErrorFromUnknown(err) },
      ],
      loading: false,
    }));
  }
}