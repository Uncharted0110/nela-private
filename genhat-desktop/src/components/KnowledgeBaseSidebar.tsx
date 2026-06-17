import {
  FileText,
  FolderOpen,
  Trash2,
  Loader2,
  CheckCircle2,
  FolderSearch,
  RefreshCw,
  X,
  PlusCircle,
} from "lucide-react";
import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { ChatSession, IngestionStatus, WatchedPath, ScanProgress } from "../types";
import { VIEWABLE_EXTS } from "../app/constants";
import { formatPageLabel } from "../app/mindmapUtils";
import { COPY } from "../app/copy";
import {
  addWatchedPath,
  removeWatchedPath,
  listWatchedPaths,
  triggerScan,
} from "../api";

interface KnowledgeBaseSidebarProps {
  docPanelOpen: boolean;
  ragIngesting: boolean;
  enrichmentStatus: string | null;
  ragDocs: IngestionStatus[];
  activeSession: ChatSession | null;
  onClosePanel: () => void;
  onIngestFile: () => void;
  onIngestDir: () => void;
  onOpenDocViewer: (doc: IngestionStatus) => void;
  onDeleteRagDoc: (docId: number) => void;
}

/** Map internal ingestion phase + placeholder state to a friendly status. */
function friendlyDocStatus(phase: string, isPlaceholder: boolean): {
  label: string;
  tone: "adding" | "ready" | "enhanced";
} {
  if (isPlaceholder) return { label: COPY.docStateAdding, tone: "adding" };
  if (phase.includes("phase2_complete")) return { label: COPY.docStateEnhanced, tone: "enhanced" };
  if (phase.includes("phase2")) return { label: COPY.docStateReady, tone: "ready" };
  return { label: COPY.docStateReady, tone: "ready" };
}

function relevanceLabelFromGradeOrScore(grade: number | null | undefined, score: number): string {
  if (typeof grade === "number") {
    if (grade >= 4) return COPY.relevanceHigh;
    if (grade >= 3) return COPY.relevanceMedium;
    return COPY.relevanceLow;
  }
  if (score >= 0.03) return COPY.relevanceHigh;
  if (score >= 0.015) return COPY.relevanceMedium;
  return COPY.relevanceLow;
}

