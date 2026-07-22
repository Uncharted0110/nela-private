import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getUserProfile,
  getCloudProfile,
  saveUserProfile,
  startCloudAuth,
  pollCloudAuth,
  emailLoginCloud,
  emailRegisterCloud,
  signOutCloud,
  saveUploadedAvatar,
} from "../api";
import type { AvatarSource, UserProfile } from "../types";
import { useCloudStore } from "./cloudStore";

interface AuthState {
  profile: UserProfile | null;
  loading: boolean;
  hydrated: boolean;
  error: string | null;
  loginPending: boolean;
  pendingUserCode: string | null;
}

interface AuthActions {
  hydrate: () => Promise<void>;
  signInToCloud: () => Promise<void>;
  signInWithEmail: (input: {
    email: string;
    password: string;
  }) => Promise<void>;
  registerWithEmail: (input: {
    email: string;
    password: string;
    name?: string;
  }) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateCachedProfile: (fields: {
    name: string;
    email: string;
    avatar?: AvatarSource | null;
  }) => Promise<void>;
  /** @deprecated Prefer updateCachedProfile */
  updateProfile: (fields: {
    name: string;
    email: string;
    avatar?: AvatarSource | null;
  }) => Promise<void>;
  setAvatar: (avatar: AvatarSource) => Promise<void>;
  uploadAvatar: (imageBase64: string, mime: string) => Promise<void>;
  clearError: () => void;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePlan(plan: string | undefined): UserProfile["plan"] {
  const p = (plan ?? "free").toLowerCase();
  if (p === "premium" || p === "pro") return "pro";
  if (p === "starter") return "starter";
  return "free";
}

function normalizeProfile(profile: UserProfile | null): UserProfile | null {
  if (!profile) return null;
  return {
    ...profile,
    plan: normalizePlan(profile.plan),
  };
}

export const useAuthStore = create<AuthState & AuthActions>((set, get) => ({
  profile: null,
  loading: false,
  hydrated: false,
  error: null,
  loginPending: false,
  pendingUserCode: null,

  clearError: () => set({ error: null }),

  hydrate: async () => {
    try {
      const profile = normalizeProfile(await getUserProfile());
      set({ profile, hydrated: true, error: null });
      if (profile) {
        void useCloudStore.getState().refreshEntitlement().catch(() => {
          /* offline / unsigned cloud is fine */
        });
      }
    } catch (err) {
      set({
        profile: null,
        hydrated: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  refreshProfile: async () => {
    try {
      const profile = normalizeProfile(await getCloudProfile());
      set({ profile, error: null });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  signInToCloud: async () => {
    set({ loading: true, loginPending: true, error: null, pendingUserCode: null });
    try {
      const start = await startCloudAuth();
      set({ pendingUserCode: start.userCode });
      try {
        await openUrl(start.verificationUrl);
      } catch (err) {
        throw new Error(
          err instanceof Error
            ? `Failed to open browser: ${err.message}`
            : "Failed to open browser for NELA Cloud sign-in"
        );
      }

      const intervalMs = Math.max(1, start.interval || 2) * 1000;
      const deadline = Date.now() + Math.max(30, start.expiresIn || 300) * 1000;

      while (Date.now() < deadline) {
        await sleep(intervalMs);
        const poll = await pollCloudAuth(start.deviceCode);
        if (poll.status === "approved") {
          const profile = normalizeProfile(poll.profile);
          set({
            profile,
            loading: false,
            loginPending: false,
            pendingUserCode: null,
            error: null,
          });
          await useCloudStore.getState().refreshEntitlement();
          return;
        }
      }

      throw new Error("NELA Cloud sign-in timed out. Please try again.");
    } catch (err) {
      set({
        loading: false,
        loginPending: false,
        pendingUserCode: null,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  signInWithEmail: async ({ email, password }) => {
    set({ loading: true, loginPending: false, error: null });
    try {
      const profile = normalizeProfile(
        await emailLoginCloud({ email, password })
      );
      set({ profile, loading: false, error: null });
      await useCloudStore.getState().refreshEntitlement();
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  registerWithEmail: async ({ email, password, name }) => {
    set({ loading: true, loginPending: false, error: null });
    try {
      const profile = normalizeProfile(
        await emailRegisterCloud({ email, password, name })
      );
      set({ profile, loading: false, error: null });
      await useCloudStore.getState().refreshEntitlement();
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  signOut: async () => {
    set({ loading: true, error: null });
    try {
      await signOutCloud();
      useCloudStore.setState({ entitlement: null, error: null });
      set({ profile: null, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  updateCachedProfile: async ({ name, email, avatar }) => {
    const current = get().profile;
    if (!current) throw new Error("Not signed in");
    set({ loading: true, error: null });
    try {
      const profile = normalizeProfile(
        await saveUserProfile({
          name,
          email,
          avatar: avatar === undefined ? current.avatar : avatar,
        })
      );
      set({ profile, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  updateProfile: async (fields) => get().updateCachedProfile(fields),

  setAvatar: async (avatar) => {
    const current = get().profile;
    if (!current) throw new Error("Not signed in");
    await get().updateCachedProfile({
      name: current.name,
      email: current.email,
      avatar,
    });
  },

  uploadAvatar: async (imageBase64, mime) => {
    const current = get().profile;
    if (!current) throw new Error("Not signed in");
    set({ loading: true, error: null });
    try {
      const avatar = await saveUploadedAvatar({ imageBase64, mime });
      const profile = normalizeProfile(
        await saveUserProfile({
          name: current.name,
          email: current.email,
          avatar,
        })
      );
      set({ profile, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
}));
