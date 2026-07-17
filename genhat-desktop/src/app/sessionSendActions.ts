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
  if (slash.rag && advanced) chatModeStore.setRagEnabled(true);

  await executeHandleSend(text);
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
    uiStore.showError(`Failed to compact context: ${String(err)}`);
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
