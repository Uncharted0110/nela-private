import { useEffect, useRef, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import { FileText, Eye, EyeOff, Play, AlertCircle, Download, FileType, Presentation, Loader2 } from "lucide-react";
import { type PipelineStageKind } from "./ProgressSlate";
import DiffPatchOverlay from "./DiffPatchOverlay";
import { Api } from "../api";
import { exportPresentation, type DeckExportFormat } from "../app/exportDeck";
import { prepareArtifactHtmlPreview } from "../app/artifactHtmlPreview";

export interface InlineArtifactProps {
  artifactPath?: string | null;
  artifactStage?: PipelineStageKind | null;
  /** Optional error detail (shown when the stage is "Error"). */
  errorMessage?: string | null;
}

const STAGE_LABELS: Record<PipelineStageKind, { label: string; desc: string; icon: string }> = {
  IntentLocked: { label: "Intent Locked", desc: "Analyzing request...", icon: "🔒" },
  SearchingDisk: { label: "Searching", desc: "Locating dataset files...", icon: "🔍" },
  CrunchingMetrics: { label: "Crunching Data", desc: "Analyzing structure...", icon: "⚙️" },
  WritingCode: { label: "Generating", desc: "Writing code / spreadsheet...", icon: "✍️" },
  LivePreview: { label: "Ready", desc: "Artifact generated successfully.", icon: "✅" },
  Error: { label: "Failed", desc: "Error generating artifact.", icon: "⚠️" },
};

const STAGE_ORDER: PipelineStageKind[] = [
  "IntentLocked",
  "SearchingDisk",
  "CrunchingMetrics",
  "WritingCode",
  "LivePreview",
];

const SPINNER_VERBS: Record<PipelineStageKind, string[]> = {
  IntentLocked: [
    "Analyzing request...",
    "Ruminating on prompt...",
    "Locking in intent...",
    "Forging plan...",
  ],
  SearchingDisk: [
    "Locating dataset files...",
    "Scanning local indices...",
    "Querying file database...",
    "Retrieving system context...",
  ],
  CrunchingMetrics: [
    "Analyzing structure...",
    "Synthesizing data...",
    "Crunching metrics...",
    "Computing aggregates...",
  ],
  WritingCode: [
    "Writing code / layout...",
    "Forging layouts...",
    "Polishing cells...",
    "Formatting stylesheet...",
  ],
  LivePreview: ["Artifact generated successfully."],
  Error: ["Error generating artifact."],
};

export default function InlineArtifact({ artifactPath, artifactStage, errorMessage }: InlineArtifactProps) {
  const [stage, setStage] = useState<PipelineStageKind>(artifactStage || "IntentLocked");
  const [currentPath, setCurrentPath] = useState<string | null>(artifactPath ?? null);
  const [activePatch, setActivePatch] = useState<string | null>(null);
  const [patchActive, setPatchActive] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [artifactHtml, setArtifactHtml] = useState<string | null>(null);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [exporting, setExporting] = useState<DeckExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [spreadsheetData, setSpreadsheetData] = useState<{ sheetName: string; rows: string[][] } | null>(null);
  const [loadingSpreadsheet, setLoadingSpreadsheet] = useState(false);
  const [verbIndex, setVerbIndex] = useState(0);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Mirror this artifact's own message props. Each InlineArtifact reflects only
  // its own message, so switching chats/workspaces or generating a new artifact
  // never overrides previously generated ones.
  useEffect(() => {
    setStage(artifactStage || "IntentLocked");
  }, [artifactStage]);

  useEffect(() => {
    setCurrentPath(artifactPath ?? null);
  }, [artifactPath]);

  // Dynamic spinner verb cycler
  useEffect(() => {
    setVerbIndex(0);
  }, [stage]);

  useEffect(() => {
    if (stage === "LivePreview" || stage === "Error") return;
    const interval = setInterval(() => {
      setVerbIndex((prev) => (prev + 1) % (SPINNER_VERBS[stage]?.length || 1));
    }, 1500);
    return () => clearInterval(interval);
  }, [stage]);

  // Diff-patch hot reload function
  const applyPatch = useCallback((patch: string) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument || !patch) return;

    const doc = iframe.contentDocument;

    // Inject stylesheet if not present
    if (!doc.getElementById("nela-patch-style")) {
      const style = doc.createElement("style");
      style.id = "nela-patch-style";
      style.textContent = `
        @keyframes nela-pulse-highlight {
          0% { background-color: rgba(0, 212, 255, 0.4); border-radius: 4px; }
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

  // Listen for targeted hot-reload patches. We intentionally do NOT listen to
  // the global "pipeline-stage" event here: that event is broadcast app-wide
  // and would cause every rendered artifact (including finished ones in this
  // chat or another workspace) to adopt the newest artifact's path/stage.
  // Each artifact is instead driven solely by its own message props
  // (artifactPath / artifactStage), so every artifact stays separate.
  // The patch listener is scoped to this artifact's own path.
  useEffect(() => {
    if (!currentPath) return;
    const unlistenPatch = listen<{ patch: string; path: string }>(
      "artifact-patch",
      (event) => {
        const payload = event.payload;
        if (payload.path === currentPath && payload.patch) {
          applyPatch(payload.patch);
          setActivePatch(payload.patch);
          setPatchActive(true);
        }
      }
    );

    return () => {
      unlistenPatch.then((fn) => fn());
    };
  }, [currentPath, applyPatch]);

  // Load HTML artifact content via Tauri; render with srcDoc (avoids file:// iframe errors).
  useEffect(() => {
    if (!currentPath) {
      setArtifactHtml(null);
      return;
    }

    const ext = currentPath.split(".").pop()?.toLowerCase() ?? "";
    if (ext !== "html" && ext !== "htm") {
      setArtifactHtml(null);
      return;
    }

    let cancelled = false;

    Api.readFileText(currentPath)
      .then((html) => {
        if (cancelled) return;
        setArtifactHtml(prepareArtifactHtmlPreview(html));
        setShowPreview(true);
      })
      .catch((err) => {
        console.error("Failed to load HTML artifact:", err);
        if (!cancelled) setArtifactHtml(null);
      });

    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  const filename = currentPath ? currentPath.split(/[/\\]/).pop() : "artifact";
  const isHtml = currentPath ? (currentPath.endsWith(".html") || currentPath.endsWith(".htm")) : false;
  const isSpreadsheet = currentPath ? (currentPath.endsWith(".xlsx") || currentPath.endsWith(".xls") || currentPath.endsWith(".csv")) : false;

  // Load spreadsheet data via Tauri command
  useEffect(() => {
    if (stage === "LivePreview" && isSpreadsheet && currentPath) {
      setLoadingSpreadsheet(true);
      Api.parseSpreadsheetData(currentPath)
        .then((res: { sheet_name: string; rows: string[][] }) => {
          setSpreadsheetData({
            sheetName: res.sheet_name,
            rows: res.rows,
          });
        })
        .catch((err: any) => {
          console.error("Failed to parse spreadsheet data:", err);
        })
        .finally(() => {
          setLoadingSpreadsheet(false);
        });
    } else {
      setSpreadsheetData(null);
    }
  }, [stage, isSpreadsheet, currentPath]);

  // Open file in OS
  const handleOpenFile = () => {
    if (!currentPath) return;
    openPath(currentPath).catch((err) => console.error("Failed to open file:", err));
  };

  // Export the deck to PDF/PPTX at a user-chosen path.
  const handleExport = useCallback(
    async (format: DeckExportFormat) => {
      if (!currentPath || exporting) return;
      setDownloadMenuOpen(false);
      setExportError(null);
      setExporting(format);
      try {
        await exportPresentation(currentPath, format);
      } catch (err: any) {
        console.error(`Failed to export ${format}:`, err);
        setExportError(err?.message || String(err));
      } finally {
        setExporting(null);
      }
    },
    [currentPath, exporting]
  );

  // Close the download menu when clicking elsewhere.
  useEffect(() => {
    if (!downloadMenuOpen) return;
    const close = () => setDownloadMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [downloadMenuOpen]);

  // ── Render Loading Progress ──
  if (stage !== "LivePreview" && stage !== "Error") {
    const stageInfo = STAGE_LABELS[stage] || { label: "Processing", desc: "Working...", icon: "⚙️" };
    const currentIdx = STAGE_ORDER.indexOf(stage);
    const activeVerb = SPINNER_VERBS[stage]?.[verbIndex] || stageInfo.desc;

    return (
      <div className="w-full rounded-xl bg-void-800/40 border border-neon/20 p-4 shadow-lg backdrop-blur-sm animate-pulse">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-xl leading-none">{stageInfo.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="text-[0.84rem] font-semibold text-txt">{stageInfo.label}</div>
            <div className="text-[0.72rem] text-txt-muted truncate">{activeVerb}</div>
          </div>
        </div>

        {/* Compact stage dots indicator */}
        <div className="flex items-center justify-between px-2 pt-1 max-w-xs">
          {STAGE_ORDER.slice(0, 4).map((s, idx) => {
            const isCompleted = idx < currentIdx;
            const isCurrent = idx === currentIdx;

            return (
              <div key={s} className="flex items-center flex-1 last:flex-none">
                <div
                  className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
                    isCompleted
                      ? "bg-neon"
                      : isCurrent
                      ? "bg-neon ring-4 ring-neon-subtle shadow-[0_0_8px_var(--color-neon)]"
                      : "bg-void-600 border border-glass-border"
                  }`}
                  title={STAGE_LABELS[s]?.label}
                />
                {idx < 3 && (
                  <div
                    className={`flex-1 h-0.5 mx-1 transition-all duration-300 ${
                      isCompleted ? "bg-neon" : "bg-glass-border"
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Render Error ──
  if (stage === "Error") {
    return (
      <div className="w-full rounded-xl bg-danger/5 border border-danger/20 p-4 shadow-lg backdrop-blur-sm">
        <div className="flex gap-3 items-start">
          <AlertCircle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-[0.84rem] font-semibold text-danger">Generation Failed</div>
            <div className="text-[0.72rem] text-txt-secondary mt-1 whitespace-pre-wrap">
              {errorMessage || "An unexpected error occurred during execution."}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Render Completed Preview / Card ──
  return (
    <div className="w-full rounded-xl bg-void-800/50 border border-glass-border shadow-lg overflow-hidden flex flex-col transition-all duration-200">
      <DiffPatchOverlay patch={activePatch} active={patchActive} onComplete={() => setPatchActive(false)} />

      {/* Card Header Bar */}
      <div className="flex items-center justify-between p-3.5 bg-void-950/40 border-b border-glass-border">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-neon/10 border border-neon/20 flex items-center justify-center text-neon shrink-0">
            <FileText size={16} />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-[0.84rem] font-medium text-txt truncate" title={filename || ""}>
              {filename}
            </span>
            <span className="text-[0.68rem] text-txt-muted">
              {isSpreadsheet ? "Spreadsheet Artifact" : isHtml ? "HTML Preview" : "Generated File"}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5">
          {isHtml && (
            <button
              onClick={() => setShowPreview((p) => !p)}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[0.74rem] transition-all duration-150 border ${
                showPreview
                  ? "bg-neon/15 text-neon border-neon/30"
                  : "bg-glass-bg text-txt-secondary border-glass-border hover:border-neon hover:text-txt"
              }`}
              title={showPreview ? "Hide preview" : "Show interactive preview"}
            >
              {showPreview ? <EyeOff size={13} /> : <Eye size={13} />}
              <span>{showPreview ? "Hide Preview" : "Preview"}</span>
            </button>
          )}

          {isHtml && (
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExportError(null);
                  setDownloadMenuOpen((o) => !o);
                }}
                disabled={!!exporting}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[0.74rem] bg-glass-bg text-txt-secondary border border-glass-border transition-all duration-150 hover:border-neon hover:text-txt disabled:opacity-60 disabled:cursor-not-allowed"
                title="Download as PDF or PowerPoint"
              >
                {exporting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Download size={13} />
                )}
                <span>{exporting ? `Exporting ${exporting.toUpperCase()}…` : "Download"}</span>
              </button>

              {downloadMenuOpen && !exporting && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-0 top-full mt-1 z-20 min-w-[180px] rounded-lg bg-void-900 border border-glass-border shadow-xl overflow-hidden"
                >
                  <button
                    onClick={() => handleExport("pdf")}
                    className="w-full flex items-center gap-2 px-3 py-2 text-[0.76rem] text-txt-secondary hover:bg-void-800 hover:text-txt transition-colors"
                  >
                    <FileType size={14} className="text-neon" />
                    <span>Download as PDF</span>
                  </button>
                  <button
                    onClick={() => handleExport("pptx")}
                    className="w-full flex items-center gap-2 px-3 py-2 text-[0.76rem] text-txt-secondary hover:bg-void-800 hover:text-txt transition-colors border-t border-glass-border"
                  >
                    <Presentation size={14} className="text-neon" />
                    <span>Download as PowerPoint</span>
                  </button>
                </div>
              )}
            </div>
          )}

          <button
            onClick={handleOpenFile}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[0.74rem] bg-neon text-void-900 font-medium border border-neon/50 transition-all duration-150 hover:bg-neon-hover"
            title="Open file in external application"
          >
            <Play size={11} fill="currentColor" />
            <span>Open File</span>
          </button>
        </div>
      </div>

      {exportError && (
        <div className="px-3.5 py-2 text-[0.72rem] text-red-300 bg-red-500/10 border-b border-red-500/20">
          Export failed: {exportError}
        </div>
      )}

      {/* Interactive HTML Preview Area */}
      {isHtml && showPreview && artifactHtml && (
        <div className="w-full h-[420px] bg-white border-t border-glass-border relative">
          <iframe
            ref={iframeRef}
            srcDoc={artifactHtml}
            title="Artifact preview"
            sandbox="allow-scripts allow-same-origin"
            allow="fullscreen"
            allowFullScreen
            className="w-full h-full border-none"
          />
        </div>
      )}

      {/* Spreadsheet Preview Area */}
      {isSpreadsheet && spreadsheetData && (
        <div className="w-full border-t border-glass-border bg-void-900/60 overflow-hidden flex flex-col">
          <div className="px-3.5 py-2 text-[0.72rem] font-semibold text-txt-secondary border-b border-glass-border flex justify-between items-center bg-void-950/20">
            <span>📊 {spreadsheetData.sheetName}</span>
            <span className="text-[0.65rem] text-txt-muted">{spreadsheetData.rows.length} rows detected</span>
          </div>
          <div className="w-full overflow-x-auto max-h-[300px] overflow-y-auto custom-scrollbar">
            <table className="w-full text-left border-collapse text-[0.74rem]">
              <thead>
                <tr className="bg-void-950/60 border-b border-glass-border sticky top-0 backdrop-blur-md z-10">
                  {spreadsheetData.rows[0]?.map((cell, idx) => (
                    <th key={idx} className="p-2.5 font-semibold text-neon border-r border-glass-border last:border-r-0 whitespace-nowrap">
                      {cell || `Column ${idx + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {spreadsheetData.rows.slice(1, 50).map((row, rowIdx) => (
                  <tr key={rowIdx} className="border-b border-glass-border/40 hover:bg-void-800/30 transition-colors">
                    {row.map((cell, cellIdx) => (
                      <td key={cellIdx} className="p-2.5 text-txt-secondary border-r border-glass-border/40 last:border-r-0 whitespace-nowrap max-w-[200px] truncate" title={cell}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {spreadsheetData.rows.length > 50 && (
            <div className="px-3.5 py-1.5 bg-void-950/40 text-[0.65rem] text-txt-muted text-center border-t border-glass-border">
              Showing top 50 rows. Open the file to view the remaining {spreadsheetData.rows.length - 50} rows.
            </div>
          )}
        </div>
      )}

      {isSpreadsheet && loadingSpreadsheet && (
        <div className="w-full border-t border-glass-border p-4 flex items-center justify-center gap-2 text-[0.74rem] text-txt-muted bg-void-900/60">
          <div className="w-4 h-4 border-2 border-neon border-t-transparent rounded-full animate-spin" />
          <span>Parsing spreadsheet data...</span>
        </div>
      )}
    </div>
  );
}
