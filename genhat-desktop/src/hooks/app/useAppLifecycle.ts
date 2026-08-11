import { useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  ChatMode,
  ChatContextUsage,
  ChatSession,
  KittenTtsVoice,
  MindMapGraph,
} from "../../types";
import { KITTEN_TTS_VOICES } from "../../types";
import {
  SESSION_STORAGE_PREFIX,
  STARTUP_MODEL_SELECTOR,
} from "../../app/constants";
import {
  readIntelligenceMapping,
  resolveModeForModelId,
  writeIntelligenceMode,
} from "../../app/intelligenceModes";
import { refreshModels, downloadMissingOptionalModels } from "../../app/modelActions";
import { loadRagDocs, buildWorkspaceFrontendState, buildLocalSessionMirrorState, hydrateSessionFromBackend } from "../../app/workspaceBridge";
import { createEmptySession, normalizeSession } from "../../app/sessionUtils";
import { normalizeMindmapsStore } from "../../app/mindmapUtils";
import {
  CONTEXT_COMPACTION_KEEP_RECENT,
  CONTEXT_COMPACTION_THRESHOLD,
  resolveReservedOutputTokens,
  toContextMessages,
} from "../../app/contextCompaction";
import { Api } from "../../api";
import { useSessionStore } from "../../stores/sessionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useChatModeStore, setVisionUnlisten } from "../../stores/chatModeStore";
import { useModelStore } from "../../stores/modelStore";
import { useUIStore } from "../../stores/uiStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useCloudStore } from "../../stores/cloudStore";
import { useTour } from "../useTour";

