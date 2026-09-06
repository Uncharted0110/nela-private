import { FolderSearch, Loader2, Search, Trash2, X } from "lucide-react";
import { openRagSourcePicker } from "../stores/ragSourcePickerStore";
import { useDocGraphStore } from "../stores/docGraphStore";
import { friendlyErrorFromUnknown } from "../app/friendlyError";
import ConnectorsPanel from "./ConnectorsPanel";
import "./DocGraphModals.css";

export default function DocGraphIndexModal() {
  const indexOpen = useDocGraphStore((s) => s.indexOpen);
  const closeIndex = useDocGraphStore((s) => s.closeIndex);
  const openQuery = useDocGraphStore((s) => s.openQuery);
  const indexing = useDocGraphStore((s) => s.indexing);
  const progress = useDocGraphStore((s) => s.progress);
  const lastReport = useDocGraphStore((s) => s.lastReport);
  const stats = useDocGraphStore((s) => s.stats);
  const pass2 = useDocGraphStore((s) => s.pass2);
  const lastRoot = useDocGraphStore((s) => s.lastRoot);
  const error = useDocGraphStore((s) => s.error);
  const startIndex = useDocGraphStore((s) => s.startIndex);
  const clearKb = useDocGraphStore((s) => s.clearKb);

  if (!indexOpen) return null;

  const pickAndIndex = async () => {
    try {
      const selection = await openRagSourcePicker({
        allowedExtensions: [],
        foldersOnly: true,
      });
      if (!selection || selection.folderPaths.length === 0) return;
      await startIndex(selection.folderPaths[0]);
    } catch (e) {
      console.warn(friendlyErrorFromUnknown(e));
    }
  };

  const onClear = async () => {
    if (!window.confirm("Clear the structural knowledge base?")) return;
    try {
      await clearKb();
    } catch (e) {
      console.warn(friendlyErrorFromUnknown(e));
    }
  };

  return (
    <div className="dg-overlay">
      <div className="dg-card" role="dialog" aria-modal="true" aria-labelledby="dg-index-title">
        <div className="dg-header">
          <FolderSearch size={22} />
          <div style={{ flex: 1 }}>
            <h2 id="dg-index-title">Structural knowledge graph</h2>
            <p>
              Indexes your folders with Pass 1 (fast) + Pass 2 (background retry). On restart, only
              new or changed files are synced. Search is available after Pass 1 commits.
            </p>
          </div>
          <button
            type="button"
            className="dg-btn ghost"
            aria-label="Close"
            disabled={indexing}
            onClick={() => closeIndex()}
            style={{ padding: "0.35rem" }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="dg-stats">
          <div className="dg-stat">
            <div className="dg-stat-label">Nodes</div>
            <div className="dg-stat-value">{stats?.nodes ?? 0}</div>
          </div>
          <div className="dg-stat">
            <div className="dg-stat-label">Edges</div>
            <div className="dg-stat-value">{stats?.edges ?? 0}</div>
          </div>
          <div className="dg-stat">
            <div className="dg-stat-label">Vectors</div>
            <div className="dg-stat-value">{stats?.vectors ?? 0}</div>
          </div>
        </div>

        {lastRoot && <div className="dg-path">Last root: {lastRoot}</div>}

        {progress && (
          <div className="dg-progress">
            <strong>[{progress.phase}]</strong> {progress.message}
            <div style={{ marginTop: "0.35rem" }}>
              discovered {progress.filesDiscovered} · parsed {progress.filesParsed} · failed{" "}
              {progress.filesFailed} · chunks {progress.chunksIndexed}
            </div>
          </div>
        )}

        {pass2.active || pass2.total > 0 ? (
          <div className="dg-progress">
            <strong>Pass 2</strong>
            {pass2.active ? " running" : " idle"} — recovered {pass2.completed}/{pass2.total}, failed{" "}
            {pass2.failed}, remaining {pass2.remaining}
          </div>
        ) : null}

        {lastReport && (
          <div className="dg-report">
            <strong>Pass 1 report</strong>
            <div style={{ marginTop: "0.35rem" }}>
              {lastReport.filesParsed} parsed · {lastReport.filesFailed} failed ·{" "}
              {lastReport.filesDeferred} deferred · {lastReport.chunksIndexed} chunks ·{" "}
              {lastReport.timing.totalMs} ms
            </div>
          </div>
        )}

        <div className="dg-actions">
          <button type="button" className="dg-btn primary" disabled={indexing} onClick={pickAndIndex}>
            {indexing ? <Loader2 size={16} className="dg-spin" /> : <FolderSearch size={16} />}
            {indexing ? "Indexing…" : "Index folder"}
          </button>
          <button
            type="button"
            className="dg-btn"
            disabled={indexing}
            onClick={() => {
              closeIndex();
              openQuery();
            }}
          >
            <Search size={16} />
            Open query
          </button>
          <button type="button" className="dg-btn danger" disabled={indexing} onClick={onClear}>
            <Trash2 size={16} />
            Clear KB
          </button>
        </div>

        {error && <div className="dg-error">{error}</div>}

        <ConnectorsPanel />
      </div>
    </div>
  );
}
