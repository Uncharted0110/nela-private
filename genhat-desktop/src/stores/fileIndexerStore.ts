import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { Api } from "../api";

export type FileIndexerStatus = {
  phase: string;
  filesTotal: number;
  filesEmbedded: number;
  embedDone: number;
  embedTotal: number;
  message: string;
  running: boolean;
  setupDone: boolean;
};

export type FileIndexerModelInfo = {
  id: string;
  name: string;
  present: boolean;
  cacheDir: string;
  modelDir: string;
  sizeMb: number;
};

export type FileIndexerConfig = {
  setupDone: boolean;
  mode: string;
  roots: string[];
};

type FileIndexerStore = {
  hydrated: boolean;
  setupOpen: boolean;
  chatOpen: boolean;
  /** Panel is docked as a side tab; results stay available. */
  chatMinimized: boolean;
  /** When set, the file-search popup auto-runs this query on open. */
  pendingQuery: string | null;
  config: FileIndexerConfig | null;
  model: FileIndexerModelInfo | null;
  status: FileIndexerStatus;
  defaultRoots: string[];
  hydrate: () => Promise<void>;
  openSetup: () => void;
  closeSetup: () => void;
  openChat: () => void;
  openChatWithQuery: (query: string) => void;
  minimizeChat: () => void;
  closeChat: () => void;
  consumePendingQuery: () => string | null;
  completeSetup: (mode: string, roots: string[]) => Promise<void>;
  applyStatus: (status: FileIndexerStatus) => void;
};

const emptyStatus = (): FileIndexerStatus => ({
  phase: "needs_setup",
  filesTotal: 0,
  filesEmbedded: 0,
  embedDone: 0,
  embedTotal: 0,
  message: "",
  running: false,
  setupDone: false,
});

function normalizeStatus(raw: Record<string, unknown>): FileIndexerStatus {
  return {
    phase: String(raw.phase ?? "unknown"),
    filesTotal: Number(raw.filesTotal ?? raw.files_total ?? 0),
    filesEmbedded: Number(raw.filesEmbedded ?? raw.files_embedded ?? 0),
    embedDone: Number(raw.embedDone ?? raw.embed_done ?? 0),
    embedTotal: Number(raw.embedTotal ?? raw.embed_total ?? 0),
    message: String(raw.message ?? ""),
    running: Boolean(raw.running),
    setupDone: Boolean(raw.setupDone ?? raw.setup_done),
  };
}

function normalizeModel(raw: Record<string, unknown>): FileIndexerModelInfo {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    present: Boolean(raw.present),
    cacheDir: String(raw.cacheDir ?? raw.cache_dir ?? ""),
    modelDir: String(raw.modelDir ?? raw.model_dir ?? ""),
    sizeMb: Number(raw.sizeMb ?? raw.size_mb ?? 87),
  };
}

function normalizeConfig(raw: Record<string, unknown>): FileIndexerConfig {
  return {
    setupDone: Boolean(raw.setupDone ?? raw.setup_done),
    mode: String(raw.mode ?? "default"),
    roots: Array.isArray(raw.roots) ? raw.roots.map(String) : [],
  };
}

let statusUnlisten: (() => void) | null = null;

export const useFileIndexerStore = create<FileIndexerStore>((set, get) => ({
  hydrated: false,
  setupOpen: false,
  chatOpen: false,
  chatMinimized: false,
  pendingQuery: null,
  config: null,
  model: null,
  status: emptyStatus(),
  defaultRoots: [],

  hydrate: async () => {
    try {
      const setup = await Api.fileindexerGetSetup();
      const config = normalizeConfig(setup.config as Record<string, unknown>);
      const model = normalizeModel(setup.model as Record<string, unknown>);
      const status = normalizeStatus(setup.status as Record<string, unknown>);
      const defaultRoots = Array.isArray(setup.defaultRoots)
        ? setup.defaultRoots.map(String)
        : Array.isArray(setup.default_roots)
          ? (setup.default_roots as unknown[]).map(String)
          : [];
      set({
        hydrated: true,
        config,
        model,
        status,
        defaultRoots,
        // Setup belongs in the installer, not first app launch.
        // Keep the modal available via openSetup() for local/dev testing only.
        setupOpen: false,
      });

      if (!statusUnlisten) {
        statusUnlisten = await listen<Record<string, unknown>>("fileindexer:status", (event) => {
          get().applyStatus(normalizeStatus(event.payload));
        });
      }
    } catch (e) {
      console.warn("fileindexer hydrate failed", e);
      set({ hydrated: true, setupOpen: false });
    }
  },

  openSetup: () => set({ setupOpen: true }),
  closeSetup: () => set({ setupOpen: false }),
  openChat: () => set({ chatOpen: true, chatMinimized: false }),
  openChatWithQuery: (query) => {
    const q = query.trim();
    if (!q) {
      set({ chatOpen: true, chatMinimized: false });
      return;
    }
    set({ chatOpen: true, chatMinimized: false, pendingQuery: q });
  },
  minimizeChat: () => {
    if (!get().chatOpen) return;
    set({ chatMinimized: true, pendingQuery: null });
  },
  closeChat: () => set({ chatOpen: false, chatMinimized: false, pendingQuery: null }),
  consumePendingQuery: () => {
    const q = get().pendingQuery;
    if (q != null) set({ pendingQuery: null });
    return q;
  },

  completeSetup: async (mode, roots) => {
    const statusRaw = await Api.fileindexerCompleteSetup(mode, roots);
    const status = normalizeStatus(statusRaw as unknown as Record<string, unknown>);
    set({
      setupOpen: false,
      config: { setupDone: true, mode, roots },
      status,
    });
  },

  applyStatus: (status) => set({ status }),
}));
