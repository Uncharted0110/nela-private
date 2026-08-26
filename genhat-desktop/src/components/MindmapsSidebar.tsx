import { useSessionStore } from "../stores/sessionStore";
import { useChatModeStore } from "../stores/chatModeStore";

interface MindmapListItem {
  id: string;
  sessionId: string;
  name: string;
  query: string;
  generatedFrom: "documents" | "model";
  createdAt: number;
}

export default function MindmapsSidebar() {
  // ── Store subscriptions ───────────────────────────────────────────────────
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const sessions = useSessionStore(s => s.sessions);
  const mindmapsBySession = useChatModeStore(s => s.mindmapsBySession);
  const activeMindmapOverlay = useChatModeStore(s => s.activeMindmapOverlay);
  const openMindmapOverlay = useChatModeStore(s => s.openMindmapOverlay);

  // ── Derived state ─────────────────────────────────────────────────────────
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeSessionMindmaps = activeSession ? (mindmapsBySession[activeSession.id] ?? []) : [];

  const mindmaps: MindmapListItem[] = activeSessionMindmaps
    .map((map) => ({
      id: map.id,
      sessionId: activeSession?.id ?? "",
      name: map.title,
      query: map.query,
      generatedFrom: map.generatedFrom,
      createdAt: map.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  return (
    <aside className="w-[280px] min-w-[280px] border-r border-glass-border bg-void-800 flex flex-col">
      <div className="h-10 px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 text-txt">
          <span className="text-2xl font-semibold mt-2">Mindmaps</span>
        </div>
      </div>

      <div className="flex-1 p-2 flex flex-col">
        <div className="flex-1 bg-void-900 border border-glass-border rounded-xl p-2 flex flex-col gap-1.5 shadow-md overflow-y-auto">
          {mindmaps.length === 0 ? (
            <div className="text-[0.9rem] text-txt-muted p-2">No mindmaps generated yet.</div>
          ) : (
            mindmaps.map((mm) => {
              const isOpen =
                activeMindmapOverlay?.mindmapId === mm.id &&
                activeMindmapOverlay?.sessionId === mm.sessionId;

              return (
                <button
                  key={mm.id}
                  className={`group relative w-full text-left rounded-xl border px-3 py-2.5 transition-all duration-150 ${
                    isOpen
                      ? "bg-neon-subtle border-neon/30 text-txt shadow-[0_0_14px_rgba(0,212,255,0.08)]"
                      : "bg-void-700/65 border-glass-border text-txt-secondary hover:border-neon/20 hover:text-txt"
                  }`}
                  onClick={() => openMindmapOverlay(mm.sessionId, mm.id)}
                  title={mm.name}
                >
                  <div className="flex flex-col min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.82rem] font-medium truncate">{mm.name}</span>
                      <span className="text-[0.68rem] text-txt-muted shrink-0">
                        {new Date(mm.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <p className="mt-1 text-[0.72rem] text-txt-muted leading-snug max-h-[2.4em] overflow-hidden">
                      {mm.query || "No query"}
                    </p>
                    <div className="mt-1.5 text-[0.68rem] text-txt-muted">
                      {mm.generatedFrom === "documents" ? "Document-grounded" : "Model knowledge"}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </aside>
  );
}
