import { create } from "zustand";
import type { DownloadStateMap, StartupModelToastState } from "../app/types";

// Constants for localStorage keys
const STARTUP_OPTIONAL_DOWNLOAD_KEY = "nela:startup:optional-download";

// Module-level cancellation request flag
export const startupCancelRequested = { current: false };

export const setStartupCancelRequested = (value: boolean) => {
  startupCancelRequested.current = value;
};

interface DownloadState {
  downloads: DownloadStateMap;
  downloadOptionalOnStart: boolean;
  startupModelToast: StartupModelToastState;
  startupToastMinimized: boolean;
  startupCancellingIds: string[];
  startupCancelledIds: string[];
}

interface DownloadActions {
  setDownloads: (downloads: DownloadStateMap | ((prev: DownloadStateMap) => DownloadStateMap)) => void;
  setDownloadOptionalOnStart: (enabled: boolean) => void;
  setStartupModelToast: (toast: StartupModelToastState | ((prev: StartupModelToastState) => StartupModelToastState)) => void;
  setStartupToastMinimized: (minimized: boolean) => void;
  setStartupCancellingIds: (ids: string[] | ((prev: string[]) => string[])) => void;
  setStartupCancelledIds: (ids: string[] | ((prev: string[]) => string[])) => void;
  patchStartupToast: (updater: (prev: StartupModelToastState) => StartupModelToastState) => void;
  clearDownload: (modelId: string) => void;
  setDownloadProgress: (modelId: string, progress: number, status: string, speedBps?: number) => void;
}

function getInitialDownloadOptionalOnStart(): boolean {
  try {
    return localStorage.getItem(STARTUP_OPTIONAL_DOWNLOAD_KEY) === "true";
  } catch {
    return false;
  }
}

export const useDownloadStore = create<DownloadState & DownloadActions>((set) => ({
  // Initial state
  downloads: {},
  downloadOptionalOnStart: getInitialDownloadOptionalOnStart(),
  startupModelToast: {
    open: false,
    phase: "prompt",
    message: "",
    missingIds: [],
    missingNames: [],
    missingSizesMb: [],
    selectedIds: [],
    doneIds: [],
    failedIds: [],
    completed: 0,
    total: 0,
    failed: 0
  },
  startupToastMinimized: false,
  startupCancellingIds: [],
  startupCancelledIds: [],

  // Actions
  setDownloads: (downloads) =>
    set((state) => ({
      downloads: typeof downloads === "function" ? downloads(state.downloads) : downloads,
    })),

  setDownloadOptionalOnStart: (downloadOptionalOnStart) => {
    set({ downloadOptionalOnStart });
    try {
      localStorage.setItem(STARTUP_OPTIONAL_DOWNLOAD_KEY, downloadOptionalOnStart ? "true" : "false");
    } catch {
      // Ignore localStorage errors
    }
  },

  setStartupModelToast: (toast) =>
    set((state) => ({
      startupModelToast: typeof toast === "function" ? toast(state.startupModelToast) : toast,
    })),

  setStartupToastMinimized: (startupToastMinimized) => set({ startupToastMinimized }),

  setStartupCancellingIds: (ids) =>
    set((state) => ({
      startupCancellingIds: typeof ids === "function" ? ids(state.startupCancellingIds) : ids,
    })),

  setStartupCancelledIds: (ids) =>
    set((state) => ({
      startupCancelledIds: typeof ids === "function" ? ids(state.startupCancelledIds) : ids,
    })),
  
  patchStartupToast: (updater) =>
    set((state) => ({
      startupModelToast: updater(state.startupModelToast)
    })),
  
  clearDownload: (modelId) =>
    set((state) => {
      const { [modelId]: _removed, ...remainingDownloads } = state.downloads;
      void _removed;
      return { downloads: remainingDownloads };
    }),
  
  setDownloadProgress: (modelId, progress, status, speedBps) =>
    set((state) => ({
      downloads: {
        ...state.downloads,
        [modelId]: { progress, status, speedBps }
      }
    }))
}));