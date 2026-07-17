import type { MutableRefObject } from "react";
import { getAdvancedMode } from "../../hooks/useAdvancedMode";
import { useSessionStore, abortControllers } from "../../stores/sessionStore";
import {
  useChatModeStore,
  visionUnlisten,
  generalInterval,
  ttsInterval,
  setVisionUnlisten,
  setGeneralInterval,
  setTtsInterval,
} from "../../stores/chatModeStore";
import { useModelStore } from "../../stores/modelStore";
import type { SendHandlerContext } from "./types";

export const abortControllersRef: MutableRefObject<Map<string, AbortController>> = {
  get current() {
    return abortControllers;
  },
  set current(_: Map<string, AbortController>) {
    /* Map is module-owned */
  },
};

export const visionUnlistenRef: MutableRefObject<(() => void) | null> = {
  get current() {
    return visionUnlisten;
  },
  set current(v: (() => void) | null) {
    setVisionUnlisten(v);
  },
};

export const generalIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null> = {
  get current() {
    return generalInterval;
  },
  set current(v: ReturnType<typeof setInterval> | null) {
    setGeneralInterval(v);
  },
};

export const ttsIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null> = {
  get current() {
    return ttsInterval;
  },
  set current(interval: ReturnType<typeof setInterval> | null) {
    setTtsInterval(interval);
  },
};

/** Build send context from Zustand stores (no React Dispatch from App). */
export function buildSendHandlerContext(): SendHandlerContext {
  const sessionStore = useSessionStore.getState();
  const chatModeStore = useChatModeStore.getState();
  const modelStore = useModelStore.getState();
  const advanced = getAdvancedMode();

  return {
    activeSessionId: sessionStore.activeSessionId,
    sessions: sessionStore.sessions,
    chatMode: chatModeStore.chatMode,
    ragEnabled: advanced ? chatModeStore.ragEnabled : true,
    webEnabled: chatModeStore.webEnabled,
    webDepth: chatModeStore.webDepth,
    imagePath: chatModeStore.imagePath,
    directDocumentPaths: chatModeStore.directDocumentPaths,
    ragDocs: chatModeStore.ragDocs,
    selectedModel: modelStore.selectedModel,
    selectedVisionModel: modelStore.selectedVisionModel,
    selectedTtsEngine: modelStore.selectedTtsEngine,
    ttsVoice: modelStore.ttsVoice,
    ttsSpeed: modelStore.ttsSpeed,
    thinkingEnabled: advanced ? chatModeStore.thinkingEnabled : false,
    abortControllersRef,
    visionUnlistenRef,
    generalIntervalRef,
    ttsIntervalRef,
    updateSession: sessionStore.updateSession,
    setActiveMindmapOverlay: chatModeStore.setActiveMindmapOverlay,
    setGeneralGenerating: chatModeStore.setGeneralGenerating,
    setGeneralElapsedTime: chatModeStore.setGeneralElapsedTime,
    setGeneralGenerationTime: chatModeStore.setGeneralGenerationTime,
    setMindmapsBySession: chatModeStore.setMindmapsBySession,
    setStreamingThinking: sessionStore.setStreamingThinking,
    setTtsGenerating: chatModeStore.setTtsGenerating,
    setTtsElapsedTime: chatModeStore.setTtsElapsedTime,
    setTtsGenerationTime: chatModeStore.setTtsGenerationTime,
    setContextUsageForSession: sessionStore.setContextUsageForSession,
    clearImage: chatModeStore.clearImage,
    clearDirectDocuments: chatModeStore.clearDirectDocuments,
    getContextWindowTokens: modelStore.getContextWindowTokens,
    getChatGenerationOptions: modelStore.getChatGenerationOptions,
  };
}
