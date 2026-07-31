import { useCallback, useEffect, useRef, useState } from "react";
import { FolderSearch, Loader2, X } from "lucide-react";
import { Api } from "../api";
import { useFileIndexerStore } from "../stores/fileIndexerStore";
import "./FileIndexerChatModal.css";

type Hit = { path: string; score: number; fields: string[] };

type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string; hits?: Hit[] }
  | { id: string; role: "system"; text: string };

function fileName(path: string) {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export default function FileIndexerChatModal() {
  const open = useFileIndexerStore((s) => s.chatOpen);
  const minimized = useFileIndexerStore((s) => s.chatMinimized);
  const minimizeChat = useFileIndexerStore((s) => s.minimizeChat);
  const openChat = useFileIndexerStore((s) => s.openChat);
  const openSetup = useFileIndexerStore((s) => s.openSetup);
  const pendingQuery = useFileIndexerStore((s) => s.pendingQuery);
  const consumePendingQuery = useFileIndexerStore((s) => s.consumePendingQuery);
  const status = useFileIndexerStore((s) => s.status);

  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "system",
      text: "Search from the main chat bar with “Search my files” on. Results appear here.",
    },
  ]);
  const [lastHitCount, setLastHitCount] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);

  const ready = status.phase === "ready";
  const setupDone = status.setupDone;

  const runSearch = useCallback(
    async (q: string) => {
      const query = q.trim();
      if (!query || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text: query }]);
      try {
        if (!setupDone) {
          setMessages((prev) => [
            ...prev,
            {
              id: `s-${Date.now()}`,
              role: "system",
              text: "File indexing isn’t configured yet. Open folder setup first.",
            },
          ]);
          return;
        }
        if (!ready) {
          setMessages((prev) => [
            ...prev,
            {
              id: `s-${Date.now()}`,
              role: "system",
              text: `Indexer is still working (${status.phase}). Wait until the top-right icon shows indexed, then try again.`,
            },
          ]);
          return;
        }
        const hits = await Api.fileindexerSearch(query);
        const normalized = (hits ?? []).map((h) => ({
          path: h.path,
          score: h.score,
          fields: h.fields ?? [],
        }));
        setLastHitCount(normalized.length);
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text:
              normalized.length === 0
                ? "No matching files found."
                : `Found ${normalized.length} result${normalized.length === 1 ? "" : "s"}:`,
            hits: normalized,
          },
        ]);
      } catch (e) {
        setMessages((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "system",
            text: String(e),
          },
        ]);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [ready, setupDone, status.phase],
  );

  useEffect(() => {
    if (!open || minimized) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [open, minimized, messages, busy]);

  useEffect(() => {
    if (!open || !pendingQuery) return;
    const q = consumePendingQuery();
    if (q) void runSearch(q);
  }, [open, pendingQuery, consumePendingQuery, runSearch]);

  if (!open) return null;

  if (minimized) {
    return (
      <div className="fi-chat-overlay fi-chat-overlay--minimized">
        <button
          type="button"
          className="fi-chat-side-tab"
          onClick={() => openChat()}
          title="Expand file search results"
          aria-label="Expand file search results"
        >
          <FolderSearch size={16} />
          <span className="fi-chat-side-tab-label">File search</span>
          {lastHitCount > 0 && <span className="fi-chat-side-tab-count">{lastHitCount}</span>}
        </button>
      </div>
    );
  }

  return (
    <div className="fi-chat-overlay" aria-hidden={false}>
      <div
        className="fi-chat-panel"
        role="complementary"
        aria-labelledby="fi-chat-title"
      >
        <header className="fi-chat-header">
          <div className="fi-chat-title-row">
            <FolderSearch size={18} />
            <div>
              <h2 id="fi-chat-title">File search results</h2>
              <p>
                {ready
                  ? `${status.filesTotal.toLocaleString()} files indexed · query from chat`
                  : setupDone
                    ? `Status: ${status.phase}`
                    : "Not configured"}
              </p>
            </div>
          </div>
          <div className="fi-chat-header-actions">
            <button type="button" className="fi-chat-link" onClick={() => openSetup()}>
              Folders
            </button>
            <button
              type="button"
              className="fi-chat-icon"
              onClick={() => minimizeChat()}
              aria-label="Minimize file search"
              title="Minimize"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="fi-chat-messages">
          {messages.map((msg) => (
            <div key={msg.id} className={`fi-chat-bubble fi-chat-${msg.role}`}>
              <div className="fi-chat-text">{msg.text}</div>
              {msg.role === "assistant" && msg.hits && msg.hits.length > 0 && (
                <ul className="fi-chat-hits">
                  {msg.hits.map((hit) => (
                    <li key={hit.path}>
                      <div className="fi-chat-hit-name">{fileName(hit.path)}</div>
                      <div className="fi-chat-hit-path" title={hit.path}>
                        {hit.path}
                      </div>
                      <div className="fi-chat-hit-meta">
                        score {hit.score.toFixed(3)}
                        {hit.fields.length > 0 ? ` · ${hit.fields.join("+")}` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {busy && (
            <div className="fi-chat-bubble fi-chat-system">
              <Loader2 size={14} className="fi-spin" /> Searching…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
