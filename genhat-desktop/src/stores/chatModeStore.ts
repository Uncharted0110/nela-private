import { create } from "zustand";
import type { 
  ChatMode, 
  IngestionStatus, 
  InspectedAttachment,
  MindMapGraph,
  PdfParserEngine,
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
  attachmentMetaByPath: Record<string, InspectedAttachment>;
  pdfEngineByPath: Record<string, PdfParserEngine>;
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
  setAttachmentMeta: (path: string, meta: InspectedAttachment | null) => void;
  setPdfEngineForPath: (path: string, engine: PdfParserEngine) => void;
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
  thinkingEnabled: true,
  ragEnabled: false,
  ragDocs: [],
  ragIngesting: false,
  enrichmentStatus: null,
  // Tools available to the LLM by default; it still decides whether to call them.
  webEnabled: true,
  fileIndexerEnabled: true,
  liveToolStatus: null,
  imagePath: null,
  imagePreview: null,
  directDocumentPaths: [],
  attachmentMetaByPath: {},
  pdfEngineByPath: {},
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

  setAttachmentMeta: (path, meta) =>
    set((state) => {
      const next = { ...state.attachmentMetaByPath };
      if (meta) next[path] = meta;
      else delete next[path];
      return { attachmentMetaByPath: next };
    }),

  setPdfEngineForPath: (path, engine) =>
    set((state) => ({
      pdfEngineByPath: { ...state.pdfEngineByPath, [path]: engine },
    })),
  
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
  
  clearDirectDocuments: () =>
    set({
      directDocumentPaths: [],
      attachmentMetaByPath: {},
      pdfEngineByPath: {},
    }),
  
  removeDirectDocument: (path) =>
    set((state) => {
      const attachmentMetaByPath = { ...state.attachmentMetaByPath };
      const pdfEngineByPath = { ...state.pdfEngineByPath };
      delete attachmentMetaByPath[path];
      delete pdfEngineByPath[path];
      return {
        directDocumentPaths: state.directDocumentPaths.filter((p) => p !== path),
        attachmentMetaByPath,
        pdfEngineByPath,
      };
    }),
  
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