import type { PreviewEditMessage } from "./ArtifactPreviewEditChat";

export interface ArtifactPreviewEditLogProps {
  messages: PreviewEditMessage[];
  busy: boolean;
  onClear?: () => void;
}

/**
 * Compact status log for preview edits (progress / done / error).
 */
export default function ArtifactPreviewEditLog({
  messages,
  busy,
  onClear,
}: ArtifactPreviewEditLogProps) {
  if (!messages.length && !busy) return null;

  const recent = messages.slice(-6);

  return (
    <div className="rounded-lg border border-glass-border bg-void-900/95 backdrop-blur shadow-lg max-h-40 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-glass-border">
        <div className="text-[0.68rem] font-medium text-txt-muted uppercase tracking-wide">
          Edit log
        </div>
        {onClear && messages.length ? (
          <button
            type="button"
            className="text-[0.65rem] text-txt-muted hover:text-txt"
            onClick={onClear}
          >
            Clear
          </button>
        ) : null}
      </div>
      <div className="overflow-y-auto px-2.5 py-1.5 space-y-1">
        {recent.map((m) => {
          const tone =
            m.role === "user"
              ? "text-txt"
              : m.kind === "error"
                ? "text-red-300"
                : m.kind === "done"
                  ? "text-neon"
                  : "text-txt-muted";
          const prefix =
            m.role === "user"
              ? "You"
              : m.kind === "error"
                ? "Error"
                : m.kind === "done"
                  ? "Done"
                  : "Status";
          return (
            <div
              key={m.id}
              className={`text-[0.72rem] leading-snug whitespace-pre-wrap break-words ${tone}`}
            >
              <span className="opacity-70 mr-1">{prefix}:</span>
              {m.content}
            </div>
          );
        })}
        {busy ? (
          <div className="flex items-center gap-2 text-[0.7rem] text-txt-muted">
            <span className="w-3 h-3 border-2 border-neon border-t-transparent rounded-full animate-spin" />
            Running…
          </div>
        ) : null}
      </div>
    </div>
  );
}
