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
import { useCloudStore } from "../../stores/cloudStore";
import { useChatModeStore } from "../../stores/chatModeStore";
import { willRouteToCloud } from "./cloudOrLocalStream";
import {
  DASHBOARD_HTML_SCHEMA,
  DASHBOARD_HTML_TOOL,
  hasSpreadsheetAttach,
  wantsSpreadsheetDashboard,
} from "../spreadsheetDashboardIntent";

/** Prefer store-backed send: call with text only. Optional ctx kept for tests. */
export async function executeHandleSend(
  text: string,
  ctx: SendHandlerContext = buildSendHandlerContext(),
  options?: { reuseExistingUserMessage?: boolean }
): Promise<void> {
  const sid = ctx.activeSessionId;
  const session = ctx.sessions.find((s) => s.id === sid);
  if (!session || session.loading) return;

  const slash = parseSlashCommands(text);
  const promptText = slashPromptForSend(slash);
  const effectiveWebEnabled = ctx.webEnabled || slash.web;
  const effectiveRagEnabled = ctx.ragEnabled || slash.rag;
  const slashFileSearch = slash.files;

  const reuseUser = Boolean(options?.reuseExistingUserMessage);
  const lastMsg = session.messages[session.messages.length - 1];
  const reusedUserMsg =
    reuseUser && lastMsg?.role === "user" ? lastMsg : null;

  const currentVisionImagePath = reusedUserMsg?.visionImage?.path
    ? reusedUserMsg.visionImage.path
    : ctx.chatMode === "vision"
      ? ctx.imagePath
      : null;
  const ragDocPaths = ctx.ragDocs.map((doc) => doc.file_path).filter((path) => !!path);
  const reusedDocPaths =
    reusedUserMsg?.directDocuments?.map((d) => d.path).filter(Boolean) ?? [];
  const promptDocumentPaths =
    reusedDocPaths.length > 0
      ? reusedDocPaths
      : ctx.chatMode === "text" && !effectiveRagEnabled
        ? (ctx.directDocumentPaths.length > 0 ? ctx.directDocumentPaths : ragDocPaths)
        : ctx.directDocumentPaths;

  const visionAttachment =
    ctx.chatMode === "vision" && currentVisionImagePath
      ? {
          path: currentVisionImagePath,
          name:
            reusedUserMsg?.visionImage?.name ??
            currentVisionImagePath.split(/[/\\]/).pop() ?? "image",
        }
      : reusedUserMsg?.visionImage
        ? reusedUserMsg.visionImage
        : undefined;

  const directDocAttachments: DirectDocumentAttachment[] | undefined =
    reusedUserMsg?.directDocuments && reusedUserMsg.directDocuments.length > 0
      ? reusedUserMsg.directDocuments
      : ctx.chatMode === "text" && ctx.directDocumentPaths.length > 0
        ? ctx.directDocumentPaths.map((path) => {
            const meta = useChatModeStore.getState().attachmentMetaByPath[path];
            const engine = useChatModeStore.getState().pdfEngineByPath[path];
            return {
              path,
              name: meta?.name ?? path.split(/[/\\]/).pop() ?? "document",
              mime: meta?.mime,
              sizeBytes: meta?.sizeBytes,
              contentHash: meta?.contentHash,
              kind:
                meta?.kind === "image" || meta?.kind === "pdf" || meta?.kind === "extracted_text"
                  ? meta.kind
                  : undefined,
              parser: engine ?? (meta?.kind === "pdf" ? "cloudflare-ai" : undefined),
              destination:
                useCloudStore.getState().preferredMode === "local" ? "local" : "cloud",
            } satisfies DirectDocumentAttachment;
          })
        : undefined;

  const newMsg: ChatMessage = reusedUserMsg ?? {
    id: crypto.randomUUID(),
    role: "user",
    content: promptText,
    ...(visionAttachment ? { visionImage: visionAttachment } : {}),
    ...(directDocAttachments && directDocAttachments.length > 0
      ? { directDocuments: directDocAttachments }
      : {}),
  };

  const isFirstMessage = session.messages.length === 0;
  const titlePatch =
    isFirstMessage && !reuseUser
      ? { title: deriveTitleFromMessage(promptText) }
      : {};

  const panelWasOpen = Boolean(session.artifactPanelOpen);
  const previewSlideIndex =
    typeof session.previewSlideIndex === "number" && session.previewSlideIndex >= 0
      ? session.previewSlideIndex
      : undefined;
  const livePreviewPath =
    findSessionArtifactPath(session) ??
    (session.artifactPath && session.artifactStage === "LivePreview"
      ? session.artifactPath
      : null);

  if (reusedUserMsg) {
    ctx.updateSession(sid, (prev) => ({
      loading: true,
      streamingContent: "",
      audioOutputs: prev.audioOutputs ?? [],
      cancelled: false,
      artifactStreamActive: false,
      // Keep panel open when a LivePreview is already showing — edit may need it.
      artifactPanelOpen:
        panelWasOpen && Boolean(livePreviewPath) ? true : false,
      artifactPath: livePreviewPath ?? undefined,
      artifactStage: livePreviewPath ? "LivePreview" : undefined,
      previewSlideIndex: prev.previewSlideIndex,
      streamingArtifactHtml: undefined,
      streamingArtifactCsv: undefined,
      streamingArtifactType: undefined,
      streamingArtifactTitle: undefined,
    }));
  } else {
    ctx.updateSession(sid, (prev) => ({
      messages: [...prev.messages, newMsg],
      loading: true,
      streamingContent: "",
      audioOutputs: prev.audioOutputs ?? [],
      cancelled: false,
      artifactStreamActive: false,
      artifactPanelOpen:
        panelWasOpen && Boolean(livePreviewPath) ? true : false,
      artifactPath: livePreviewPath ?? prev.artifactPath,
      artifactStage: livePreviewPath ? "LivePreview" : prev.artifactStage,
      previewSlideIndex: prev.previewSlideIndex,
      streamingArtifactHtml: undefined,
      streamingArtifactCsv: undefined,
      streamingArtifactType: undefined,
      streamingArtifactTitle: undefined,
      ...titlePatch,
    }));
  }

  if (!reusedUserMsg && ctx.chatMode === "vision" && currentVisionImagePath) {
    ctx.clearImage();
  }
  if (
    !reusedUserMsg &&
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
    // Prior turns, so "convert the same into a spreadsheet" has a referent.
    conversationMessages: session.messages,
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
    // Re-read session after the loading patch so panel/path stay accurate.
    const sessionNow =
      ctx.sessions.find((s) => s.id === sid) ?? session;
    const sessionArtifactPath =
      findSessionArtifactPath(sessionNow) ?? livePreviewPath;
    const attachedEditable = promptDocumentPaths.filter(isEditableArtifactPath);
    const editTargetPath =
      attachedEditable[0] ??
      (panelWasOpen && sessionNow.artifactPath
        ? sessionNow.artifactPath
        : null) ??
      sessionArtifactPath ??
      null;

    const editOptions = {
      attachedPaths: promptDocumentPaths,
      activeSlideIndex: previewSlideIndex,
      keepPanelOpen: panelWasOpen || Boolean(editTargetPath),
    };

    if (
      matchesArtifactEditIntent(promptText, {
        artifactPath: editTargetPath,
        attachedPaths: promptDocumentPaths,
        panelOpen: panelWasOpen,
      })
    ) {
      await handleArtifactEdit(
        promptText,
        editTargetPath ?? "",
        sid,
        ctx,
        ctrl,
        editOptions
      );
      return;
    }

    const spreadsheetAttached = hasSpreadsheetAttach(promptDocumentPaths);
    const artifactCtx =
      ctx.directDocumentPaths.length > 0
        ? ctx
        : { ...ctx, directDocumentPaths: promptDocumentPaths };

    if (spreadsheetAttached && wantsSpreadsheetDashboard(promptText)) {
      await handleArtifactGeneration(
        promptText,
        DASHBOARD_HTML_TOOL,
        DASHBOARD_HTML_SCHEMA,
        sid,
        artifactCtx,
        ctrl,
        artifactOptions
      );
      return;
    }

    try {
      const intentExtra: Record<string, string> = {};
      if (sessionArtifactPath) {
        intentExtra.artifact_path = sessionArtifactPath;
      }
      if (spreadsheetAttached) {
        intentExtra.has_spreadsheet_attach = "true";
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
          artifactCtx,
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
          editOptions
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

    // Explicit Cloud/Auto-with-consent: send attachments as OpenRouter multimodal
    // parts. Local (or Auto privacy denial) keeps on-device extraction / vision.
    const preferredMode = useCloudStore.getState().preferredMode;
    const hasExplicitAttachments =
      promptDocumentPaths.length > 0 || Boolean(currentVisionImagePath);
    const routeAttachmentsToCloud =
      hasExplicitAttachments &&
      preferredMode !== "local" &&
      willRouteToCloud({
        containsFileContext: true,
        userConfirmedCloudContext: preferredMode === "cloud",
      });

    if (
      !routeAttachmentsToCloud &&
      ctx.chatMode === "text" &&
      !effectiveRagEnabled &&
      promptDocumentPaths.length > 0
    ) {
      try {
        await handleSendDirectDocs(promptText, ctx, ctrl, promptDocumentPaths);
        return;
      } catch (e) {
        console.error("Direct-document attempt failed, falling back to normal chat:", e);
        // Fall through to text chat
      }
    }

    if (
      !routeAttachmentsToCloud &&
      ctx.chatMode === "text" &&
      effectiveRagEnabled &&
      ctx.ragDocs.length > 0
    ) {
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
      if (!routeAttachmentsToCloud) {
        await handleSendVision(promptText, ctx, currentVisionImagePath);
        return;
      }
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