import { useEffect, useRef, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import ProgressSlate, { type PipelineStageKind } from "./ProgressSlate";
import DiffPatchOverlay from "./DiffPatchOverlay";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ArtifactSandboxProps {
  /** Whether the artifact pane is visible. */
  visible: boolean;
  /** Called when the user closes the artifact pane. */
  onClose?: () => void;
  /** Initial artifact file path (absolute path on disk). */
  initialPath?: string;
}

interface PipelineStageEvent {
  stage: PipelineStageKind;
  /** Present when stage === "LivePreview". */
  path?: string;
  /** Present when stage === "IntentLocked". */
  intent?: string;
  /** Present when stage === "Error". */
  message?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ArtifactSandbox
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split-pane streaming canvas for artifact display.
 *
 * Renders the artifact in a sandboxed iframe with strict CSP so no outbound
 * network requests can escape. Listens to `pipeline-stage` events from the
 * Rust backend to drive the ProgressSlate state machine.
 *
 * Layout: the parent is expected to constrain this component to the right 65%
 * of the viewport (the chat pane occupies the remaining 35%).
 */
export default function ArtifactSandbox({
  visible,
  onClose,
  initialPath,
}: ArtifactSandboxProps) {
  const [stage, setStage] = useState<PipelineStageKind>("IntentLocked");
  const [artifactPath, setArtifactPath] = useState<string | null>(
    initialPath ?? null
  );
  const [artifactSrc, setArtifactSrc] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activePatch, setActivePatch] = useState<string | null>(null);
  const [patchActive, setPatchActive] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // ── Diff-patch hot reload ─────────────────────────────────────────────────
  const _applyPatch = useCallback((patch: string) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument || !patch) return;

    const doc = iframe.contentDocument;

    // Inject stylesheet if not present
    if (!doc.getElementById("nela-patch-style")) {
      const style = doc.createElement("style");
      style.id = "nela-patch-style";
      style.textContent = `
        @keyframes nela-pulse-highlight {
          0% { background-color: rgba(99, 102, 241, 0.4); border-radius: 4px; }
          100% { background-color: transparent; }
        }
        .nela-diff-highlight {
          animation: nela-pulse-highlight 3.0s ease-out forwards;
          padding: 2px 4px;
        }
      `;
      doc.head.appendChild(style);
    }

    // Process diff hunks
    const lines = patch.split("\n");
    const edits: Array<{ old: string; replacement: string }> = [];

    let currentOld = "";
    let currentNew = "";

    for (const line of lines) {
      if (line.startsWith("-") && !line.startsWith("---")) {
        currentOld += line.slice(1) + "\n";
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        currentNew += line.slice(1) + "\n";
      } else if (line.startsWith(" ")) {
        if (currentOld.trim() || currentNew.trim()) {
          edits.push({
            old: currentOld.trim(),
            replacement: currentNew.trim(),
          });
          currentOld = "";
          currentNew = "";
        }
      }
    }

    if (currentOld.trim() || currentNew.trim()) {
      edits.push({
        old: currentOld.trim(),
        replacement: currentNew.trim(),
      });
    }

    // Apply edits by splitting and wrapping matching text nodes
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      textNodes.push(node);
    }

    for (const edit of edits) {
      if (!edit.old) continue;

      for (const textNode of textNodes) {
        if (textNode.textContent && textNode.textContent.includes(edit.old)) {
          const parent = textNode.parentNode;
          if (parent) {
            const span = doc.createElement("span");
            span.className = "nela-diff-highlight";
            span.textContent = edit.replacement;

            const content = textNode.textContent;
            const index = content.indexOf(edit.old);

            const before = doc.createTextNode(content.substring(0, index));
            const after = doc.createTextNode(content.substring(index + edit.old.length));

            parent.insertBefore(before, textNode);
            parent.insertBefore(span, textNode);
            parent.insertBefore(after, textNode);
            parent.removeChild(textNode);
            break;
          }
        }
      }
    }
  }, []);

  // ── Listen for backend pipeline-stage and patch events ────────────────────
  useEffect(() => {
    const unlisten = listen<PipelineStageEvent>("pipeline-stage", (event) => {
      const payload = event.payload;
      setStage(payload.stage);

      if (payload.stage === "LivePreview" && payload.path) {
        setArtifactPath(payload.path);
        setErrorMessage(null);
      } else if (payload.stage === "Error" && payload.message) {
        setErrorMessage(payload.message);
      }
    });

    const unlistenPatch = listen<{ patch: string; path: string }>(
      "artifact-patch",
      (event) => {
        const payload = event.payload;
        if (payload.patch) {
          _applyPatch(payload.patch);
          setActivePatch(payload.patch);
          setPatchActive(true);
        }
      }
    );

    return () => {
      unlisten.then((fn) => fn());
      unlistenPatch.then((fn) => fn());
    };
  }, [_applyPatch]);

  // ── Convert file path to a Tauri-safe asset URL ───────────────────────────
  useEffect(() => {
    if (!artifactPath) {
      setArtifactSrc(null);
      return;
    }

    const ext = artifactPath.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "html" || ext === "htm") {
      try {
        setArtifactSrc(convertFileSrc(artifactPath));
      } catch {
        setArtifactSrc(null);
      }
    } else {
      setArtifactSrc(null);
    }
  }, [artifactPath]);

  if (!visible) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        background: "var(--color-surface, #1a1a2e)",
        position: "relative",
      }}
    >
      <DiffPatchOverlay
        patch={activePatch}
        active={patchActive}
        onComplete={() => setPatchActive(false)}
      />
      {/* Header bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid var(--color-border, #2d2d4a)",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "var(--color-text-muted, #888)", fontSize: 13 }}>
          Artifact Canvas
        </span>
        <button
          onClick={onClose}
          aria-label="Close artifact pane"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--color-text-muted, #888)",
            fontSize: 18,
            lineHeight: 1,
            padding: "2px 6px",
          }}
        >
          ×
        </button>
      </div>

      {/* Progress slate shown while pipeline is running */}
      {stage !== "LivePreview" && (
        <ProgressSlate stage={stage} error={errorMessage ?? undefined} />
      )}

      {/* Artifact display */}
      {stage === "LivePreview" && (
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {artifactSrc ? (
            /* HTML artifact — rendered in a sandboxed iframe with strict CSP */
            <iframe
              ref={iframeRef}
              src={artifactSrc}
              title="Artifact preview"
              sandbox="allow-scripts allow-same-origin"
              style={{ width: "100%", height: "100%", border: "none" }}
              // Strict CSP: no outbound network, no top navigation.
              // The `csp` attribute is applied via a <meta> injected below.
            />
          ) : artifactPath ? (
            /* Non-HTML artifact (e.g. XLSX) — show download link */
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                gap: 16,
                color: "var(--color-text, #e0e0f0)",
              }}
            >
              <span style={{ fontSize: 48 }}>📄</span>
              <p style={{ margin: 0, fontSize: 15 }}>
                Artifact generated successfully
              </p>
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  color: "var(--color-text-muted, #888)",
                  wordBreak: "break-all",
                  maxWidth: 400,
                  textAlign: "center",
                }}
              >
                {artifactPath}
              </p>
              <button
                onClick={() => {
                  // Open the file using the OS default application.
                  import("@tauri-apps/plugin-opener")
                    .then((m) => m.openUrl(artifactPath))
                    .catch(console.error);
                }}
                style={{
                  padding: "8px 20px",
                  borderRadius: 6,
                  background: "var(--color-accent, #6c63ff)",
                  color: "#fff",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                Open File
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
