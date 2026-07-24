import React, { useEffect } from "react";
import {
  X,
  Cloud,
  Loader2,
  Crown,
  CreditCard,
  RefreshCw,
} from "lucide-react";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";
import type { CloudRoutingPreference } from "../types";
import "./CloudSettingsModal.css";

interface CloudSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const MODE_OPTIONS: Array<{
  value: CloudRoutingPreference;
  label: string;
  hint: string;
}> = [
  {
    value: "local",
    label: "Private Local",
    hint: "All inference stays on this device.",
  },
  {
    value: "cloud",
    label: "NELA Cloud",
    hint: "Use NELA Cloud quality tiers (Fast / Smart / Deep / Auto from the Intelligence selector).",
  },
  {
    value: "auto",
    label: "Auto (prefer cloud)",
    hint: "Prefer cloud when signed in and entitled; fall back to local.",
  },
];

function planLabel(plan: string | undefined): string {
  switch ((plan ?? "free").toLowerCase()) {
    case "starter":
      return "Starter";
    case "pro":
    case "premium":
      return "Pro";
    default:
      return "Free";
  }
}

const CloudSettingsModal: React.FC<CloudSettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const profile = useAuthStore((s) => s.profile);
  const preferredMode = useCloudStore((s) => s.preferredMode);
  const entitlement = useCloudStore((s) => s.entitlement);
  const loading = useCloudStore((s) => s.loading);
  const error = useCloudStore((s) => s.error);
  const setPreferredMode = useCloudStore((s) => s.setPreferredMode);
  const refreshEntitlement = useCloudStore((s) => s.refreshEntitlement);
  const openCheckout = useCloudStore((s) => s.openCheckout);
  const openBillingManage = useCloudStore((s) => s.openBillingManage);
  const clearError = useCloudStore((s) => s.clearError);

  useEffect(() => {
    if (!isOpen) return;
    clearError();
    if (profile) {
      void refreshEntitlement();
    }
  }, [isOpen, profile, refreshEntitlement, clearError]);

  if (!isOpen) return null;

  const plan = entitlement?.plan ?? profile?.plan ?? "free";
  const isPaid = plan === "starter" || plan === "pro";
  const quota = entitlement?.quota;

  return (
    <div className="cloud-settings-overlay" onClick={onClose}>
      <div
        className="cloud-settings-modal"
        onClick={(e) => e.stopPropagation()}
        data-tour="cloud-settings-modal"
      >
        <div className="cloud-settings-header">
          <div className="cloud-settings-title">
            <Cloud size={18} />
            <span>NELA Cloud</span>
          </div>
          <button
            type="button"
            className="cloud-settings-close"
            onClick={onClose}
            aria-label="Close cloud settings"
          >
            <X size={18} />
          </button>
        </div>

        <div className="cloud-settings-body">
          <section className="cloud-settings-section">
            <h3>Preferred mode</h3>
            <p className="cloud-settings-hint">
              Local mode always works offline. Cloud never routes through local
              model processes.
            </p>
            <div className="cloud-mode-list" role="radiogroup" aria-label="Cloud mode">
              {MODE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`cloud-mode-option ${
                    preferredMode === opt.value ? "is-selected" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="cloud-mode"
                    value={opt.value}
                    checked={preferredMode === opt.value}
                    onChange={() => setPreferredMode(opt.value)}
                  />
                  <div>
                    <strong>{opt.label}</strong>
                    <span>{opt.hint}</span>
                  </div>
                </label>
              ))}
            </div>
          </section>

          <section className="cloud-settings-section">
            <div className="cloud-settings-section-head">
              <h3>Plan &amp; quota</h3>
              {profile && (
                <button
                  type="button"
                  className="cloud-settings-refresh"
                  onClick={() => void refreshEntitlement()}
                  disabled={loading}
                  title="Refresh entitlement"
                >
                  <RefreshCw size={14} className={loading ? "cloud-spin" : ""} />
                </button>
              )}
            </div>

            {!profile ? (
              <p className="cloud-settings-hint">
                Sign in from Profile to manage your NELA Cloud plan.
              </p>
            ) : (
              <>
                <div
                  className={`cloud-plan-banner ${isPaid ? "is-paid" : "is-free"}`}
                >
                  <Crown size={16} />
                  <div>
                    <strong>{planLabel(plan)}</strong>
                    <span>
                      {entitlement
                        ? `Status: ${entitlement.status.replace(/_/g, " ")}`
                        : "Entitlement not loaded yet."}
                    </span>
                  </div>
                </div>

                {quota && (
                  <div className="cloud-quota">
                    <div className="cloud-quota-row">
                      <span>Included</span>
                      <strong>${quota.includedUsd.toFixed(2)}</strong>
                    </div>
                    <div className="cloud-quota-row">
                      <span>Used</span>
                      <strong>${quota.usedUsd.toFixed(2)}</strong>
                    </div>
                    <div className="cloud-quota-row">
                      <span>Remaining</span>
                      <strong>${quota.remainingUsd.toFixed(2)}</strong>
                    </div>
                    {entitlement?.fastFree && (
                      <div className="cloud-quota-row">
                        <span>Fast free today</span>
                        <strong>
                          {entitlement.fastFree.remaining}/{entitlement.fastFree.limit}
                        </strong>
                      </div>
                    )}
                    {typeof entitlement?.paidCloud === "boolean" && (
                      <div className="cloud-quota-row">
                        <span>Smart / Deep</span>
                        <strong>{entitlement.paidCloud ? "Unlocked" : "Upgrade required"}</strong>
                      </div>
                    )}
                  </div>
                )}

                <div className="cloud-billing-actions">
                  {plan !== "starter" && (
                    <button
                      type="button"
                      className="cloud-upgrade-btn"
                      disabled={loading}
                      onClick={() => void openCheckout("starter")}
                    >
                      {loading ? (
                        <Loader2 size={16} className="cloud-spin" />
                      ) : (
                        <Crown size={16} />
                      )}
                      Upgrade to Starter
                    </button>
                  )}
                  {plan !== "pro" && (
                    <button
                      type="button"
                      className="cloud-upgrade-btn cloud-upgrade-btn-pro"
                      disabled={loading}
                      onClick={() => void openCheckout("pro")}
                    >
                      {loading ? (
                        <Loader2 size={16} className="cloud-spin" />
                      ) : (
                        <Crown size={16} />
                      )}
                      Upgrade to Pro
                    </button>
                  )}
                  {isPaid && (
                    <button
                      type="button"
                      className="cloud-manage-btn"
                      disabled={loading}
                      onClick={() => void openBillingManage()}
                    >
                      <CreditCard size={16} />
                      Manage billing
                    </button>
                  )}
                </div>
              </>
            )}
          </section>

          {error && <p className="cloud-settings-error">{error}</p>}
        </div>
      </div>
    </div>
  );
};

export default CloudSettingsModal;
