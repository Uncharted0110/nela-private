import { useEffect } from "react";
import { X } from "lucide-react";
import {
  resolveImagePicker,
  useImagePickerStore,
} from "../stores/imagePickerStore";

/**
 * Thumbnail strip for picking a slide image after an edit request.
 * Renders only while the edit pipeline has published candidates.
 */
export default function ArtifactImagePicker() {
  const pending = useImagePickerStore((s) => s.pending);

  useEffect(() => {
    if (!pending || pending.status !== "picking") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolveImagePicker(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending?.requestId, pending?.status]);

  if (!pending || pending.status !== "picking" || pending.candidates.length === 0) {
    return null;
  }

  return (
    <div
      className="rounded-xl border border-neon/50 bg-void-900/95 shadow-lg backdrop-blur-md p-3"
      role="dialog"
      aria-label="Pick a slide image"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-[0.78rem] font-medium text-txt truncate">
            Pick an image for {pending.slideLabel}
          </div>
          {pending.query ? (
            <div className="text-[0.68rem] text-txt-muted truncate mt-0.5">
              “{pending.query}”
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="shrink-0 p-1 rounded-md text-txt-muted hover:text-txt hover:bg-white/5"
          aria-label="Cancel image pick"
          onClick={() => resolveImagePicker(null)}
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {pending.candidates.map((c, i) => (
          <button
            key={`${c.sourceUrl}-${i}`}
            type="button"
            className="shrink-0 w-[96px] h-[72px] rounded-lg overflow-hidden border border-glass-border hover:border-neon/80 focus:outline-none focus:border-neon transition-colors bg-void-800"
            title={c.caption}
            onClick={() => resolveImagePicker(c)}
          >
            <img
              src={c.dataUri}
              alt={c.caption || `Candidate ${i + 1}`}
              className="w-full h-full object-cover"
              draggable={false}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
