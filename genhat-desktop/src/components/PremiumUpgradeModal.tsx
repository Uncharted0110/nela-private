import React from "react";
import { Crown, X, Sparkles } from "lucide-react";
import { useCloudStore } from "../stores/cloudStore";
import "./PremiumUpgradeModal.css";

const PremiumUpgradeModal: React.FC = () => {
  const open = useCloudStore((s) => s.upgradeModalOpen);
  const reason = useCloudStore((s) => s.upgradeModalReason);
  const closeUpgradeModal = useCloudStore((s) => s.closeUpgradeModal);
  const openPricingPage = useCloudStore((s) => s.openPricingPage);
  const loading = useCloudStore((s) => s.loading);

  if (!open) return null;

  const isCredits = reason === "credits";

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
            <span>{isCredits ? "Buy credits" : "Upgrade to Premium"}</span>
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
          {isCredits ? (
            <>
              <p>
                Your credit balance is empty. Buy a pack or wait for your next
                monthly grant to keep using <strong>Smart</strong> and{" "}
                <strong>Deep</strong> in Cloud.
              </p>
              <p className="premium-upgrade-hint">
                Fast on the free lane still works within your rolling limit.
                Local Private mode stays free on this device.
              </p>
            </>
          ) : (
            <>
              <p>
                Upgrade to Premium or buy credits to use <strong>Smart</strong>{" "}
                and <strong>Deep</strong> in Cloud. Fast stays included on Free.
              </p>
              <p className="premium-upgrade-hint">
                Local Private mode keeps Fast, Smart, and Deep free on this device.
              </p>
            </>
          )}
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
            {isCredits ? "Buy credits" : "View pricing"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PremiumUpgradeModal;
