import { create } from "zustand";

interface GmailConnectPromptState {
  visible: boolean;
  show: () => void;
  hide: () => void;
}

export const useGmailConnectPromptStore = create<GmailConnectPromptState>((set) => ({
  visible: false,
  show: () => set({ visible: true }),
  hide: () => set({ visible: false }),
}));
