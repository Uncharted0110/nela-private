import { create } from "zustand";
import type { 
  ChatSession, 
  ChatContextUsage 
} from "../types";
import { createEmptySession } from "../app/sessionUtils";
import { llamaContextKey, releaseLlamaSlot } from "../app/llamaSlotAffinity";
import { useChatModeStore } from "./chatModeStore";
import { useWorkspaceStore } from "./workspaceStore";

// Module-level AbortControllers map for session management
export const abortControllers = new Map<string, AbortController>();

interface SessionState {
  sessions: ChatSession[];
  openSessionIds: string[];
  activeSessionId: string;
  sessionStoreReady: boolean;
  contextUsageBySession: Record<string, ChatContextUsage>;
  streamingThinking: string;
  contextCompacting: boolean;
}

interface SessionActions {
  setSessions: (
    sessions: ChatSession[] | ((prev: ChatSession[]) => ChatSession[])
  ) => void;
  setOpenSessionIds: (ids: string[] | ((prev: string[]) => string[])) => void;
  setActiveSessionId: (id: string) => void;
  setSessionStoreReady: (ready: boolean) => void;
  setStreamingThinking: (thinking: string) => void;
  setContextCompacting: (compacting: boolean) => void;
  setContextUsageBySession: (usage: Record<string, ChatContextUsage> | ((prev: Record<string, ChatContextUsage>) => Record<string, ChatContextUsage>)) => void;
  setContextUsageForSession: (sessionId: string, usage: ChatContextUsage) => void;
  updateSession: (sessionId: string, patch: Partial<ChatSession> | ((session: ChatSession) => Partial<ChatSession>)) => void;
  addNewSession: (hasActiveWorkspace: boolean) => void;
  openSessionInViewer: (sessionId: string) => void;
  closeViewerTab: (sessionId: string) => void;
  closeSession: (sessionId: string) => void;
  reorderViewerTabs: (reordered: ChatSession[]) => void;
  resetSessionsToFresh: () => void;
  applyRestoredSessions: (loaded: ChatSession[], openIds: string[], activeId: string) => void;
  getActiveSession: () => ChatSession | null;
}

export const useSessionStore = create<SessionState & SessionActions>((set, get) => ({
  // Initial state
  sessions: [createEmptySession()],
  openSessionIds: [],
  activeSessionId: "",
  sessionStoreReady: false,
  contextUsageBySession: {},
  streamingThinking: "",
  contextCompacting: false,

  // Actions
  setSessions: (sessions) =>
    set((state) => ({
      sessions: typeof sessions === "function" ? sessions(state.sessions) : sessions,
    })),

  setOpenSessionIds: (openSessionIds) =>
    set((state) => ({
      openSessionIds:
        typeof openSessionIds === "function"
          ? openSessionIds(state.openSessionIds)
          : openSessionIds,
    })),
  
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  
  setSessionStoreReady: (sessionStoreReady) => set({ sessionStoreReady }),
  
  setStreamingThinking: (streamingThinking) => set({ streamingThinking }),
  
  setContextCompacting: (contextCompacting) => set({ contextCompacting }),
  
  setContextUsageBySession: (usage) =>
    set((state) => ({
      contextUsageBySession: typeof usage === 'function' ? usage(state.contextUsageBySession) : usage
    })),
  
  setContextUsageForSession: (sessionId, usage) =>
    set((state) => ({
      contextUsageBySession: {
        ...state.contextUsageBySession,
        [sessionId]: usage
      }
    })),
  
  updateSession: (sessionId, patch) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, ...(typeof patch === 'function' ? patch(session) : patch) }
          : session
      )
    })),
  
  addNewSession: (hasActiveWorkspace) => {
    if (!hasActiveWorkspace) return;
    
    const newSession = createEmptySession();
    set((state) => ({
      sessions: [...state.sessions, newSession],
      openSessionIds: [...state.openSessionIds, newSession.id],
      activeSessionId: newSession.id
    }));
  },
  
  openSessionInViewer: (sessionId) =>
    set((state) => ({
      openSessionIds: state.openSessionIds.includes(sessionId) 
        ? state.openSessionIds 
        : [...state.openSessionIds, sessionId],
      activeSessionId: sessionId
    })),
  
  closeViewerTab: (sessionId) =>
    set((state) => {
      if (!state.openSessionIds.includes(sessionId)) return state;
      const prev = state.openSessionIds;
      const next = prev.filter((id) => id !== sessionId);
      let activeSessionId = state.activeSessionId;
      if (state.activeSessionId === sessionId) {
        if (next.length === 0) {
          activeSessionId = "";
        } else {
          const closedIdx = prev.findIndex((id) => id === sessionId);
          const nextIdx = Math.min(closedIdx, next.length - 1);
          activeSessionId = next[nextIdx];
        }
      }
      return { openSessionIds: next, activeSessionId };
    }),
  
  closeSession: (sessionId) => {
    // Abort any ongoing request for this session
    const controller = abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      abortControllers.delete(sessionId);
    }

    // Free this chat's llama-server KV slot so a new chat can take it.
    try {
      const workspaceId = useWorkspaceStore.getState().activeWorkspace?.id ?? "default";
      releaseLlamaSlot(llamaContextKey(workspaceId, sessionId));
    } catch (error) {
      console.warn("Failed to release llama slot for closed session:", error);
    }
    
    set((state) => {
      const newSessions = state.sessions.filter(s => s.id !== sessionId);
      const newOpenIds = state.openSessionIds.filter(id => id !== sessionId);
      const { [sessionId]: _removedUsage, ...newContextUsage } = state.contextUsageBySession;
      void _removedUsage;
      
      let newActiveId = state.activeSessionId;
      if (state.activeSessionId === sessionId) {
        newActiveId = newOpenIds.length > 0 ? newOpenIds[0] : 
          newSessions.length > 0 ? newSessions[0].id : "";
      }
      
      return {
        sessions: newSessions,
        openSessionIds: newOpenIds,
        activeSessionId: newActiveId,
        contextUsageBySession: newContextUsage
      };
    });
    
    // Clear mindmaps for this session (lazy import to avoid circular dependency)
    try {
      const chatModeStore = useChatModeStore.getState();
      const currentMindmaps = chatModeStore.mindmapsBySession;
      if (currentMindmaps[sessionId]) {
        const { [sessionId]: _removedMaps, ...remaining } = currentMindmaps;
        void _removedMaps;
        chatModeStore.setMindmapsBySession(remaining);
      }
    } catch (error) {
      console.warn("Failed to clear mindmaps for closed session:", error);
    }
  },
  
  reorderViewerTabs: (reordered) =>
    set({ openSessionIds: reordered.map((s) => s.id) }),
  
  resetSessionsToFresh: () => {
    const freshSession = createEmptySession();
    set({
      sessions: [freshSession],
      openSessionIds: [freshSession.id],
      activeSessionId: freshSession.id,
      contextUsageBySession: {}
    });
  },
  
  applyRestoredSessions: (loaded, openIds, activeId) =>
    set({
      sessions: loaded,
      openSessionIds: openIds,
      activeSessionId: activeId
    }),
  
  getActiveSession: () => {
    const state = get();
    return state.sessions.find(s => s.id === state.activeSessionId) || null;
  }
}));