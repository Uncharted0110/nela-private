import { create } from "zustand";
import {
  getCloudEntitlement,
  createCloudCheckout,
  createBillingManage,
  openCloudPricing,
  confirmCloudCheckout,
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

function refreshProfileSoft() {
  void import("./authStore").then(({ useAuthStore }) => {
    void useAuthStore.getState().refreshProfile();
  });
}

function scheduleEntitlementRefresh() {
  const delays = [2500, 6000, 12000, 20000];
  for (const ms of delays) {
    setTimeout(() => {
      void (async () => {
        const store = useCloudStore.getState();
        if (!store.entitlement?.paidCloud) {
          await store.confirmCheckout();
        }
        await store.refreshEntitlement();
        refreshProfileSoft();
      })();
    }, ms);
  }
}

export interface CloudStoreState {
  preferredMode: CloudRoutingPreference;
  entitlement: EntitlementResponse | null;
  loading: boolean;
  error: string | null;
  upgradeModalOpen: boolean;

  setPreferredMode: (mode: CloudRoutingPreference) => void;
  refreshEntitlement: () => Promise<void>;
  openCheckout: (plan: "starter" | "pro") => Promise<void>;
  openBillingManage: () => Promise<void>;
  openPricingPage: () => Promise<void>;
  openUpgradeModal: () => void;
  closeUpgradeModal: () => void;
  confirmCheckout: () => Promise<boolean>;
  clearError: () => void;
}

export const useCloudStore = create<CloudStoreState>((set) => ({
  // Never hydrate Premium/unlock from a previous account's localStorage cache.
  preferredMode: readPreferredMode(),
  entitlement: null,
  loading: false,
  error: null,
  upgradeModalOpen: false,

  clearError: () => set({ error: null }),

  openUpgradeModal: () => set({ upgradeModalOpen: true }),
  closeUpgradeModal: () => set({ upgradeModalOpen: false }),

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
      if (entitlement.paidCloud || entitlement.isPremium) {
        refreshProfileSoft();
      }
    } catch (err) {
      // On failure, do not keep a stale paid entitlement around.
      persistEntitlementDisplay(null);
      set({
        entitlement: null,
        loading: false,
        error: toFriendly(err),
      });
    }
  },

  confirmCheckout: async () => {
    set({ loading: true, error: null });
    try {
      const result = await confirmCloudCheckout();
      const entitlement = await getCloudEntitlement();
      persistEntitlementDisplay(entitlement);
      set({ entitlement, loading: false });
      refreshProfileSoft();
      return Boolean(result.paidCloud || result.isPremium || result.activated);
    } catch (err) {
      set({ loading: false });
      console.warn("confirmCheckout:", toFriendly(err));
      return false;
    }
  },

  openCheckout: async (plan) => {
    set({ loading: true, error: null });
    try {
      await createCloudCheckout(plan);
      set({ loading: false, upgradeModalOpen: false });
      scheduleEntitlementRefresh();
    } catch (err) {
      const message = toFriendly(err);
      set({
        loading: false,
        error: message,
      });
      throw new Error(message);
    }
  },

  openPricingPage: async () => {
    set({ loading: true, error: null });
    try {
      await openCloudPricing();
      set({ loading: false, upgradeModalOpen: false });
      scheduleEntitlementRefresh();
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
