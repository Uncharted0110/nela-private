import type { ChatMode } from "../types";
import { parseSlashCommands } from "./slashCommands";
import { MODE_CONFIG } from "./constants";
import { executeHandleSend } from "./handleSend";
import {
  applyCompactionResultToSession,
  CONTEXT_COMPACTION_KEEP_RECENT,
  CONTEXT_COMPACTION_THRESHOLD,
  resolveReservedOutputTokens,
  toContextMessages,
} from "./contextCompaction";
import { Api } from "../api";
import { useSessionStore, abortControllers } from "../stores/sessionStore";
import {
  useChatModeStore,
  visionUnlisten,
  setVisionUnlisten,
} from "../stores/chatModeStore";
import { useModelStore } from "../stores/modelStore";
import { useUIStore } from "../stores/uiStore";
import { getAdvancedMode } from "../hooks/useAdvancedMode";
export {
  abortControllersRef,
  visionUnlistenRef,
  generalIntervalRef,
  ttsIntervalRef,
} from "./send/buildContext";

export function handleCancel(): void {
  const sessionStore = useSessionStore.getState();
  const sid = sessionStore.activeSessionId;
  if (!sid) return;

  abortControllers.get(sid)?.abort();
  abortControllers.delete(sid);
  // Unblock any await openImagePicker() so the edit pipeline can finish.
  void import("../stores/imagePickerStore").then(({ cancelImagePicker }) =>
    cancelImagePicker()
  );
  visionUnlisten?.();
  setVisionUnlisten(null);
  sessionStore.updateSession(sid, (prev) => ({
    messages: prev.streamingContent
      ? [...prev.messages, { role: "assistant" as const, content: prev.streamingContent }]
      : prev.messages,
    streamingContent: "",
    loading: false,
    cancelled: true,
  }));
}

export async function handleSend(text: string): Promise<void> {
  const chatModeStore = useChatModeStore.getState();
  const advanced = getAdvancedMode();

  const slash = parseSlashCommands(text);
  if (slash.web) chatModeStore.setWebEnabled(true);
  if (slash.files) chatModeStore.setFileIndexerEnabled(true);
  if (slash.rag && advanced) chatModeStore.setRagEnabled(true);

  await executeHandleSend(text);
}

/**
 * Retry the prompt that produced the assistant message at `assistantMsgIndex`.
 * Removes that response (and anything after it), keeps the original user
 * bubble, and re-runs generation as a fresh send of that prompt.
 */