export function useAppLifecycle() {
  const { setBindings } = useTour();
  
  // Only subscribe to specific values that should trigger effects to re-run
  const activeWorkspace = useWorkspaceStore(s => s.activeWorkspace);
  const workspaceScope = useWorkspaceStore(s => s.workspaceScope);
  const sessionStoreReady = useSessionStore(s => s.sessionStoreReady);
  const sessions = useSessionStore(s => s.sessions);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const openSessionIds = useSessionStore(s => s.openSessionIds);
  /** Lean fingerprint so streaming token updates do not re-trigger persistence. */
  const sessionPersistRevision = useSessionStore((s) =>
    s.sessions
      .map(
        (session) =>
          `${session.id}:${session.messages.length}:${session.title}:${session.loading ? 1 : 0}:${session.cancelled ? 1 : 0}:${session.artifactPath ?? ""}:${session.artifactStage ?? ""}`
      )
      .join("|")
  );
  const mindmapsBySession = useChatModeStore(s => s.mindmapsBySession);
  const activeMindmapOverlay = useChatModeStore(s => s.activeMindmapOverlay);
  const selectedModel = useModelStore(s => s.selectedModel);
  const selectedTtsEngine = useModelStore(s => s.selectedTtsEngine);
  const selectedVisionModel = useModelStore(s => s.selectedVisionModel);
  const registeredModels = useModelStore(s => s.registeredModels);
  const intelligenceMapping = useModelStore(s => s.intelligenceMapping);
  const useSpecificModelPicker = useModelStore(s => s.useSpecificModelPicker);
  const intelligenceMode = useModelStore(s => s.intelligenceMode);
  const preferredMode = useCloudStore(s => s.preferredMode);
  const chatMode = useChatModeStore(s => s.chatMode);
  const modeSwitchNotice = useUIStore(s => s.modeSwitchNotice);
  const settingsOpen = useUIStore(s => s.settingsOpen);
  const startupModelToast = useDownloadStore(s => s.startupModelToast);
  const downloadOptionalOnStart = useDownloadStore(s => s.downloadOptionalOnStart);
  const modelCatalog = useModelStore(s => s.modelCatalog);

  // Refs for tracking various timeouts and states
  const modeSwitchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const startupToastTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const startupPresenceNoticeShownRef = useRef(false);
  const legacySessionStorageDisabledRef = useRef(false);
  const sessionQuotaPromptedRef = useRef(false);
  const refreshModelsOnDownloadRef = useRef<() => Promise<unknown[]>>(async () => []);

  // Set up tour bindings
  useEffect(() => {
    setBindings({
      openSettings: () => useUIStore.getState().setSettingsOpen(true),
      openTours: () => useUIStore.getState().setToursOpen(true),
      openDocPanel: () => useUIStore.getState().setDocPanelOpen(true),
      switchMode: (mode: ChatMode) => {
        const chatModeStore = useChatModeStore.getState();
        const uiStore = useUIStore.getState();
        chatModeStore.setChatMode(mode);
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
      },
    });
  }, [setBindings]);

  // Keyboard shortcut: Ctrl+T to open a new chat
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "t") {
        e.preventDefault();
        const sessionStore = useSessionStore.getState();
        const workspaceStore = useWorkspaceStore.getState();
        sessionStore.addNewSession(!!workspaceStore.activeWorkspace);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Lifecycle initialization (refreshModels + loadRagDocs on mount)
  useEffect(() => {
    const initializeApp = async () => {
      await refreshModels();
      await loadRagDocs();
    };
    initializeApp();
    
    return () => {
      setVisionUnlisten(null);
    };
  }, []);

  // Listen for backend events (model loading, workspace ready)
  useEffect(() => {
    let unlistenModelLoading: (() => void) | null = null;
    let unlistenWorkspaceReady: (() => void) | null = null;

    const setupListeners = async () => {
      // Model loading progress events
      unlistenModelLoading = await listen<{
        model_id: string;
        status: "starting" | "ready" | "error" | "timeout";
        message: string;
      }>("model-loading", (event) => {
        const { status, model_id, message } = event.payload;
        const modelStore = useModelStore.getState();
        if (status === "starting") {
          modelStore.setModelLoadingStatus({ loading: true, modelId: model_id, message });
        } else {
          // Clear loading state on ready, error, or timeout
          modelStore.setModelLoadingStatus({ loading: false, modelId: "", message: "" });
        }
      });

      // Workspace ready events (emitted after RAG pipeline is reloaded)
      unlistenWorkspaceReady = await listen<{
        workspace_id: string;
        status: string;
      }>("workspace-ready", (event) => {
        console.log("Workspace ready:", event.payload.workspace_id);
        // The workspace is now fully initialized - state restoration can proceed
      });
    };

    void setupListeners();

    return () => {
      unlistenModelLoading?.();
      unlistenWorkspaceReady?.();
    };
  }, []);

  // Start from neutral scope and let startup actions choose the real workspace scope
  useEffect(() => {
    useSessionStore.getState().setSessionStoreReady(false);
    useWorkspaceStore.getState().setWorkspaceScope("workspace:none");
  }, []);

  // Initialize workspace state
  useEffect(() => {
    const initializeWorkspace = async () => {
      try {
        const [all, active] = await Promise.all([
          Api.listWorkspaces(),
          Api.getActiveWorkspace().catch(() => null),
        ]);
        const workspaceStore = useWorkspaceStore.getState();
        workspaceStore.setWorkspaces(all);
        workspaceStore.setStartupContinueWorkspace(
          active && all.some((workspace) => workspace.id === active.id) ? active : null
        );
        workspaceStore.setActiveWorkspace(null);
      } catch (err) {
        console.warn("Failed to initialize workspace state:", err);
      }
    };
    void initializeWorkspace();
  }, []);

  // Session quota handling
  const promptClearSessionStorage = useCallback(() => {
    if (sessionQuotaPromptedRef.current) return;
    if (useUIStore.getState().appModal.open) return;
    sessionQuotaPromptedRef.current = true;

    const uiStore = useUIStore.getState();
    uiStore.confirmAction(
      "Session storage is full",
      "Local session cache is full. Do you want to clear cached session storage now?",
      "Clear storage",
      "Not now"
    ).then((confirmed) => {
      sessionQuotaPromptedRef.current = false;
      if (!confirmed) return;
      try {
        for (let i = localStorage.length - 1; i >= 0; i -= 1) {
          const key = localStorage.key(i);
          if (!key) continue;
          if (key.startsWith(SESSION_STORAGE_PREFIX)) {
            localStorage.removeItem(key);
          }
        }
        legacySessionStorageDisabledRef.current = false;
        useUIStore.getState().showModal("info", "Session storage cleared", "Local cached session storage was cleared. You can continue normally.");
      } catch (err) {
        console.warn("Failed to clear session storage cache:", err);
      }
    });
  }, []);

  // Restore persisted chat sessions for the active workspace
  useEffect(() => {
    if (!workspaceScope) return;

    let cancelled = false;

    const applyRawState = (raw: string | null) => {
      if (!raw) {
        const fresh = createEmptySession();
        const sessionStore = useSessionStore.getState();
        const chatModeStore = useChatModeStore.getState();
        sessionStore.setSessions([fresh]);
        sessionStore.setOpenSessionIds([fresh.id]);
        sessionStore.setActiveSessionId(fresh.id);
        chatModeStore.setMindmapsBySession({});
        chatModeStore.setActiveMindmapOverlay(null);
        return;
      }

      try {
        const parsed = JSON.parse(raw) as {
          sessions?: Partial<ChatSession>[];
          activeSessionId?: string;
          openSessionIds?: string[];
          mindmapsBySession?: Record<string, unknown>;
          selectedModel?: string;
          selectedTtsEngine?: string;
          selectedVisionModel?: string;
        };
        const loaded = Array.isArray(parsed.sessions)
          ? parsed.sessions.map(normalizeSession)
          : [];
        const restoredMindmaps = normalizeMindmapsStore(parsed.mindmapsBySession);
        
        const sessionStore = useSessionStore.getState();
        const chatModeStore = useChatModeStore.getState();
        const modelStore = useModelStore.getState();

        if (loaded.length === 0) {
          const fresh = createEmptySession();
          sessionStore.setSessions([fresh]);
          sessionStore.setOpenSessionIds([fresh.id]);
          sessionStore.setActiveSessionId(fresh.id);
          chatModeStore.setMindmapsBySession({});
        } else {
          sessionStore.setSessions(loaded);
          const nextActive =
            parsed.activeSessionId && loaded.some((s) => s.id === parsed.activeSessionId)
              ? parsed.activeSessionId
              : loaded[0].id;
          const restoredOpen = Array.isArray(parsed.openSessionIds)
            ? parsed.openSessionIds.filter((id) => loaded.some((s) => s.id === id))
            : [];
          sessionStore.setOpenSessionIds(restoredOpen.length > 0 ? restoredOpen : [nextActive]);
          sessionStore.setActiveSessionId(nextActive);
          chatModeStore.setMindmapsBySession(restoredMindmaps);
        }

        // Restore per-workspace model selections
        if (parsed.selectedModel) modelStore.setSelectedModel(parsed.selectedModel);
        if (parsed.selectedTtsEngine) modelStore.setSelectedTtsEngine(parsed.selectedTtsEngine);
        if (parsed.selectedVisionModel) modelStore.setSelectedVisionModel(parsed.selectedVisionModel);

        chatModeStore.setActiveMindmapOverlay(null);
      } catch (err) {
        console.error("Failed to parse workspace state:", err);
        const fresh = createEmptySession();
        const sessionStore = useSessionStore.getState();
        const chatModeStore = useChatModeStore.getState();
        sessionStore.setSessions([fresh]);
        sessionStore.setOpenSessionIds([fresh.id]);
        sessionStore.setActiveSessionId(fresh.id);
        chatModeStore.setMindmapsBySession({});
        chatModeStore.setActiveMindmapOverlay(null);
      }
    };

    (async () => {
      try {
        // Primary store: workspace backend state blob.
        const backendState = await Api.getWorkspaceFrontendState();
        if (cancelled) return;
        if (backendState) {
          applyRawState(backendState);
          return;
        }

        // Compatibility fallback: legacy localStorage key.
        const storageKey = `${SESSION_STORAGE_PREFIX}${useWorkspaceStore.getState().workspaceScope}`;
        const raw = localStorage.getItem(storageKey);
        if (cancelled) return;
        applyRawState(raw);
      } catch (err) {
        console.error("Failed to restore workspace sessions:", err);
        if (cancelled) return;
        const fresh = createEmptySession();
        const sessionStore = useSessionStore.getState();
        const chatModeStore = useChatModeStore.getState();
        sessionStore.setSessions([fresh]);
        sessionStore.setOpenSessionIds([fresh.id]);
        sessionStore.setActiveSessionId(fresh.id);
        chatModeStore.setMindmapsBySession({});
        chatModeStore.setActiveMindmapOverlay(null);
      } finally {
        if (!cancelled) useSessionStore.getState().setSessionStoreReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceScope]);

  // Persist sessions whenever they change (debounced; paused while generating).
  useEffect(() => {
    if (!workspaceScope || !sessionStoreReady) return;
    if (workspaceScope === "workspace:none") return;

    const latestSnapshot = useSessionStore.getState();
    if (latestSnapshot.sessions.length === 0) return;

    const anyGenerating = latestSnapshot.sessions.some((s) => s.loading);
    // Avoid freezing the UI by syncing huge streaming state to disk on every token.
    const delayMs = anyGenerating ? 3000 : 500;
    /** ~2MB budget for the legacy localStorage mirror (UTF-16 ≈ 2 bytes/char). */
    const LOCAL_MIRROR_CHAR_BUDGET = 1_000_000;

    const timer = window.setTimeout(() => {
      const latest = useSessionStore.getState();
      const safeActive = latest.sessions.some((s) => s.id === latest.activeSessionId)
        ? latest.activeSessionId
        : latest.sessions[0]?.id;
      if (!safeActive) return;

      const stillGenerating = latest.sessions.some((s) => s.loading);
      const storageKey = `${SESSION_STORAGE_PREFIX}${workspaceScope}`;
      const backendState = buildWorkspaceFrontendState(safeActive);
      const localMirror = buildLocalSessionMirrorState(safeActive);

      // localStorage: active chat only; skip while generating; size-gate / silence quota.
      if (!legacySessionStorageDisabledRef.current && !stillGenerating) {
        if (localMirror.length > LOCAL_MIRROR_CHAR_BUDGET) {
          legacySessionStorageDisabledRef.current = true;
          console.warn(
            "Disabling legacy localStorage session mirror: payload exceeds size budget"
          );
        } else {
          try {
            localStorage.setItem(storageKey, localMirror);
          } catch (err) {
            const isQuotaError =
              err instanceof DOMException &&
              (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");

            if (isQuotaError) {
              legacySessionStorageDisabledRef.current = true;
              try {
                for (let i = localStorage.length - 1; i >= 0; i -= 1) {
                  const key = localStorage.key(i);
                  if (!key) continue;
                  if (key.startsWith(SESSION_STORAGE_PREFIX)) {
                    localStorage.removeItem(key);
                  }
                }
              } catch {
                /* ignore */
              }
              // Prefer silent backend-only fallback; prompt at most once if needed later.
              void Api.saveWorkspaceFrontendState(backendState)
                .then(() => {
                  /* backend has the full state — no popup required */
                })
                .catch(() => {
                  promptClearSessionStorage();
                });
            } else {
              console.warn("Failed to persist legacy localStorage session state:", err);
            }
          }
        }
      }

      void Api.saveWorkspaceFrontendState(backendState).catch((err) => {
        console.warn("Failed to persist workspace frontend state to backend:", err);
      });
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [
    workspaceScope,
    sessionStoreReady,
    sessionPersistRevision,
    activeSessionId,
    openSessionIds,
    mindmapsBySession,
    selectedModel,
    selectedTtsEngine,
    selectedVisionModel,
    promptClearSessionStorage,
  ]);

  // Hydrate stubbed (localStorage-only) chats from backend when selected.
  useEffect(() => {
    if (!sessionStoreReady || !activeSessionId) return;
    void hydrateSessionFromBackend(activeSessionId);
  }, [sessionStoreReady, activeSessionId]);

  // Keep active session aligned with currently open viewer tabs
  useEffect(() => {
    const sessionStore = useSessionStore.getState();
    if (openSessionIds.length === 0) {
      if (activeSessionId) sessionStore.setActiveSessionId("");
      return;
    }

    const isActiveOpen = openSessionIds.includes(activeSessionId);
    if (!isActiveOpen) {
      sessionStore.setActiveSessionId(openSessionIds[0]);
    }
  }, [openSessionIds, activeSessionId]);

  // Keep open viewer tabs valid if chat history changes
  useEffect(() => {
    if (sessions.length === 0) return;
    const sessionStore = useSessionStore.getState();
    sessionStore.setOpenSessionIds((prev) => {
      const valid = prev.filter((id) => sessions.some((s) => s.id === id));
      return valid.length > 0 ? valid : [sessions[0].id];
    });
  }, [sessions]);

  // Cleanup invalid context usage entries
  useEffect(() => {
    const valid = new Set(sessions.map((session) => session.id));
    const sessionStore = useSessionStore.getState();
    sessionStore.setContextUsageBySession((prev) => {
      let changed = false;
      const next: Record<string, ChatContextUsage> = {};
      Object.entries(prev).forEach(([sessionId, usage]) => {
        if (valid.has(sessionId)) {
          next[sessionId] = usage;
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [sessions]);

  // Cleanup invalid mindmaps entries
  useEffect(() => {
    const validSessionIds = new Set(sessions.map((session) => session.id));
    const chatModeStore = useChatModeStore.getState();
    chatModeStore.setMindmapsBySession((prev) => {
      const next: Record<string, MindMapGraph[]> = {};
      let changed = false;
      Object.entries(prev).forEach(([sessionId, maps]) => {
        if (validSessionIds.has(sessionId) && maps.length > 0) {
          next[sessionId] = maps;
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });

    const currentOverlay = activeMindmapOverlay;
    const currentMindmapsBySession = mindmapsBySession;
    if (currentOverlay && (!validSessionIds.has(currentOverlay.sessionId) || 
        (currentOverlay.mindmapId && !((currentMindmapsBySession[currentOverlay.sessionId] ?? []).some(map => map.id === currentOverlay.mindmapId))))) {
      chatModeStore.setActiveMindmapOverlay(null);
    }
  }, [sessions, mindmapsBySession, activeMindmapOverlay]);

  // Clear mode switch notice after a short duration
  useEffect(() => {
    if (!modeSwitchNotice) return;
    if (modeSwitchTimeoutRef.current) clearTimeout(modeSwitchTimeoutRef.current);
    modeSwitchTimeoutRef.current = setTimeout(() => {
      useUIStore.getState().setModeSwitchNotice(null);
      modeSwitchTimeoutRef.current = null;
    }, 1800);
    return () => {
      if (modeSwitchTimeoutRef.current) {
        clearTimeout(modeSwitchTimeoutRef.current);
      }
    };
  }, [modeSwitchNotice]);

  // Never carry mode-switch text into another chat tab
  useEffect(() => {
    useUIStore.getState().setModeSwitchNotice(null);
  }, [activeSessionId]);

  // Context usage analysis
  useEffect(() => {
    const activeSession = useSessionStore.getState().getActiveSession();
    if (!activeSession) return;
    if (chatMode !== "text" && chatMode !== "mindmap") return;

    let cancelled = false;

    const analyzeContext = async () => {
      try {
        const modelStore = useModelStore.getState();
        const generation = modelStore.getChatGenerationOptions(selectedModel);
        const result = await Api.compactChatContext({
          messages: toContextMessages(activeSession.messages),
          contextWindowTokens: modelStore.getContextWindowTokens(selectedModel),
          reservedOutputTokens: resolveReservedOutputTokens(generation.maxTokens),
          thresholdPercent: CONTEXT_COMPACTION_THRESHOLD,
          allowAutoCompaction: false,
          forceCompaction: false,
          preserveRecentMessages: CONTEXT_COMPACTION_KEEP_RECENT,
          modelOverride: selectedModel || null,
        });

        if (cancelled) return;
        useSessionStore.getState().setContextUsageForSession(activeSession.id, result.usage);
      } catch (err) {
        if (!cancelled) {
          console.warn("Failed to analyze context usage:", err);
        }
      }
    };

    void analyzeContext();

    return () => {
      cancelled = true;
    };
  }, [
    activeSessionId,
    chatMode,
    selectedModel,
  ]);

  // Startup presence toast
  useEffect(() => {
    if (startupPresenceNoticeShownRef.current) return;
    if (!activeWorkspace || !sessionStoreReady) return;
    if (modelCatalog.length === 0) return;

    const optionalForStartup = modelCatalog.filter((model) =>
      model.tasks.some((task) => STARTUP_MODEL_SELECTOR.tasks.has(task)) ||
      STARTUP_MODEL_SELECTOR.ids.has(model.id)
    );
    if (optionalForStartup.length === 0) return;

    const present = optionalForStartup.filter((model) => model.is_downloaded);
    const missing = optionalForStartup.filter((model) => !model.is_downloaded);
    if (missing.length > 0) {
      useDownloadStore.getState().setStartupModelToast({
        open: true,
        phase: "prompt",
        message: `${present.length}/${optionalForStartup.length} models are present.`,
        missingIds: missing.map((model) => model.id),
        missingNames: missing.map((model) => model.name),
        missingSizesMb: missing.map((model) => model.memory_mb),
        selectedIds: missing.map((model) => model.id),
        doneIds: [],
        failedIds: [],
        completed: 0,
        total: missing.length,
        failed: 0,
      });
    } else {
      useDownloadStore.getState().setStartupModelToast({
        open: true,
        phase: "info",
        message: `All ${optionalForStartup.length} models are already present.`,
        missingIds: [],
        missingNames: [],
        missingSizesMb: [],
        selectedIds: [],
        doneIds: [],
        failedIds: [],
        completed: 0,
        total: 0,
        failed: 0,
      });
    }
    startupPresenceNoticeShownRef.current = true;
  }, [activeWorkspace, sessionStoreReady, modelCatalog]);

  // Startup toast timeout management
  useEffect(() => {
    const toast = useDownloadStore.getState().startupModelToast;
    if (!toast.open) return;
    if (toast.phase === "prompt" || toast.phase === "downloading") return;
    if (startupToastTimeoutRef.current) clearTimeout(startupToastTimeoutRef.current);
    startupToastTimeoutRef.current = setTimeout(() => {
      useDownloadStore.getState().setStartupModelToast((prev) => ({ ...prev, open: false }));
      startupToastTimeoutRef.current = null;
    }, 5000);
    return () => {
      if (startupToastTimeoutRef.current) {
        clearTimeout(startupToastTimeoutRef.current);
      }
    };
  }, [startupModelToast.open, startupModelToast.phase]);

  // Reset startup toast minimized state when phase changes
  useEffect(() => {
    if (startupModelToast.phase !== "downloading") {
      useDownloadStore.getState().setStartupToastMinimized(false);
    }
  }, [startupModelToast.phase]);

  // Reload RAG docs periodically when in text/mindmap modes
  useEffect(() => {
    if (chatMode === "text" || chatMode === "mindmap") {
      loadRagDocs();
    }
  }, [chatMode]);

  // Listen for background enrichment progress events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ enriched_this_round: number; status: string }>(
      "rag:enrichment_progress",
      (event) => {
        if (event.payload.status === "in_progress") {
          const chatModeStore = useChatModeStore.getState();
          chatModeStore.setEnrichmentStatus(
            `Enriched ${event.payload.enriched_this_round} chunks`
          );
          loadRagDocs();
          setTimeout(() => chatModeStore.setEnrichmentStatus(null), 5000);
        }
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Download progress listener
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ model_id: string; progress: number; status: string; speed_bps?: number }>(
      "model-download-progress",
      (e) => {
        const downloadStore = useDownloadStore.getState();
        downloadStore.setDownloadProgress(
          e.payload.model_id,
          e.payload.progress,
          e.payload.status,
          e.payload.speed_bps
        );
        
        if (e.payload.progress >= 100 && e.payload.status === "Complete") {
          setTimeout(() => {
            void refreshModelsOnDownloadRef.current();
          }, 1000);
          setTimeout(() => {
            downloadStore.clearDownload(e.payload.model_id);
          }, 3000);
        }
      }
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Set refresh models callback
  refreshModelsOnDownloadRef.current = refreshModels;

  // TTS voice/speed sync from engine params
  useEffect(() => {
    if (!selectedTtsEngine) return;
    const engine = registeredModels.find((m) => m.id === selectedTtsEngine);
    if (!engine) return;

    const modelStore = useModelStore.getState();
    const configuredVoice = engine.params?.voice;
    if (configuredVoice && KITTEN_TTS_VOICES.includes(configuredVoice as KittenTtsVoice)) {
      modelStore.setTtsVoice(configuredVoice as KittenTtsVoice);
    }

    const configuredSpeed = parseFloat(engine.params?.speed || "");
    if (!isNaN(configuredSpeed)) {
      const clamped = Math.max(0.5, Math.min(2.0, configuredSpeed));
      modelStore.setTtsSpeed(clamped);
    }
  }, [selectedTtsEngine, registeredModels]);

  // Intelligence mode sync
  useEffect(() => {
    // In Cloud mode, Fast/Smart/Deep are OpenRouter quality tiers and must not be
    // overwritten by local GGUF mapping from the currently-selected local model id.
    if (preferredMode !== "local") return;
    if (!selectedModel || useSpecificModelPicker) return;
    const matched = resolveModeForModelId(selectedModel, intelligenceMapping);
    if (matched && matched !== intelligenceMode) {
      const modelStore = useModelStore.getState();
      modelStore.setIntelligenceMode(matched);
      writeIntelligenceMode(matched);
    }
  }, [preferredMode, selectedModel, intelligenceMapping, useSpecificModelPicker, intelligenceMode]);

  // Clean up TTS and general timers on unmount
  useEffect(() => {
    return () => {
      // Timer cleanup happens automatically when intervals are cleared via store setters
    };
  }, []);

  // Settings open → refresh intelligence mapping
  useEffect(() => {
    if (!settingsOpen) {
      useModelStore.getState().setIntelligenceMapping(readIntelligenceMapping());
    }
  }, [settingsOpen]);

  // Download optional models on startup preference
  useEffect(() => {
    if (downloadOptionalOnStart) {
      void downloadMissingOptionalModels();
    }
  }, [downloadOptionalOnStart]);
}