export default function KnowledgeBaseSidebar({
  docPanelOpen,
  ragIngesting,
  enrichmentStatus,
  ragDocs,
  activeSession,
  onClosePanel,
  onIngestFile,
  onIngestDir,
  onOpenDocViewer,
  onDeleteRagDoc,
}: KnowledgeBaseSidebarProps) {
  const [watchedPaths, setWatchedPaths] = useState<WatchedPath[]>([]);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!docPanelOpen) return;
    listWatchedPaths()
      .then((paths) => setWatchedPaths(paths))
      .catch(() => {
        // Silently ignore if no active workspace yet
      });
  }, [docPanelOpen]);

  useEffect(() => {
    const unlistenPromise = listen<ScanProgress>("rag:scan_progress", (event) => {
      setScanProgress(event.payload);
      if (event.payload.done) {
        setScanning(false);
        listWatchedPaths()
          .then((paths) => setWatchedPaths(paths))
          .catch(() => {});
      }
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  const handleAddPath = async () => {
    const selected = await open({ directory: true });
    if (!selected) return;
    const dir = Array.isArray(selected) ? selected[0] : selected;
    if (!dir) return;
    try {
      await addWatchedPath(dir);
      const paths = await listWatchedPaths();
      setWatchedPaths(paths);
    } catch (e) {
      console.error("Failed to add watched path:", e);
    }
  };

  const handleRemovePath = async (path: string) => {
    try {
      await removeWatchedPath(path);
      setWatchedPaths((prev) => prev.filter((p) => p.path !== path));
    } catch (e) {
      console.error("Failed to remove watched path:", e);
    }
  };

  const handleScan = async () => {
    setScanning(true);
    setScanProgress(null);
    try {
      await triggerScan();
    } catch (e) {
      console.error("Scan failed:", e);
      setScanning(false);
    }
  };

  return (
    <div
      className={`overflow-hidden bg-void-800 flex flex-col shrink-0 ${docPanelOpen ? "w-[320px] min-w-[320px]" : "w-0 min-w-0"} border-l border-glass-border`}
      data-tour="kb-sidebar"
    >
      <div className={`kb-sidebar-inner flex flex-col h-full w-[320px] ${docPanelOpen ? "opacity-100" : "opacity-0"}`}>
        <div className="flex items-center justify-between py-3.5 px-4 border-b border-glass-border shrink-0">
          <div className="flex items-center gap-2 text-[0.85rem] font-semibold text-txt">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            {COPY.libraryTitle}
          </div>
          <button
            className="glass-btn bg-transparent! border border-transparent! text-txt-muted! cursor-pointer p-1.5! rounded-lg! flex items-center justify-center transition-all duration-200 hover:text-txt! hover:border-glass-border! hover:bg-void-700!"
            onClick={onClosePanel}
            title="Close panel"
            aria-label="Close document library"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex gap-1.5 py-3 px-4 border-b border-glass-border shrink-0">
          <button
            onClick={onIngestFile}
            disabled={ragIngesting}
            aria-label={COPY.addDocumentsTitle}
            className="glass-btn inline-flex items-center gap-1.5 py-1.5 px-3 text-[0.78rem] font-medium rounded-lg cursor-pointer text-txt-secondary border border-glass-border transition-all duration-200 hover:text-txt hover:border-neon hover:shadow-[0_0_12px_rgba(0,212,255,0.1)] disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <FileText size={14} /> {COPY.addDocumentsTitle}
          </button>
          <button
            onClick={onIngestDir}
            disabled={ragIngesting}
            aria-label={COPY.addFolderTitle}
            className="glass-btn inline-flex items-center gap-1.5 py-1.5 px-3 text-[0.78rem] font-medium rounded-lg cursor-pointer text-txt-secondary border border-glass-border transition-all duration-200 hover:text-txt hover:border-neon hover:shadow-[0_0_12px_rgba(0,212,255,0.1)] disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <FolderOpen size={14} /> {COPY.addFolderTitle}
          </button>
        </div>

        {(ragIngesting || enrichmentStatus) && (
          <div className="flex items-center gap-2 py-2 px-4 shrink-0">
            {ragIngesting && (
              <span className="inline-flex items-center gap-1.5 py-0.5 px-2.5 rounded-full text-[0.78rem] font-medium bg-[rgba(251,191,36,0.1)] text-warning">
                <Loader2 size={12} className="spin" /> {COPY.processing}
              </span>
            )}
            {enrichmentStatus && (
              <span className="inline-flex items-center gap-1.5 py-0.5 px-2.5 rounded-full text-[0.78rem] font-medium bg-[rgba(34,197,94,0.1)] text-success">
                <CheckCircle2 size={12} /> {COPY.docStateEnhanced}
              </span>
            )}
          </div>
        )}

        <div className="kb-sidebar-docs flex-1 overflow-y-auto p-2">
          {ragDocs.length === 0 ? (
            <p className="text-txt-muted text-[0.82rem] m-1">
              {COPY.libraryEmpty}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {ragDocs.map((doc) => {
                const ext = doc.file_path?.split(".").pop()?.toLowerCase() || "";
                const isViewable = ext === "pdf" || VIEWABLE_EXTS.has(ext);
                const isPlaceholder = doc.doc_id < 0;
                const status = friendlyDocStatus(doc.phase, isPlaceholder);
                const statusClass =
                  status.tone === "adding"
                    ? "bg-[rgba(251,191,36,0.15)] text-warning"
                    : status.tone === "enhanced"
                      ? "bg-[rgba(34,197,94,0.15)] text-success"
                      : "bg-[rgba(0,212,255,0.1)] text-neon";
                return (
                  <div
                    key={doc.doc_id}
                    className={`flex items-center gap-2 py-2 px-2.5 bg-void-700 rounded-lg text-[0.78rem] border border-transparent transition-colors duration-150 flex-wrap hover:border-glass-border ${isViewable ? "cursor-pointer hover:bg-neon-subtle hover:border-neon/20" : ""}`}
                    onClick={() => isViewable && onOpenDocViewer(doc)}
                    title={isViewable ? `Click to view ${ext.toUpperCase()}` : doc.title}
                  >
                    <FileText size={14} className="text-txt-muted shrink-0" />
                    <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-txt font-medium text-[0.78rem]">{doc.title}</span>
                    <span className={`inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[0.78rem] font-semibold whitespace-nowrap ${statusClass}`}>
                      {status.tone === "adding" && <Loader2 size={10} className="animate-spin" />}
                      {status.tone === "enhanced" && <CheckCircle2 size={10} />}
                      {status.label}
                    </span>
                    {!isPlaceholder && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteRagDoc(doc.doc_id);
                        }}
                        className="p-1! bg-transparent! text-txt-muted! border-none! rounded! cursor-pointer flex items-center justify-center transition-all duration-150 hover:text-danger! hover:bg-[rgba(239,68,68,0.1)]!"
                        title="Remove document"
                        aria-label="Remove document"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {activeSession?.ragResult && activeSession.ragResult.sources.length > 0 && (
          <div className="kb-sidebar-sources border-t border-glass-border py-3 px-3 shrink-0 max-h-[250px] overflow-y-auto">
            <div className="flex items-center gap-1.5 mb-2 text-[0.82rem] text-txt-secondary">
              <FileText size={14} />
              <strong>{COPY.sourcesTitle} ({activeSession.ragResult.sources.length})</strong>
            </div>
            {activeSession.ragResult.sources.map((src, i) => (
              <details key={src.chunk_id} className="mb-1 text-[0.78rem]">
                <summary className="cursor-pointer text-neon py-1 transition-colors duration-150 hover:text-neon-hover">
                  [Source {i + 1}] {src.doc_title}
                  {src.page_info ? `, ${formatPageLabel(src.page_info)}` : ""}{" "}
                  ({relevanceLabelFromGradeOrScore(src.grade, src.score)})
                </summary>
                <pre className="whitespace-pre-wrap text-[0.78rem] text-txt-secondary p-2.5 bg-void-900 border border-glass-border rounded-lg mt-1 max-h-[150px] overflow-y-auto">{src.text}</pre>
              </details>
            ))}
          </div>
        )}

        <div className="border-t border-glass-border mt-auto shrink-0">
          <div className="flex items-center justify-between px-3 pt-3 pb-1">
            <div>
              <div className="flex items-center gap-1.5 text-[0.82rem] font-semibold text-txt-secondary">
                <FolderSearch size={14} />
                {COPY.syncFolderTitle}
              </div>
              <p className="text-[0.78rem] text-txt-muted mt-0.5 m-0">{COPY.syncFolderReassure}</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                className="glass-btn bg-transparent! border border-transparent! text-txt-muted! cursor-pointer p-1! rounded! flex items-center justify-center transition-all duration-200 hover:text-txt! hover:bg-void-700!"
                onClick={handleScan}
                disabled={scanning}
                title="Re-scan watched folders"
                aria-label="Re-scan folders"
              >
                <RefreshCw size={12} className={scanning ? "animate-spin" : ""} />
              </button>
              <button
                className="glass-btn bg-transparent! border border-transparent! text-neon! cursor-pointer p-1! rounded! flex items-center justify-center transition-all duration-200 hover:text-neon-hover! hover:bg-void-700!"
                onClick={handleAddPath}
                title="Add folder to watch"
                aria-label="Add a folder to keep in sync"
              >
                <PlusCircle size={13} />
              </button>
            </div>
          </div>

          {watchedPaths.length === 0 ? (
            <p className="text-[0.78rem] text-txt-muted px-3 pb-2 italic">
              {COPY.syncFolderEmpty}
            </p>
          ) : (
            <ul className="px-3 pb-1 space-y-0.5 max-h-[120px] overflow-y-auto">
              {watchedPaths.map((wp) => (
                <li key={wp.id} className="flex items-center justify-between gap-1 text-[0.78rem] text-txt-secondary group">
                  <span className="truncate flex-1" title={wp.path}>
                    {wp.path.split(/[\\/]/).pop() || wp.path}
                  </span>
                  <button
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-txt-muted hover:text-red-400 p-0.5 rounded"
                    onClick={() => handleRemovePath(wp.path)}
                    title={`Remove ${wp.path}`}
                    aria-label={`Remove folder ${wp.path.split(/[\\/]/).pop() || wp.path}`}
                  >
                    <X size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {scanProgress && (
            <div className="px-3 pb-2">
              <p className={`text-[0.78rem] truncate ${scanProgress.done ? "text-neon" : "text-txt-muted"}`}>
                {scanProgress.status}
              </p>
              {!scanProgress.done && scanProgress.found > 0 && (
                <div className="w-full bg-void-900 rounded-full h-1 mt-1">
                  <div
                    className="bg-neon h-1 rounded-full transition-all duration-300"
                    style={{ width: `${Math.round(((scanProgress.ingested + scanProgress.skipped + scanProgress.errors) / scanProgress.found) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
