import { useEffect, useRef, useState } from "react";
import { SendHorizontal, X } from "lucide-react";

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
  onClose,
  onSend,
}: ArtifactPreviewEditChatProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
    <div className="shrink-0 w-full rounded-lg border border-glass-border bg-void-900/95 backdrop-blur p-[2px]">
      {busy ? (
        <div className="flex items-center gap-2 mb-1 text-[0.7rem] text-txt-muted">
          <span className="w-3 h-3 border-2 border-neon border-t-transparent rounded-full animate-spin" />
          Applying edit…
        </div>
      ) : null}

      <div className="flex items-center gap-1">
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
          rows={1}
          disabled={busy}
          placeholder=""
          className="flex-1 min-w-0 resize-none rounded-lg border border-glass-border bg-void-800 px-2 py-0.5 text-[0.82rem] leading-tight text-txt placeholder:text-txt-muted focus:outline-none focus:border-neon/50 disabled:opacity-60"
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
        <button
          type="button"
          className="shrink-0 p-1 rounded-md text-txt-muted hover:text-txt hover:bg-void-600"
          onClick={onClose}
          aria-label="Close edit chat"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
