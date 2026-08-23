import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Paperclip, X } from "lucide-react";
import { Api } from "../api";
import { DOCUMENT_PICKER_EXTENSIONS } from "../app/ragUiActions";
import {
  resolveFollowUp,
  useFollowUpStore,
} from "../stores/followUpStore";
import { useSessionStore } from "../stores/sessionStore";
import "./FollowUpModal.css";

function fileBaseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

async function savePastedFile(file: File): Promise<string | null> {
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const b64 = btoa(binary);
    const session = useSessionStore.getState();
    const sid = session.activeSessionId;
    const active = sid
      ? session.sessions.find((s) => s.id === sid)
      : undefined;
    const basePath = active?.artifactPath || "";
    const dir = basePath
      ? basePath.replace(/[/\\][^/\\]+$/, "")
      : "";
    const safe = file.name.replace(/[^a-zA-Z0-9._\- ]+/g, "_").slice(0, 80);
    const dest = dir
      ? `${dir}/nela_paste_${Date.now()}_${safe}`
      : `nela_paste_${Date.now()}_${safe}`;
    // Prefer writing next to the open artifact; fall back to artifact copy dir via write.
    if (dir) {
      await Api.saveBinaryFile(dest, b64);
      return dest;
    }
    // Without an artifact path, write via a temporary sibling using write_artifact_copy's folder
    // by first creating an empty placeholder through saveBinaryFile on a relative path fails —
    // require dialog attach instead.
    return null;
  } catch (err) {
    console.warn("Failed to save pasted file:", err);
    return null;
  }
}

export default function FollowUpModal() {
  const pending = useFollowUpStore((s) => s.pending);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeformNote, setFreeformNote] = useState("");
  const [attachedPaths, setAttachedPaths] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLElement | null>(null);
  const requestId = pending?.requestId ?? null;
  const [initId, setInitId] = useState<string | null>(null);
  if (pending && requestId !== initId) {
    setInitId(requestId);
    const init: Record<string, string> = {};
    for (const q of pending.questions) init[q.id] = "";
    setAnswers(init);
    setFreeformNote("");
    setAttachedPaths([]);
    setPasteError(null);
  }

  useEffect(() => {
    if (!pending) return;
    queueMicrotask(() => firstInputRef.current?.focus());
  }, [pending, requestId]);

  const submit = useCallback(() => {
    if (!pending) return;
    resolveFollowUp({
      status: "answered",
      answers,
      attachedPaths,
      freeformNote: freeformNote.trim() || undefined,
    });
  }, [pending, answers, attachedPaths, freeformNote]);

  const cancel = useCallback(() => {
    resolveFollowUp({
      status: "cancelled",
      answers: {},
      attachedPaths: [],
    });
  }, []);

  const pickFiles = useCallback(async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"],
          },
          {
            name: "Documents",
            extensions: DOCUMENT_PICKER_EXTENSIONS,
          },
        ],
      });
      if (!selected) return;
      const files = Array.isArray(selected) ? selected : [selected];
      setAttachedPaths((prev) => {
        const merged = new Set(prev);
        for (const f of files) merged.add(f);
        return Array.from(merged);
      });
    } catch (err) {
      console.error("Follow-up file pick failed:", err);
      setPasteError("Couldn't attach those files.");
    }
  }, []);

  const ingestFiles = useCallback(async (files: FileList | File[]) => {
    setPasteError(null);
    const list = Array.from(files);
    const saved: string[] = [];
    for (const file of list) {
      const path = await savePastedFile(file);
      if (path) saved.push(path);
    }
    if (saved.length === 0 && list.length > 0) {
      setPasteError(
        "Couldn't save pasted files here — use Attach to pick them from disk."
      );
      return;
    }
    if (saved.length) {
      setAttachedPaths((prev) => Array.from(new Set([...prev, ...saved])));
    }
  }, []);

  if (!pending || pending.status !== "waiting") return null;

  return (
    <div
      className="follow-up-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        className={`follow-up-modal${dragOver ? " follow-up-modal--drag" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="follow-up-title"
        onDragOver={(e) => {
          if (!pending.allowAttachments) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (!pending.allowAttachments) return;
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) {
            void ingestFiles(e.dataTransfer.files);
          }
        }}
        onPaste={(e) => {
          if (!pending.allowAttachments) return;
          const items = e.clipboardData?.files;
          if (items && items.length > 0) {
            e.preventDefault();
            void ingestFiles(items);
          }
        }}
      >
        <div className="follow-up-modal__header">
          <h2 id="follow-up-title">{pending.reason}</h2>
          <button
            type="button"
            className="follow-up-modal__icon-btn"
            onClick={cancel}
            title="Cancel"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>

        <p className="follow-up-modal__hint">
          Answer only what you know — this helps finish the current edit without
          guessing.
        </p>

        <div className="follow-up-modal__body">
          {pending.questions.map((q, idx) => (
            <label key={q.id} className="follow-up-modal__field">
              <span>{q.prompt}</span>
              {q.input_type === "choice" && q.choices?.length ? (
                <select
                  value={answers[q.id] ?? ""}
                  onChange={(e) =>
                    setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                  }
                >
                  <option value="">Select…</option>
                  {q.choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : q.input_type === "textarea" ? (
                <textarea
                  ref={
                    idx === 0
                      ? (el) => {
                          firstInputRef.current = el;
                        }
                      : undefined
                  }
                  rows={3}
                  value={answers[q.id] ?? ""}
                  onChange={(e) =>
                    setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                  }
                  placeholder="Type your answer…"
                />
              ) : (
                <input
                  ref={
                    idx === 0
                      ? (el) => {
                          firstInputRef.current = el;
                        }
                      : undefined
                  }
                  type="text"
                  value={answers[q.id] ?? ""}
                  onChange={(e) =>
                    setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                  }
                  placeholder="Type your answer…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
              )}
            </label>
          ))}

          <label className="follow-up-modal__field">
            <span>More context (optional)</span>
            <textarea
              rows={2}
              value={freeformNote}
              onChange={(e) => setFreeformNote(e.target.value)}
              placeholder="Anything else that would help…"
            />
          </label>

          {pending.allowAttachments ? (
            <div className="follow-up-modal__attach">
              <button
                type="button"
                className="follow-up-modal__attach-btn"
                onClick={() => void pickFiles()}
              >
                <Paperclip size={14} />
                Attach files
              </button>
              <span className="follow-up-modal__attach-hint">
                or paste / drop files here
              </span>
              {attachedPaths.length > 0 ? (
                <ul className="follow-up-modal__chips">
                  {attachedPaths.map((p) => (
                    <li key={p}>
                      <span title={p}>{fileBaseName(p)}</span>
                      <button
                        type="button"
                        onClick={() =>
                          setAttachedPaths((prev) =>
                            prev.filter((x) => x !== p)
                          )
                        }
                        aria-label={`Remove ${fileBaseName(p)}`}
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {pasteError ? (
                <p className="follow-up-modal__error">{pasteError}</p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="follow-up-modal__footer">
          <button type="button" className="follow-up-modal__ghost" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="follow-up-modal__primary" onClick={submit}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
