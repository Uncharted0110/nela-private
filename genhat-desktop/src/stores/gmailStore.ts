import { create } from "zustand";
import { Api } from "../api";
import type { GmailStatus } from "../types";
import { useGmailConnectPromptStore } from "./gmailConnectPromptStore";

interface GmailState {
  connected: boolean;
  email: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<GmailStatus>;
  connect: () => Promise<GmailStatus>;
  disconnect: () => Promise<void>;
}

function errMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return fallback;
}

function applyStatus(
  set: (partial: Partial<GmailState>) => void,
  status: GmailStatus
): GmailStatus {
  const connected = Boolean(status.connected);
  set({
    connected,
    email: status.email?.trim() || null,
    loading: false,
    error: null,
  });
  if (connected) useGmailConnectPromptStore.getState().hide();
  return status;
}

export const useGmailStore = create<GmailState>((set) => ({
  connected: false,
  email: null,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const status = await Api.gmailStatus();
      return applyStatus(set, status);
    } catch (err) {
      const message = errMessage(err, "Could not read Gmail status.");
      set({ loading: false, error: message });
      throw err;
    }
  },

  connect: async () => {
    set({ loading: true, error: null });
    try {
      const status = await Api.gmailOAuthStart();
      return applyStatus(set, status);
    } catch (err) {
      const message = errMessage(err, "Could not connect Gmail.");
      set({ loading: false, error: message });
      throw err;
    }
  },

  disconnect: async () => {
    set({ loading: true, error: null });
    try {
      await Api.gmailDisconnect();
      set({ connected: false, email: null, loading: false, error: null });
    } catch (err) {
      const message = errMessage(err, "Could not disconnect Gmail.");
      set({ loading: false, error: message });
      throw err;
    }
  },
}));