export async function handleRetryPrompt(assistantMsgIndex: number): Promise<void> {
  const sessionStore = useSessionStore.getState();
  const sid = sessionStore.activeSessionId;
  if (!sid) return;

  const session = sessionStore.sessions.find((s) => s.id === sid);
  if (!session || session.loading) return;
  if (assistantMsgIndex < 0 || assistantMsgIndex >= session.messages.length) return;

  const target = session.messages[assistantMsgIndex];
  if (!target || target.role !== "assistant") return;

  let userIdx = -1;
  for (let i = assistantMsgIndex - 1; i >= 0; i--) {
    const prior = session.messages[i];
    if (prior?.role === "user" && prior.content.trim()) {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return;

  const retryText = session.messages[userIdx]!.content;

  // Stop any in-flight generation tied to this session.
  abortControllers.get(sid)?.abort();
  abortControllers.delete(sid);
  visionUnlisten?.();
  setVisionUnlisten(null);

  // Drop the assistant reply and everything after it; keep the user prompt.
  const truncated = session.messages.slice(0, assistantMsgIndex);
  sessionStore.updateSession(sid, {
    messages: truncated,
    loading: false,
    streamingContent: "",
    cancelled: false,
    artifactStreamActive: false,
    artifactPanelOpen: false,
    artifactPath: undefined,
    artifactStage: undefined,
    streamingArtifactHtml: undefined,
    streamingArtifactCsv: undefined,
    streamingArtifactType: undefined,
    streamingArtifactTitle: undefined,
  });

  await executeHandleSend(retryText, undefined, {
    reuseExistingUserMessage: true,
  });
}

/**
 * Edit the open artifact from the preview panel chat.
 * Does not close the panel or route through main chat intent resolution.
 */
export async function handlePreviewArtifactEdit(
  text: string,
  artifactPath: string,
  onStatus?: (message: string, kind: "progress" | "done" | "error") => void,
  editContext?: { activeSlideIndex?: number }
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || !artifactPath) return;

  const sessionStore = useSessionStore.getState();
  const sid = sessionStore.activeSessionId;
  if (!sid) return;

  const session = sessionStore.sessions.find((s) => s.id === sid);
  if (!session) {
    onStatus?.("No active chat session. Open a chat, then try again.", "error");
    return;
  }
  if (session.loading) {
    onStatus?.(
      "Another request is still running. Wait for it to finish, then try again.",
      "error"
    );
    return;
  }

  const { buildSendHandlerContext } = await import("./send/buildContext");
  const { handleArtifactEdit } = await import("./send/handleArtifactEdit");
  const ctx = buildSendHandlerContext();
  const ctrl = new AbortController();
  abortControllers.set(sid, ctrl);

  try {
    await handleArtifactEdit(trimmed, artifactPath, sid, ctx, ctrl, {
      previewMode: true,
      onStatus,
      activeSlideIndex: editContext?.activeSlideIndex,
    });
  } catch (err: unknown) {
    const { friendlyErrorFromUnknown } = await import("./friendlyError");
    onStatus?.(friendlyErrorFromUnknown(err), "error");
  } finally {
    abortControllers.delete(sid);
  }
}

export function handleModeSwitch(mode: ChatMode): void {
  const sessionStore = useSessionStore.getState();
  const chatModeStore = useChatModeStore.getState();
  const uiStore = useUIStore.getState();

  if (mode === chatModeStore.chatMode) return;

  const activeSession = sessionStore.getActiveSession();
  if (activeSession?.loading) {
    handleCancel();
  }

  const switchedTo = MODE_CONFIG.find((m) => m.mode === mode)?.label ?? mode;
  uiStore.setModeSwitchNotice(`Switched to ${switchedTo} mode`);

  if (mode !== "vision") {
    chatModeStore.setImagePath(null);
    chatModeStore.setImagePreview(null);
  }
  if (mode !== "text") {
    chatModeStore.setDirectDocumentPaths([]);
  }
  if (mode !== "text" && mode !== "mindmap") {
    uiStore.setDocPanelOpen(false);
  }

  chatModeStore.setChatMode(mode);
}

export async function handleManualContextCompaction(): Promise<void> {
  const sessionStore = useSessionStore.getState();
  const chatModeStore = useChatModeStore.getState();
  const modelStore = useModelStore.getState();
  const uiStore = useUIStore.getState();

  const activeSession = sessionStore.getActiveSession();
  if (!activeSession) return;
  if (activeSession.loading) return;
  if (chatModeStore.chatMode !== "text" && chatModeStore.chatMode !== "mindmap") return;

  sessionStore.setContextCompacting(true);
  try {
    const generation = modelStore.getChatGenerationOptions(modelStore.selectedModel);
    const result = await Api.compactChatContext({
      messages: toContextMessages(activeSession.messages),
      contextWindowTokens: modelStore.getContextWindowTokens(modelStore.selectedModel),
      reservedOutputTokens: resolveReservedOutputTokens(generation.maxTokens),
      thresholdPercent: CONTEXT_COMPACTION_THRESHOLD,
      allowAutoCompaction: false,
      forceCompaction: true,
      preserveRecentMessages: CONTEXT_COMPACTION_KEEP_RECENT,
      modelOverride: modelStore.selectedModel || null,
    });

    sessionStore.setContextUsageForSession(activeSession.id, result.usage);

    if (result.compacted) {
      const rebuilt = applyCompactionResultToSession(
        activeSession.messages,
        activeSession.mediaAssets ?? {},
        result
      );

      sessionStore.updateSession(activeSession.id, {
        messages: rebuilt.messages,
        mediaAssets: rebuilt.mediaAssets,
      });

      uiStore.setAppModal({
        open: true,
        kind: "info",
        title: "Context compacted",
        message: `Conversation context was compacted. ${result.droppedMessages} message(s) were compressed or removed to free context space.`,
        confirmLabel: "OK",
        cancelLabel: "Cancel",
        showCancel: false,
      });
    } else {
      uiStore.setAppModal({
        open: true,
        kind: "info",
        title: "Context already efficient",
        message: "No additional compaction was needed for the current session context.",
        confirmLabel: "OK",
        cancelLabel: "Cancel",
        showCancel: false,
      });
    }
  } catch (err) {
    console.error("Manual context compaction failed:", err);
    uiStore.showError("Couldn't clean up the conversation. Please try again.");
  } finally {
    sessionStore.setContextCompacting(false);
  }
}

export function getPlaceholder(): string {
  const chatModeStore = useChatModeStore.getState();

  switch (chatModeStore.chatMode) {
    case "vision":
      return "Ask about the image (e.g., 'What's in this image?')";
    case "audio":
      return "Type text to generate speech...";
    case "podcast":
      return "What topic should the podcast cover?";
    case "mindmap":
      return chatModeStore.ragDocs.length > 0
        ? "Ask for a mindmap from your documents…"
        : "Describe a topic to generate a mindmap…";
    default:
      if (chatModeStore.ragDocs.length > 0) return "Ask a question about your documents…";
      if (chatModeStore.directDocumentPaths.length > 0)
        return "Ask a question about the attached documents…";
      return "Ask a question, or add documents with + …";
  }
}
