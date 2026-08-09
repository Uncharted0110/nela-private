import { Check, Loader2, Network, Search } from "lucide-react";
import { useDocGraphStore } from "../stores/docGraphStore";
import "./DocGraphModals.css";

export default function DocGraphStatusBadge() {
  const indexing = useDocGraphStore((s) => s.indexing);
  const pass2 = useDocGraphStore((s) => s.pass2);
  const stats = useDocGraphStore((s) => s.stats);
  const openIndex = useDocGraphStore((s) => s.openIndex);
  const openQuery = useDocGraphStore((s) => s.openQuery);
  const error = useDocGraphStore((s) => s.error);

  const working = indexing || pass2.active;
  const ready = !working && (stats?.nodes ?? 0) > 0;
  const tone = error ? "error" : working ? "working" : ready ? "ready" : "";

  const tooltip = error
    ? error
    : working
      ? indexing
        ? "Indexing structural graph…"
        : `Pass 2 retrying (${pass2.remaining} remaining)`
      : ready
        ? `${stats?.nodes ?? 0} graph nodes · click to manage`
        : "Structural knowledge graph · click to index";

  return (
    <div style={{ display: "inline-flex", gap: "0.35rem" }}>
      <button
        type="button"
        className={`dg-badge ${tone}`}
        title={tooltip}
        onClick={() => openIndex()}
        aria-label={tooltip}
      >
        {working ? (
          <Loader2 size={16} className="dg-spin" />
        ) : ready ? (
          <Check size={16} strokeWidth={2.4} />
        ) : (
          <Network size={16} strokeWidth={2.2} />
        )}
      </button>
      <button
        type="button"
        className="dg-badge"
        title="Query knowledge graph (LLM context preview)"
        onClick={() => openQuery()}
        aria-label="Query knowledge graph"
      >
        <Search size={16} strokeWidth={2.2} />
      </button>
    </div>
  );
}
