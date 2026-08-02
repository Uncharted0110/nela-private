import { Check, Loader2, X } from "lucide-react";
import { useFileIndexerStore } from "../stores/fileIndexerStore";
import "./FileIndexerStatusBadge.css";

export default function FileIndexerStatusBadge() {
  const status = useFileIndexerStore((s) => s.status);
  const openSetup = useFileIndexerStore((s) => s.openSetup);

  const phase = status.phase || "idle";
  const ready = phase === "ready" || phase === "sleeping";
  const error = phase === "error";
  const working = ["starting", "loading_model", "scanning", "embedding", "configured"].includes(
    phase,
  );

  let tooltip = status.message || "File indexer";
  if (phase === "sleeping") {
    tooltip =
      status.filesTotal > 0
        ? `${status.filesTotal.toLocaleString()} files indexed (model sleeping)`
        : "File indexer idle (model sleeping)";
  } else if (ready) {
    tooltip = `${status.filesTotal.toLocaleString()} files indexed`;
  } else if (phase === "embedding") {
    if (status.embedTotal > 0) {
      tooltip = `Indexing ${status.embedDone.toLocaleString()} / ${status.embedTotal.toLocaleString()} files`;
    } else if (status.filesTotal > 0) {
      tooltip = `Indexing ${status.filesEmbedded.toLocaleString()} / ${status.filesTotal.toLocaleString()} files`;
    } else {
      tooltip = "Indexing files…";
    }
  } else if (phase === "scanning") {
    tooltip =
      status.filesTotal > 0
        ? `Scanning… ${status.filesTotal.toLocaleString()} files found`
        : "Scanning files…";
  } else if (working) {
    tooltip = status.message || "Preparing file index…";
  } else if (error) {
    tooltip = status.message || "File indexing error";
  } else if (!status.setupDone) {
    tooltip = "File indexing not configured";
  }

  tooltip = `${tooltip} · Click to configure folders`;

  return (
    <button
      type="button"
      className={`fi-badge ${ready ? "ready" : error ? "error" : working ? "working" : "idle"}`}
      title={tooltip}
      onClick={() => openSetup()}
      aria-label={tooltip}
    >
      {ready ? (
        <Check size={16} strokeWidth={2.4} />
      ) : error ? (
        <X size={16} strokeWidth={2.4} />
      ) : working ? (
        <Loader2 size={16} className="fi-spin" />
      ) : (
        <span className="fi-dot" aria-hidden />
      )}
    </button>
  );
}
