import { create } from "zustand";
import type { AppModalKind } from "../components/AppModal";
import type { ImportModelProfile } from "../types";

export let modalResolve: ((value: boolean) => void) | null = null;

export const setModalResolve = (resolve: ((value: boolean) => void) | null) => {
  modalResolve = resolve;
};

interface AppModalState {
  open: boolean;
  kind: AppModalKind;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  showCancel: boolean;
}

interface UIState {
  settingsOpen: boolean;
  toursOpen: boolean;
  suppressStartupModal: boolean;
  hfModalOpen: boolean;
  hfModalPreset: { folder: string; profile: "none" | ImportModelProfile };
  appModal: AppModalState;
  sidebarSection: "chats" | "audio" | "mindmaps" | "playground" | null;
  docPanelOpen: boolean;
  paramsDockOpen: boolean;
  modeSwitchNotice: string | null;
  pdfViewerData: { data: string; title: string } | null;
  pdfLoading: boolean;
  docViewerFile: { filePath: string; title: string } | null;
}

interface UIActions {
  setSettingsOpen: (open: boolean) => void;
  setToursOpen: (open: boolean) => void;
  setSuppressStartupModal: (suppress: boolean) => void;
  setHfModalOpen: (open: boolean) => void;
  setHfModalPreset: (preset: {
    folder: string;
    profile: "none" | ImportModelProfile;
  }) => void;
  setAppModal: (
    modal: AppModalState | ((prev: AppModalState) => AppModalState)
  ) => void;
  setSidebarSection: (
    section: "chats" | "audio" | "mindmaps" | "playground" | null
  ) => void;
  setDocPanelOpen: (open: boolean) => void;
  setParamsDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setModeSwitchNotice: (notice: string | null) => void;
  setPdfViewerData: (data: { data: string; title: string } | null) => void;
  setPdfLoading: (loading: boolean) => void;
  setDocViewerFile: (file: { filePath: string; title: string } | null) => void;
  showModal: (
    kind: AppModalKind,
    title: string,
    message: string,
    options?: {
      confirmLabel?: string;
      cancelLabel?: string;
      showCancel?: boolean;
    }
  ) => void;
  showError: (message: string, title?: string) => void;
  confirmAction: (
    title: string,
    message: string,
    confirmLabel?: string,
    cancelLabel?: string
  ) => Promise<boolean>;
  handleModalConfirm: () => void;
  handleModalCancel: () => void;
  closePdfViewer: () => void;
  closeDocViewer: () => void;
}

export const useUIStore = create<UIState & UIActions>((set, get) => ({
  settingsOpen: false,
  toursOpen: false,
  suppressStartupModal: false,
  hfModalOpen: false,
  hfModalPreset: { folder: "LLM", profile: "llm" },
  appModal: {
    open: false,
    kind: "info",
    title: "",
    message: "",
    confirmLabel: "OK",
    cancelLabel: "Cancel",
    showCancel: false,
  },
  sidebarSection: null,
  docPanelOpen: false,
  paramsDockOpen: false,
  modeSwitchNotice: null,
  pdfViewerData: null,
  pdfLoading: false,
  docViewerFile: null,

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setToursOpen: (toursOpen) => set({ toursOpen }),
  setSuppressStartupModal: (suppressStartupModal) =>
    set({ suppressStartupModal }),
  setHfModalOpen: (hfModalOpen) => set({ hfModalOpen }),
  setHfModalPreset: (hfModalPreset) => set({ hfModalPreset }),

  setAppModal: (modal) =>
    set((state) => ({
      appModal: typeof modal === "function" ? modal(state.appModal) : modal,
    })),

  setSidebarSection: (sidebarSection) => set({ sidebarSection }),
  setDocPanelOpen: (docPanelOpen) => set({ docPanelOpen }),
  setParamsDockOpen: (paramsDockOpen) =>
    set((state) => ({
      paramsDockOpen:
        typeof paramsDockOpen === "function"
          ? paramsDockOpen(state.paramsDockOpen)
          : paramsDockOpen,
    })),
  setModeSwitchNotice: (modeSwitchNotice) => set({ modeSwitchNotice }),
  setPdfViewerData: (pdfViewerData) => set({ pdfViewerData }),
  setPdfLoading: (pdfLoading) => set({ pdfLoading }),
  setDocViewerFile: (docViewerFile) => set({ docViewerFile }),

  showModal: (kind, title, message, options) => {
    set({
      appModal: {
        open: true,
        kind,
        title,
        message,
        confirmLabel: options?.confirmLabel ?? "OK",
        cancelLabel: options?.cancelLabel ?? "Cancel",
        showCancel: options?.showCancel ?? false,
      },
    });
  },

  showError: (message, title = "Error") => {
    get().showModal("error", title, message);
  },

  confirmAction: (title, message, confirmLabel = "OK", cancelLabel = "Cancel") =>
    new Promise<boolean>((resolve) => {
      modalResolve = resolve;
      get().showModal("confirm", title, message, {
        confirmLabel,
        cancelLabel,
        showCancel: true,
      });
    }),

  handleModalConfirm: () => {
    const resolver = modalResolve;
    modalResolve = null;
    if (resolver) resolver(true);
    set((state) => ({
      appModal: { ...state.appModal, open: false },
    }));
  },

  handleModalCancel: () => {
    const resolver = modalResolve;
    modalResolve = null;
    if (resolver) resolver(false);
    set((state) => ({
      appModal: { ...state.appModal, open: false },
    }));
  },

  closePdfViewer: () => set({ pdfViewerData: null }),
  closeDocViewer: () => set({ docViewerFile: null }),
}));
