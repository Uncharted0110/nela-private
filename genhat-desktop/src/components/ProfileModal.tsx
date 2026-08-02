import React, { useEffect, useRef, useState } from "react";
import {
  X,
  User,
  LogOut,
  Camera,
  Loader2,
  Crown,
  Save,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";
import { PRESET_AVATARS } from "../assets/avatars";
import type { AvatarSource } from "../types";
import "./ProfileModal.css";

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function resolveAvatarUrl(avatar: AvatarSource | null | undefined): string | null {
  if (!avatar) return null;
  // google: https URL; preset/upload: data URL (or legacy file path for upload)
  if (avatar.kind === "upload" && !avatar.value.startsWith("data:") && !avatar.value.startsWith("http")) {
    try {
      return convertFileSrc(avatar.value);
    } catch {
      return null;
    }
  }
  return avatar.value;
}

const ProfileModal: React.FC<ProfileModalProps> = ({ isOpen, onClose }) => {
  const profile = useAuthStore((s) => s.profile);
  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);
  const signInToCloud = useAuthStore((s) => s.signInToCloud);
  const signInWithEmail = useAuthStore((s) => s.signInWithEmail);
  const registerWithEmail = useAuthStore((s) => s.registerWithEmail);
  const signOut = useAuthStore((s) => s.signOut);
  const updateProfile = useAuthStore((s) => s.updateCachedProfile);
  const setAvatar = useAuthStore((s) => s.setAvatar);
  const uploadAvatar = useAuthStore((s) => s.uploadAvatar);
  const clearError = useAuthStore((s) => s.clearError);
  const loginPending = useAuthStore((s) => s.loginPending);
  const pendingUserCode = useAuthStore((s) => s.pendingUserCode);
  const refreshProfile = useAuthStore((s) => s.refreshProfile);
  const refreshEntitlement = useCloudStore((s) => s.refreshEntitlement);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pendingCodeChars = (pendingUserCode ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8)
    .split("");

  useEffect(() => {
    if (!isOpen || !profile) return;
    setName(profile.name);
    setEmail(profile.email);
    setShowAvatarPicker(false);
    setSaveNotice(null);
    clearError();
  }, [isOpen, profile, clearError]);

  useEffect(() => {
    if (!isOpen || !profile) return;
    void refreshEntitlement();
    void refreshProfile();
    // Refresh once when the modal opens (not on every profile mutation).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-only
  }, [isOpen]);

  if (!isOpen) return null;

  const avatarUrl = resolveAvatarUrl(profile?.avatar ?? null);
  const isPremium =
    profile?.isPremium === true ||
    profile?.displayPlan === "premium" ||
    profile?.plan === "starter" ||
    profile?.plan === "pro";
  const planTitle = isPremium ? "Premium" : "Free";

  const handleSignIn = async () => {
    clearError();
    try {
      await signInToCloud();
    } catch {
      // error stored in authStore
    }
  };

  const handleEmailAuth = async () => {
    clearError();
    try {
      if (authMode === "register") {
        await registerWithEmail({
          email: authEmail,
          password: authPassword,
          name: authName || undefined,
        });
      } else {
        await signInWithEmail({
          email: authEmail,
          password: authPassword,
        });
      }
    } catch {
      // error stored in authStore
    }
  };

  const handleSave = async () => {
    if (!profile) return;
    clearError();
    try {
      await updateProfile({ name, email });
      setSaveNotice("Profile saved");
      setTimeout(() => setSaveNotice(null), 2000);
    } catch {
      // error stored in authStore
    }
  };

  const handleSignOut = async () => {
    clearError();
    try {
      await signOut();
    } catch {
      // error stored in authStore
    }
  };

  const handlePresetSelect = async (dataUrl: string) => {
    clearError();
    try {
      await setAvatar({ kind: "preset", value: dataUrl });
      setShowAvatarPicker(false);
    } catch {
      // error stored in authStore
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      useAuthStore.setState({ error: "Please choose an image file." });
      return;
    }
    clearError();
    const reader = new FileReader();
    reader.onload = async () => {
      const result = String(reader.result ?? "");
      try {
        await uploadAvatar(result, file.type);
        setShowAvatarPicker(false);
      } catch {
        // error stored in authStore
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="profile-modal-overlay" onClick={onClose}>
      <div
        className="profile-modal"
        onClick={(e) => e.stopPropagation()}
        data-tour="profile-modal"
      >
        <div className="profile-modal-header">
          <div className="profile-title">
            <User size={18} />
            <span>Profile</span>
          </div>
          <button
            type="button"
            className="profile-close"
            onClick={onClose}
            aria-label="Close profile"
          >
            <X size={18} />
          </button>
        </div>

        <div className="profile-modal-body">
          {!profile ? (
            <div className="profile-signed-out">
              <div className="profile-avatar-placeholder">
                <User size={40} />
              </div>
              <h2>Sign in to NELA Cloud</h2>
              <p>
                Sign in to NELA Cloud to sync your profile, manage your plan, and
                use Fast Cloud.
              </p>
              <button
                type="button"
                className="profile-google-btn"
                onClick={() => void handleSignIn()}
                disabled={loading || loginPending}
              >
                {loading || loginPending ? (
                  <Loader2 size={18} className="profile-spin" />
                ) : (
                  <GoogleGlyph />
                )}
                {loginPending ? "Waiting for browser…" : "Link desktop with code"}
              </button>
              {loginPending && pendingCodeChars.length === 8 ? (
                <div className="profile-device-code">
                  <p className="profile-hint">
                    Already signed in on the website? Enter this code there:
                  </p>
                  <div className="profile-code-boxes" aria-label="Device link code">
                    {pendingCodeChars.map((char, index) => (
                      <span key={`${char}-${index}`} className="profile-code-box">
                        {char}
                      </span>
                    ))}
                  </div>
                  <p className="profile-hint">
                    Opened your browser to the link-device page. Keep this window
                    open until linking finishes.
                  </p>
                </div>
              ) : null}

              <div className="profile-auth-divider">or sign in here</div>

              <div className="profile-auth-tabs">
                <button
                  type="button"
                  className={authMode === "login" ? "is-active" : ""}
                  onClick={() => setAuthMode("login")}
                  disabled={loading || loginPending}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  className={authMode === "register" ? "is-active" : ""}
                  onClick={() => setAuthMode("register")}
                  disabled={loading || loginPending}
                >
                  Create account
                </button>
              </div>

              {authMode === "register" ? (
                <label className="profile-field">
                  <span>Name</span>
                  <input
                    type="text"
                    value={authName}
                    onChange={(e) => setAuthName(e.target.value)}
                    disabled={loading || loginPending}
                    autoComplete="name"
                  />
                </label>
              ) : null}
              <label className="profile-field">
                <span>Email</span>
                <input
                  type="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  disabled={loading || loginPending}
                  autoComplete="email"
                />
              </label>
              <label className="profile-field">
                <span>Password</span>
                <input
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  disabled={loading || loginPending}
                  autoComplete={
                    authMode === "register" ? "new-password" : "current-password"
                  }
                  minLength={8}
                />
              </label>
              <button
                type="button"
                className="profile-save-btn"
                onClick={() => void handleEmailAuth()}
                disabled={
                  loading ||
                  loginPending ||
                  !authEmail.trim() ||
                  authPassword.length < 8
                }
              >
                {loading ? (
                  <Loader2 size={16} className="profile-spin" />
                ) : null}
                {authMode === "register"
                  ? "Create account"
                  : "Sign in with email"}
              </button>

              {error && <p className="profile-error">{error}</p>}
            </div>
          ) : (
            <>
              <div
                className={`profile-plan-banner ${isPremium ? "is-premium" : "is-free"}`}
              >
                <Crown size={16} />
                <div>
                  <strong>{planTitle}</strong>
                  <span>
                    {isPremium
                      ? "Smart and Deep are unlocked in Cloud."
                      : "Upgrade from Cloud settings when you are ready."}
                  </span>
                </div>
              </div>

              <div className="profile-avatar-section">
                <button
                  type="button"
                  className="profile-avatar-btn"
                  onClick={() => setShowAvatarPicker((v) => !v)}
                  title="Change profile photo"
                  disabled={loading}
                >
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="" className="profile-avatar-img" />
                  ) : (
                    <User size={36} />
                  )}
                  <span className="profile-avatar-edit">
                    <Camera size={14} />
                  </span>
                </button>
                <div className="profile-avatar-meta">
                  <div className="profile-display-name">{profile.name}</div>
                  <div className="profile-display-email">{profile.email}</div>
                </div>
              </div>

              {showAvatarPicker && (
                <div className="profile-avatar-picker">
                  <div className="profile-avatar-picker-header">
                    Choose an avatar
                  </div>
                  <div className="profile-preset-grid">
                    {PRESET_AVATARS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className="profile-preset-btn"
                        title={preset.label}
                        onClick={() => void handlePresetSelect(preset.dataUrl)}
                        disabled={loading}
                      >
                        <img src={preset.dataUrl} alt={preset.label} />
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="profile-upload-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={loading}
                  >
                    <Camera size={16} />
                    Upload photo
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    hidden
                    onChange={(e) => void handleFileChange(e)}
                  />
                </div>
              )}

              <label className="profile-field">
                <span>Name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={loading}
                  autoComplete="name"
                />
              </label>

              <label className="profile-field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  autoComplete="email"
                />
              </label>

              {error && <p className="profile-error">{error}</p>}
              {saveNotice && <p className="profile-success">{saveNotice}</p>}

              <div className="profile-actions">
                <button
                  type="button"
                  className="profile-save-btn"
                  onClick={() => void handleSave()}
                  disabled={
                    loading ||
                    !name.trim() ||
                    !email.trim() ||
                    (name === profile.name && email === profile.email)
                  }
                >
                  {loading ? (
                    <Loader2 size={16} className="profile-spin" />
                  ) : (
                    <Save size={16} />
                  )}
                  Save
                </button>
                <button
                  type="button"
                  className="profile-signout-btn"
                  onClick={() => void handleSignOut()}
                  disabled={loading}
                >
                  <LogOut size={16} />
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.5-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 16.1 19 13 24 13c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.3 35.3 26.8 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.1 5.6l.1.1 6.2 5.2C39.2 37.3 44 32 44 24c0-1.3-.1-2.5-.4-3.5z"
      />
    </svg>
  );
}

export default ProfileModal;
