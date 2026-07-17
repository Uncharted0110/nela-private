import type { MutableRefObject } from "react";
import type {
  ChatSession,
  ChatContextUsage,
  IngestionStatus,
  KittenTtsVoice,
  MindMapGraph,
  ChatMode,
} from "../../types";

// Re-export MindmapOverlayState from chatModeStore to avoid duplication
export type { MindmapOverlayState } from "../../stores/chatModeStore";

export interface GenerationOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  /** Pin llama-server KV slot; usually set via session/workspace affinity. */
  idSlot?: number | null;
  sessionId?: string | null;
  workspaceId?: string | null;
}

export type UpdateSessionFn = (
  sessionId: string,
  patch: Partial<ChatSession> | ((prev: ChatSession) => Partial<ChatSession>)
) => void;

export interface SendHandlerContext {
  activeSessionId: string;
  sessions: ChatSession[];
  chatMode: ChatMode;
  ragEnabled: boolean;
  webEnabled: boolean;
  webDepth: "snippets" | "full";
  imagePath: string | null;
  directDocumentPaths: string[];
  ragDocs: IngestionStatus[];
  selectedModel: string;
  selectedVisionModel: string;
  selectedTtsEngine: string;
  ttsVoice: KittenTtsVoice;
  ttsSpeed: number;
  thinkingEnabled: boolean;
  abortControllersRef: MutableRefObject<Map<string, AbortController>>;
  visionUnlistenRef: MutableRefObject<(() => void) | null>;
  generalIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  ttsIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  updateSession: UpdateSessionFn;
  setActiveMindmapOverlay: (overlay: import("../../stores/chatModeStore").MindmapOverlayState | null) => void;
  setGeneralGenerating: (generating: boolean) => void;
  setGeneralElapsedTime: (time: number) => void;
  setGeneralGenerationTime: (time: number | null) => void;
  setMindmapsBySession: (mindmaps: Record<string, MindMapGraph[]> | ((prev: Record<string, MindMapGraph[]>) => Record<string, MindMapGraph[]>)) => void;
  setStreamingThinking: (thinking: string) => void;
  setTtsGenerating: (generating: boolean) => void;
  setTtsElapsedTime: (time: number) => void;
  setTtsGenerationTime: (time: number | null) => void;
  setContextUsageForSession: (sessionId: string, usage: ChatContextUsage) => void;
  clearImage: () => void;
  clearDirectDocuments: () => void;
  getContextWindowTokens: (modelIdentifier: string | null | undefined) => number;
  getChatGenerationOptions: (modelIdentifier: string | null | undefined) => GenerationOptions;
}