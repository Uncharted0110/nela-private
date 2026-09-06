import React, { useEffect } from "react";
import { ShieldCheck, Cloud, SlidersHorizontal } from "lucide-react";
import { COPY } from "../app/copy";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";
import { useUIStore } from "../stores/uiStore";
import { useModelStore } from "../stores/modelStore";
import { writeSpecificModelPicker } from "../app/intelligenceModes";
import "./ModeBanner.css";

/**
 * Compact Private <-> Cloud toggle for the toolbar (replaces the old globe).
 * Controls cloudStore.preferredMode: local = Private, cloud = Cloud.
 */
const ModeBanner: React.FC = () => {
  const preferredMode = useCloudStore((s) => s.preferredMode);
  const setPreferredMode = useCloudStore((s) => s.setPreferredMode);
  const profile = useAuthStore((s) => s.profile);
  const authHydrated = useAuthStore((s) => s.hydrated);
  const setProfileOpen = useUIStore((s) => s.setProfileOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const setUseSpecificModelPicker = useModelStore((s) => s.setUseSpecificModelPicker);

  const isCloud = preferredMode !== "local";
  const needsSignIn = isCloud && authHydrated && !profile;

  const label = isCloud ? COPY.modeCloudLabel : COPY.modePrivateLabel;
  const tooltip = isCloud ? COPY.modeCloudTooltip : COPY.modePrivateTooltip;

  useEffect(() => {
    if (needsSignIn) {
      setProfileOpen(true);
    }
  }, [needsSignIn, setProfileOpen]);

  const toggle = () => {
    const nextCloud = !isCloud;
    // Leaving cloud always returns to fully-private local; "auto" stays settings-only.
    setPreferredMode(nextCloud ? "cloud" : "local");
    if (nextCloud) {
      // Cloud uses OpenRouter quality tiers — never the local specific-model picker.
      setUseSpecificModelPicker(false);
      writeSpecificModelPicker(false);
    }
  };

  return (
    <div
      className={`mode-toggle ${isCloud ? "mode-toggle--cloud" : "mode-toggle--private"}`}
      data-tour="privacy-indicator"
    >
      <button
        type="button"
        role="switch"
        aria-checked={isCloud}
        aria-label={COPY.modeToggleAria}
        title={tooltip}
        className="mode-toggle__switch"
        onClick={toggle}
      >
        <span className="mode-toggle__icon" aria-hidden="true">
          {isCloud ? <Cloud size={14} strokeWidth={2} /> : <ShieldCheck size={14} strokeWidth={2} />}
        </span>
        <span className="mode-toggle__label">{label}</span>
        <span className="mode-toggle__track">
          <span className="mode-toggle__thumb">
            {isCloud ? <Cloud size={10} strokeWidth={2.4} /> : <ShieldCheck size={10} strokeWidth={2.4} />}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="mode-toggle__settings"
        title="Settings"
        aria-label="Open settings"
        onClick={() => setSettingsOpen(true)}
      >
        <SlidersHorizontal size={14} strokeWidth={2} />
      </button>
    </div>
  );
};

export default ModeBanner;
