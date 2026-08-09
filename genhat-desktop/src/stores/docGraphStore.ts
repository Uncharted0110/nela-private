import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { Api } from "../api";
import type {
  DocGraphBackgroundStatus,
  DocGraphIndexingProgress,
  DocGraphPipelineReport,
  DocGraphStats,
} from "../types";
import { friendlyErrorFromUnknown } from "../app/friendlyError";

type DocGraphStore = {
  hydrated: boolean;
  indexOpen: boolean;
  queryOpen: boolean;
  indexing: boolean;
  lastRoot: string | null;
  progress: DocGraphIndexingProgress | null;
  lastReport: DocGraphPipelineReport | null;
  stats: DocGraphStats | null;
  pass2: DocGraphBackgroundStatus;
  queryText: string;
  queryResult: string | null;
  queryBusy: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  refreshStats: () => Promise<void>;
  refreshPass2: () => Promise<void>;
  openIndex: () => void;
  closeIndex: () => void;
  openQuery: (preset?: string) => void;
  closeQuery: () => void;
  setQueryText: (q: string) => void;
  startIndex: (path: string) => Promise<void>;
  runQuery: (query?: string) => Promise<string>;
  clearKb: () => Promise<void>;
};

const emptyPass2 = (): DocGraphBackgroundStatus => ({
  active: false,
  remaining: 0,
  completed: 0,
  failed: 0,
  total: 0,
});

let progressUnlisten: (() => void) | null = null;
let pass2Unlisten: (() => void) | null = null;
let pass2Poll: ReturnType<typeof setInterval> | null = null;

function stopPass2Poll() {
  if (pass2Poll) {
    clearInterval(pass2Poll);
    pass2Poll = null;
  }
}

function startPass2Poll(get: () => DocGraphStore) {
  stopPass2Poll();
  pass2Poll = setInterval(() => {
    void get().refreshPass2();
  }, 750);
}

export const useDocGraphStore = create<DocGraphStore>((set, get) => ({
  hydrated: false,
  indexOpen: false,
  queryOpen: false,
  indexing: false,
  lastRoot: null,
  progress: null,
  lastReport: null,
  stats: null,
  pass2: emptyPass2(),
  queryText: "",
  queryResult: null,
  queryBusy: false,
  error: null,

  hydrate: async () => {
    try {
      await get().refreshStats();
      await get().refreshPass2();

      if (!progressUnlisten) {
        progressUnlisten = await listen<DocGraphIndexingProgress>(
          "indexing-progress",
          (event) => {
            const progress = event.payload;
            set({ progress });
            if (progress.phase === "pass2" || progress.phase === "pass2-done") {
              void get().refreshPass2();
            }
            if (progress.phase === "done" || progress.phase === "pass2-done") {
              void get().refreshStats();
            }
            if (progress.phase === "pass2-done") {
              stopPass2Poll();
            }
          }
        );
      }
      if (!pass2Unlisten) {
        pass2Unlisten = await listen<DocGraphIndexingProgress>(
          "indexing-pass2-status",
          () => {
            void get().refreshPass2();
          }
        );
      }
      set({ hydrated: true, error: null });
    } catch (e) {
      console.warn("docGraph hydrate failed", e);
      set({ hydrated: true, error: friendlyErrorFromUnknown(e) });
    }
  },

  refreshStats: async () => {
    try {
      const stats = await Api.getKnowledgeBaseStats();
      set({ stats });
    } catch (e) {
      console.warn("docGraph stats failed", e);
    }
  },

  refreshPass2: async () => {
    try {
      const pass2 = await Api.getBackgroundIndexStatus();
      set({ pass2 });
      if (!pass2.active) stopPass2Poll();
    } catch (e) {
      console.warn("docGraph pass2 status failed", e);
    }
  },

  openIndex: () => set({ indexOpen: true, error: null }),
  closeIndex: () => set({ indexOpen: false }),
  openQuery: (preset) =>
    set({
      queryOpen: true,
      error: null,
      ...(typeof preset === "string" ? { queryText: preset } : {}),
    }),
  closeQuery: () => set({ queryOpen: false }),
  setQueryText: (queryText) => set({ queryText }),

  startIndex: async (path: string) => {
    set({
      indexing: true,
      error: null,
      lastRoot: path,
      progress: {
        phase: "starting",
        message: `Indexing ${path}…`,
        filesDiscovered: 0,
        filesParsed: 0,
        filesFailed: 0,
        chunksIndexed: 0,
      },
      lastReport: null,
    });
    try {
      const report = await Api.startIndexingDirectory(path);
      set({ lastReport: report, indexing: false });
      if (report.filesDeferred > 0) {
        startPass2Poll(get);
      }
      await get().refreshStats();
      await get().refreshPass2();
    } catch (e) {
      set({ indexing: false, error: friendlyErrorFromUnknown(e) });
      throw e;
    }
  },

  runQuery: async (query?: string) => {
    const q = (query ?? get().queryText).trim();
    if (!q) {
      throw new Error("Query must not be empty");
    }
    set({ queryBusy: true, error: null, queryText: q });
    try {
      const result = await Api.queryKnowledgeBase(q);
      set({ queryResult: result, queryBusy: false });
      return result;
    } catch (e) {
      const msg = friendlyErrorFromUnknown(e);
      set({ queryBusy: false, error: msg, queryResult: null });
      throw e;
    }
  },

  clearKb: async () => {
    set({ error: null });
    try {
      await Api.clearKnowledgeBase();
      set({
        lastReport: null,
        progress: null,
        queryResult: null,
        pass2: emptyPass2(),
      });
      stopPass2Poll();
      await get().refreshStats();
    } catch (e) {
      set({ error: friendlyErrorFromUnknown(e) });
      throw e;
    }
  },
}));
