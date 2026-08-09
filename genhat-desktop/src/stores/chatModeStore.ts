import { create } from "zustand";
import type { 
  ChatMode, 
  IngestionStatus, 
  MindMapGraph 
} from "../types";

// Define MindmapOverlayState type
export interface MindmapOverlayState {
  sessionId: string;
  mindmapId: string | null;
  isGenerating?: boolean;
  query?: string;
}

// Module-level refs for vision and intervals
export let visionUnlisten: (() => void) | null = null;
export let generalInterval: ReturnType<typeof setInterval> | null = null;
export let ttsInterval: ReturnType<typeof setInterval> | null = null;

// Setters for module-level refs
export const setVisionUnlisten = (unlisten: (() => void) | null) => {
  visionUnlisten = unlisten;
};

export const setGeneralInterval = (interval: ReturnType<typeof setInterval> | null) => {
  generalInterval = interval;
};

export const setTtsInterval = (interval: ReturnType<typeof setInterval> | null) => {
  ttsInterval = interval;
};

interface ChatModeState {
  chatMode: ChatMode;
  thinkingEnabled: boolean;
  ragEnabled: boolean;
  ragDocs: IngestionStatus[];
  ragIngesting: boolean;
  enrichmentStatus: string | null;
  webEnabled: boolean;
  fileIndexerEnabled: boolean;
  /** Live status while a tool runs (e.g. web search) — shown above the streaming bubble. */
  liveToolStatus: string | null;
  imagePath: string | null;
  imagePreview: string | null;
  directDocumentPaths: string[];
  mindmapsBySession: Record<string, MindMapGraph[]>;
  activeMindmapOverlay: MindmapOverlayState | null;
  generalElapsedTime: number;
  generalGenerationTime: number | null;
  generalGenerating: boolean;
  ttsGenerating: boolean;
  ttsElapsedTime: number;
  ttsGenerationTime: number | null;
}

interface ChatModeActions {
  setChatMode: (mode: ChatMode) => void;
  setThinkingEnabled: (enabled: boolean) => void;
  setRagEnabled: (enabled: boolean) => void;
  setRagDocs: (docs: IngestionStatus[] | ((prev: IngestionStatus[]) => IngestionStatus[])) => void;
  setRagIngesting: (ingesting: boolean) => void;
  setEnrichmentStatus: (status: string | null) => void;
  setWebEnabled: (enabled: boolean) => void;
  setFileIndexerEnabled: (enabled: boolean) => void;
  setLiveToolStatus: (status: string | null) => void;
  setImagePath: (path: string | null) => void;
  setImagePreview: (preview: string | null) => void;
  setDirectDocumentPaths: (paths: string[]) => void;
  setMindmapsBySession: (mindmaps: Record<string, MindMapGraph[]> | ((prev: Record<string, MindMapGraph[]>) => Record<string, MindMapGraph[]>)) => void;
  setActiveMindmapOverlay: (overlay: MindmapOverlayState | null) => void;
  setGeneralElapsedTime: (time: number) => void;
  setGeneralGenerationTime: (time: number | null) => void;
  setGeneralGenerating: (generating: boolean) => void;
  setTtsGenerating: (generating: boolean) => void;
  setTtsElapsedTime: (time: number) => void;
  setTtsGenerationTime: (time: number | null) => void;
  clearImage: () => void;
  clearDirectDocuments: () => void;
  removeDirectDocument: (path: string) => void;
  pruneMindmapsForSessions: (validIds: Set<string>) => void;
  openMindmapOverlay: (sessionId: string, mindmapId: string) => void;
}

export const useChatModeStore = create<ChatModeState & ChatModeActions>((set) => ({
  // Initial state
  chatMode: "text",
  thinkingEnabled: false,
  ragEnabled: false,
  ragDocs: [],
  ragIngesting: false,
  enrichmentStatus: null,
  // Match persisted preferred mode so Cloud sessions start with web search on.
  webEnabled: (() => {
    try {
      const raw = localStorage.getItem("nela.cloud.preferredMode");
      return raw === "cloud" || raw === "auto";
    } catch {
      return false;
    }
  })(),
  fileIndexerEnabled: false,
  liveToolStatus: null,
  imagePath: null,
  imagePreview: null,
  directDocumentPaths: [],
  mindmapsBySession: {},
  activeMindmapOverlay: null,
  generalElapsedTime: 0,
  generalGenerationTime: null,
  generalGenerating: false,
  ttsGenerating: false,
  ttsElapsedTime: 0,
  ttsGenerationTime: null,

  // Actions
  setChatMode: (chatMode) => set({ chatMode }),
  
  setThinkingEnabled: (thinkingEnabled) => set({ thinkingEnabled }),
  
  setRagEnabled: (ragEnabled) => set({ ragEnabled }),
  
  setRagDocs: (docs) =>
    set((state) => ({
      ragDocs: typeof docs === "function" ? docs(state.ragDocs) : docs,
    })),
  
  setRagIngesting: (ragIngesting) => set({ ragIngesting }),
  
  setEnrichmentStatus: (enrichmentStatus) => set({ enrichmentStatus }),
  
  setWebEnabled: (webEnabled) => set({ webEnabled }),

  setFileIndexerEnabled: (fileIndexerEnabled) => set({ fileIndexerEnabled }),
  
  setLiveToolStatus: (liveToolStatus) => set({ liveToolStatus }),
  
  setImagePath: (imagePath) => set({ imagePath }),
  
  setImagePreview: (imagePreview) => set({ imagePreview }),
  
  setDirectDocumentPaths: (directDocumentPaths) => set({ directDocumentPaths }),
  
  setMindmapsBySession: (mindmaps) =>
    set((state) => ({
      mindmapsBySession: typeof mindmaps === 'function' ? mindmaps(state.mindmapsBySession) : mindmaps
    })),
  
  setActiveMindmapOverlay: (activeMindmapOverlay) => set({ activeMindmapOverlay }),
  
  setGeneralElapsedTime: (generalElapsedTime) => set({ generalElapsedTime }),
  
  setGeneralGenerationTime: (generalGenerationTime) => set({ generalGenerationTime }),
  
  setGeneralGenerating: (generalGenerating) => set({ generalGenerating }),
  
  setTtsGenerating: (ttsGenerating) => set({ ttsGenerating }),
  
  setTtsElapsedTime: (ttsElapsedTime) => set({ ttsElapsedTime }),
  
  setTtsGenerationTime: (ttsGenerationTime) => set({ ttsGenerationTime }),
  
  clearImage: () => set({ imagePath: null, imagePreview: null }),
  
  clearDirectDocuments: () => set({ directDocumentPaths: [] }),
  
  removeDirectDocument: (path) =>
    set((state) => ({
      directDocumentPaths: state.directDocumentPaths.filter(p => p !== path)
    })),
  
  pruneMindmapsForSessions: (validIds) =>
    set((state) => {
      const pruned: Record<string, MindMapGraph[]> = {};
      for (const sessionId of validIds) {
        if (state.mindmapsBySession[sessionId]) {
          pruned[sessionId] = state.mindmapsBySession[sessionId];
        }
      }
      return { mindmapsBySession: pruned };
    }),
  
  openMindmapOverlay: (sessionId, mindmapId) =>
    set({
      activeMindmapOverlay: { sessionId, mindmapId }
    })
}));