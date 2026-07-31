import { create } from "zustand";
import {
  getCloudEntitlement,
  createCloudCheckout,
  createBillingManage,
} from "../api";
import type { CloudRoutingPreference, EntitlementResponse } from "../types";
import { friendlyError } from "../app/friendlyError";
import { useChatModeStore } from "./chatModeStore";

const PREFERRED_MODE_KEY = "nela.cloud.preferredMode";
const ENTITLEMENT_CACHE_KEY = "nela.cloud.entitlementDisplay";

export function preferredModeEnablesWebSearch(
  mode: CloudRoutingPreference
): boolean {
  return mode !== "local";
}

function readPreferredMode(): CloudRoutingPreference {
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

function persistPreferredMode(mode: CloudRoutingPreference) {
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

function toFriendly(err: unknown): string {
  return friendlyError(err instanceof Error ? err.message : String(err));
}

export interface CloudStoreState {
  preferredMode: CloudRoutingPreference;
  entitlement: EntitlementResponse | null;
  loading: boolean;
  error: string | null;

  setPreferredMode: (mode: CloudRoutingPreference) => void;
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
    // Cloud / Auto: web search on by default. Private: off (user can re-enable in Tools).
    useChatModeStore
      .getState()
      .setWebEnabled(preferredModeEnablesWebSearch(mode));
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
        error: toFriendly(err),
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
      const message = toFriendly(err);
      set({
        loading: false,
        error: message,
      });
      throw new Error(message);
    }
  },

  openBillingManage: async () => {
    set({ loading: true, error: null });
    try {
      await createBillingManage();
      set({ loading: false });
    } catch (err) {
      const message = toFriendly(err);
      set({
        loading: false,
        error: message,
      });
      throw new Error(message);
    }
  },
}));
