import { create } from "zustand";
import {
  getUserProfile,
  saveUserProfile,
  startGoogleOAuth,
  signOutUser,
  saveUploadedAvatar,
} from "../api";
import type { AvatarSource, UserProfile } from "../types";

interface AuthState {
  profile: UserProfile | null;
  loading: boolean;
  hydrated: boolean;
  error: string | null;
}

interface AuthActions {
  hydrate: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (fields: {
    name: string;
    email: string;
    avatar?: AvatarSource | null;
  }) => Promise<void>;
  setAvatar: (avatar: AvatarSource) => Promise<void>;
  uploadAvatar: (imageBase64: string, mime: string) => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState & AuthActions>((set, get) => ({
  profile: null,
  loading: false,
  hydrated: false,
  error: null,

  clearError: () => set({ error: null }),

  hydrate: async () => {
    try {
      const profile = await getUserProfile();
      set({ profile, hydrated: true, error: null });
    } catch (err) {
      set({
        profile: null,
        hydrated: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  signInWithGoogle: async () => {
    set({ loading: true, error: null });
    try {
      const profile = await startGoogleOAuth();
      set({ profile, loading: false, error: null });
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
      await signOutUser();
      set({ profile: null, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  updateProfile: async ({ name, email, avatar }) => {
    const current = get().profile;
    if (!current) throw new Error("Not signed in");
    set({ loading: true, error: null });
    try {
      const profile = await saveUserProfile({
        name,
        email,
        avatar: avatar === undefined ? current.avatar : avatar,
      });
      set({ profile, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  setAvatar: async (avatar) => {
    const current = get().profile;
    if (!current) throw new Error("Not signed in");
    await get().updateProfile({
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
      const profile = await saveUserProfile({
        name: current.name,
        email: current.email,
        avatar,
      });
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
