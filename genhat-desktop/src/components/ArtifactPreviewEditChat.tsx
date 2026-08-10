import { useEffect, useRef, useState } from "react";
import { Pencil, SendHorizontal, X } from "lucide-react";

export type PreviewEditMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  kind?: "progress" | "done" | "error";
};

export interface ArtifactPreviewEditChatProps {
  open: boolean;
  busy: boolean;
  messages: PreviewEditMessage[];
  onClose: () => void;
  onSend: (text: string) => void;
}

export default function ArtifactPreviewEditChat({
  open,
  busy,
  messages,
  onClose,
  onSend,
}: ArtifactPreviewEditChatProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open, busy]);

  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onSend(text);
  };

  return (
    <div className="shrink-0 border-t border-glass-border bg-void-900 flex flex-col max-h-[42%] min-h-[180px]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-glass-border">
        <Pencil size={13} className="text-neon shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[0.75rem] font-medium text-txt">Edit this artifact</div>
          <div className="text-[0.65rem] text-txt-muted truncate">
            e.g. “Add a slide about Camp Nou before the last slide”
          </div>
        </div>
        <button
          type="button"
          className="p-1 rounded-md text-txt-muted hover:text-txt hover:bg-void-600"
          onClick={onClose}
          aria-label="Close edit chat"
        >
          <X size={14} />
        </button>
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0 ? (
          <p className="text-[0.72rem] text-txt-muted leading-relaxed">
            Describe the change. Slide add/remove usually applies instantly without waiting for a
            model.
          </p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`text-[0.75rem] leading-relaxed rounded-lg px-2.5 py-1.5 whitespace-pre-wrap break-words ${
                m.role === "user"
                  ? "bg-void-700 text-txt ml-6"
                  : m.kind === "error"
                    ? "bg-red-950/40 text-red-200 mr-4 border border-red-900/50"
                    : m.kind === "done"
                      ? "bg-void-800 text-txt mr-4 border border-neon/25"
                      : "bg-void-800 text-txt-muted mr-4"
              }`}
            >
              {m.content}
            </div>
          ))
        )}
        {busy ? (
          <div className="flex items-center gap-2 text-[0.7rem] text-txt-muted">
            <span className="w-3 h-3 border-2 border-neon border-t-transparent rounded-full animate-spin" />
            Applying edit…
          </div>
        ) : null}
      </div>

      <div className="shrink-0 p-2 border-t border-glass-border flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          disabled={busy}
          placeholder="Tell NELA what to change…"
          className="flex-1 min-w-0 resize-none rounded-lg border border-glass-border bg-void-800 px-2.5 py-1.5 text-[0.78rem] text-txt placeholder:text-txt-muted focus:outline-none focus:border-neon/50 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || !draft.trim()}
          className="shrink-0 p-2 rounded-lg bg-neon/15 text-neon hover:bg-neon/25 disabled:opacity-40 disabled:pointer-events-none"
          aria-label="Send edit"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
    </div>
  );
}
