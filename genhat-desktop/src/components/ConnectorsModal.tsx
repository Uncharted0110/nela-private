import { X, Cloud } from "lucide-react";
import { useConnectorStore } from "../stores/connectorStore";
import ConnectorsPanel from "./ConnectorsPanel";
import "./ConnectorsPanel.css";

export default function ConnectorsModal() {
  const open = useConnectorStore((s) => s.modalOpen);
  const closeModal = useConnectorStore((s) => s.closeModal);

  if (!open) return null;

  return (
    <div className="conn-modal-overlay" role="presentation" onClick={closeModal}>
      <div
        className="conn-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conn-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="conn-modal-header">
          <Cloud size={20} />
          <div style={{ flex: 1 }}>
            <h2 id="conn-modal-title">Connectors</h2>
            <p>
              Link cloud apps and sync folders into Search my files. New
              connectors are registered in the desktop catalog — coming soon
              entries appear here automatically.
            </p>
          </div>
          <button
            type="button"
            className="conn-btn"
            aria-label="Close"
            onClick={closeModal}
            style={{ padding: "0.35rem" }}
          >
            <X size={16} />
          </button>
        </div>
        <ConnectorsPanel />
      </div>
    </div>
  );
}
