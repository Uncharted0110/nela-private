import React from "react";
import { Crown, X, Sparkles } from "lucide-react";
import { useCloudStore } from "../stores/cloudStore";
import "./PremiumUpgradeModal.css";

const PremiumUpgradeModal: React.FC = () => {
  const open = useCloudStore((s) => s.upgradeModalOpen);
  const closeUpgradeModal = useCloudStore((s) => s.closeUpgradeModal);
  const openPricingPage = useCloudStore((s) => s.openPricingPage);
  const loading = useCloudStore((s) => s.loading);

  if (!open) return null;

  return (
    <div className="premium-upgrade-overlay" onClick={closeUpgradeModal}>
      <div
        className="premium-upgrade-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="premium-upgrade-title"
        data-tour="premium-upgrade-modal"
      >
        <div className="premium-upgrade-header">
          <div className="premium-upgrade-title" id="premium-upgrade-title">
            <Crown size={18} />
            <span>Upgrade to Premium</span>
          </div>
          <button
            type="button"
            className="premium-upgrade-close"
            onClick={closeUpgradeModal}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="premium-upgrade-body">
          <div className="premium-upgrade-hero">
            <Sparkles size={28} />
          </div>
          <p>
            Upgrade to Premium to use <strong>Smart</strong> and{" "}
            <strong>Deep</strong> in Cloud. Fast stays included on Free.
          </p>
          <p className="premium-upgrade-hint">
            Local Private mode keeps Fast, Smart, and Deep free on this device.
          </p>
        </div>
        <div className="premium-upgrade-actions">
          <button
            type="button"
            className="premium-upgrade-btn ghost"
            onClick={closeUpgradeModal}
          >
            Not now
          </button>
          <button
            type="button"
            className="premium-upgrade-btn primary"
            disabled={loading}
            onClick={() => void openPricingPage()}
          >
            <Crown size={15} />
            View pricing
          </button>
        </div>
      </div>
    </div>
  );
};

export default PremiumUpgradeModal;
