import { Loader2, Search, X } from "lucide-react";
import { useDocGraphStore } from "../stores/docGraphStore";
import { friendlyErrorFromUnknown } from "../app/friendlyError";
import "./DocGraphModals.css";

export default function DocGraphQueryModal() {
  const queryOpen = useDocGraphStore((s) => s.queryOpen);
  const closeQuery = useDocGraphStore((s) => s.closeQuery);
  const queryText = useDocGraphStore((s) => s.queryText);
  const setQueryText = useDocGraphStore((s) => s.setQueryText);
  const queryResult = useDocGraphStore((s) => s.queryResult);
  const queryBusy = useDocGraphStore((s) => s.queryBusy);
  const error = useDocGraphStore((s) => s.error);
  const runQuery = useDocGraphStore((s) => s.runQuery);

  if (!queryOpen) return null;

  const onSubmit = async () => {
    try {
      await runQuery();
    } catch (e) {
      console.warn(friendlyErrorFromUnknown(e));
    }
  };

  return (
    <div className="dg-overlay">
      <div
        className="dg-card query"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dg-query-title"
      >
        <div className="dg-header">
          <Search size={22} />
          <div style={{ flex: 1 }}>
            <h2 id="dg-query-title">Knowledge graph query</h2>
            <p>
              Preview the exact Markdown context the LLM would receive (hybrid search + subgraph
              expansion). No model call is made here.
            </p>
          </div>
          <button
            type="button"
            className="dg-btn ghost"
            aria-label="Close"
            onClick={() => closeQuery()}
            style={{ padding: "0.35rem" }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="dg-query-row">
          <input
            className="dg-query-input"
            value={queryText}
            placeholder="e.g. revenue growth metrics"
            onChange={(e) => setQueryText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSubmit();
              }
            }}
          />
          <button type="button" className="dg-btn primary" disabled={queryBusy} onClick={onSubmit}>
            {queryBusy ? <Loader2 size={16} className="dg-spin" /> : <Search size={16} />}
            Query
          </button>
        </div>

        <div className="dg-preview-label">LLM context preview</div>
        <pre className="dg-preview">
          {queryResult?.trim()
            ? queryResult
            : "Run a query to see assembled Markdown sources here."}
        </pre>

        {error && <div className="dg-error">{error}</div>}
      </div>
    </div>
  );
}
