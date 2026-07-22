import { create } from "zustand";
import {
  getCloudEntitlement,
  createCloudCheckout,
  createBillingManage,
} from "../api";
import type { CloudMode, EntitlementResponse } from "../types";

const PREFERRED_MODE_KEY = "nela.cloud.preferredMode";
const ENTITLEMENT_CACHE_KEY = "nela.cloud.entitlementDisplay";

function readPreferredMode(): CloudMode {
  try {
    const raw = localStorage.getItem(PREFERRED_MODE_KEY);
    if (raw === "local" || raw === "cloud" || raw === "auto") return raw;
  } catch {
    /* ignore */
  }
  return "local";
}

function readCachedEntitlement(): EntitlementResponse | null {
  try {
    const raw = localStorage.getItem(ENTITLEMENT_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as EntitlementResponse;
  } catch {
    return null;
  }
}

function persistPreferredMode(mode: CloudMode) {
  try {
    localStorage.setItem(PREFERRED_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function persistEntitlementDisplay(entitlement: EntitlementResponse | null) {
  try {
    if (!entitlement) {
      localStorage.removeItem(ENTITLEMENT_CACHE_KEY);
      return;
    }
    // Persist non-sensitive display info only (no tokens).
    localStorage.setItem(ENTITLEMENT_CACHE_KEY, JSON.stringify(entitlement));
  } catch {
    /* ignore */
  }
}

export interface CloudStoreState {
  preferredMode: CloudMode;
  entitlement: EntitlementResponse | null;
  loading: boolean;
  error: string | null;

  setPreferredMode: (mode: CloudMode) => void;
  refreshEntitlement: () => Promise<void>;
  openCheckout: (plan: "starter" | "pro") => Promise<void>;
  openBillingManage: () => Promise<void>;
  clearError: () => void;
}

export const useCloudStore = create<CloudStoreState>((set) => ({
  preferredMode: readPreferredMode(),
  entitlement: readCachedEntitlement(),
  loading: false,
  error: null,

  clearError: () => set({ error: null }),

  setPreferredMode: (mode) => {
    persistPreferredMode(mode);
    set({ preferredMode: mode });
  },

  refreshEntitlement: async () => {
    set({ loading: true, error: null });
    try {
      const entitlement = await getCloudEntitlement();
      persistEntitlementDisplay(entitlement);
      set({ entitlement, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  openCheckout: async (plan) => {
    set({ loading: true, error: null });
    try {
      await createCloudCheckout(plan);
      set({ loading: false });
      // Entitlement updates after payment webhook — poll shortly after.
      setTimeout(() => {
        void useCloudStore.getState().refreshEntitlement();
      }, 2500);
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  openBillingManage: async () => {
    set({ loading: true, error: null });
    try {
      await createBillingManage();
      set({ loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
}));
