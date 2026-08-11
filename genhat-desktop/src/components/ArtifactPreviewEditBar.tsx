import { useEffect, useRef } from "react";

export interface ArtifactPreviewEditBarProps {
  open: boolean;
  busy: boolean;
  draft: string;
  onDraftChange: (next: string) => void;
  onSubmit: (text: string) => void;
}

/**
 * Minimal "edit prompt" input that overlays the preview canvas.
 * (No previous chat history; slick input-only bar.)
 */
export default function ArtifactPreviewEditBar({
  open,
  busy,
  draft,
  onDraftChange,
  onSubmit,
}: ArtifactPreviewEditBarProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

  return (
    <div className="backdrop-blur h-11 flex items-center w-full">
      <div className="flex items-center gap-2 h-full w-full">
        {busy ? (
          <div className="flex items-center gap-2 text-[0.72rem] text-txt-muted">
            <span className="w-3 h-3 border-2 border-neon border-t-transparent rounded-full animate-spin" />
            Applying…
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          style={{ caretColor: "#081018" }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const text = draft.trim();
              if (!text || busy) return;
              onSubmit(text);
            }
          }}
          rows={1}
          disabled={busy}
          placeholder=""
          className="flex-1 min-w-0 resize-none rounded-full border-2 border-neon/70 bg-white/90 px-4 py-3 h-full text-[0.82rem] leading-tight text-[#081018] placeholder:text-[#3a4658] focus:outline-none focus:border-neon/90 disabled:opacity-60"
        />
      </div>
    </div>
  );
}

