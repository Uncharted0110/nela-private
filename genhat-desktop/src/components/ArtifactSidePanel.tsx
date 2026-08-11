import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, FileCode, Table2, Presentation, Code2, Eye, Pencil } from "lucide-react";
import { prepareArtifactHtmlPreview } from "../app/artifactHtmlPreview";
import { parseCSV } from "../app/send/csvParse";
import { extractCsvSheetArtifacts, sanitizeCsvArtifactBody } from "../app/sanitizeCsvArtifact";
import { sanitizeExcelSheetName } from "../app/spreadsheetPlan";
import { Api } from "../api";
import ExcelSheetGrid from "./ExcelSheetGrid";
import ArtifactPreviewEditChat, {
  type PreviewEditMessage,
} from "./ArtifactPreviewEditChat";

const PANEL_WIDTH_KEY = "nela.artifactPanelWidthPx";
const PANEL_MIN_WIDTH = 320;
const PANEL_DEFAULT_WIDTH = 480;

function loadPanelWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= PANEL_MIN_WIDTH) return Math.round(n);
  } catch {
    /* ignore */
  }
  return PANEL_DEFAULT_WIDTH;
}

export interface ArtifactSidePanelProps {
  active: boolean;
  title?: string;
  type?: "text/html" | "text/csv";
  html?: string;
  csv?: string;
  /** Finished file path — panel can stay open after stream ends. */
  savedPath?: string | null;
  /**
   * True only while the first generation is still streaming (no saved file yet).
   * Must not flip on during later edits — that hid the Edit button.
   */
  streamActive?: boolean;
  onClose: () => void;
  /** Apply an edit from the in-preview chat (keeps the panel open). */
  onPreviewEdit?: (
    text: string,
    artifactPath: string,
    onStatus: (message: string, kind: "progress" | "done" | "error") => void
  ) => void | Promise<void>;
}

function HtmlSourceStream({
  html,
  follow,
}: {
  html: string;
  follow: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!follow) return;
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [html, follow]);

  if (!html.trim()) {
    return (
      <div className="p-4 text-sm text-txt-muted">Waiting for HTML…</div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-void-800">
      <pre className="m-0 p-3 text-[0.72rem] leading-relaxed font-mono text-txt whitespace-pre-wrap break-words">
        {html}
        {follow ? (
          <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-neon/80 animate-pulse" />
        ) : null}
      </pre>
      <div ref={endRef} />
    </div>
  );
}

function CsvSourceStream({
  csv,
  follow,
}: {
  csv: string;
  follow: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const cleaned = sanitizeCsvArtifactBody(csv || "");
  useEffect(() => {
    if (!follow) return;
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [cleaned, follow]);

  if (!cleaned.trim()) {
    return (
      <div className="p-4 text-sm text-txt-muted">Waiting for CSV…</div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-void-800">
      <pre className="m-0 p-3 text-[0.72rem] leading-relaxed font-mono text-txt whitespace-pre-wrap break-words">
        {cleaned}
        {follow ? (
          <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-neon/80 animate-pulse" />
        ) : null}
      </pre>
      <div ref={endRef} />
    </div>
  );
}

export default function ArtifactSidePanel({
  active,
  title,
  type = "text/html",
  html,
  csv,
  savedPath,
  streamActive = false,
  onClose,
  onPreviewEdit,
}: ArtifactSidePanelProps) {
  // Only treat as "streaming generation" when there is no saved file yet.
  // Edits briefly change artifactStage away from LivePreview — that must not hide Edit.
  const streaming = Boolean(streamActive) || !savedPath;
  const [htmlView, setHtmlView] = useState<"code" | "preview">("code");
  const [sheetView, setSheetView] = useState<"sheet" | "code">("sheet");
  const [displayHtml, setDisplayHtml] = useState("");
  const [hydratedHtml, setHydratedHtml] = useState("");
  const [xlsxRows, setXlsxRows] = useState<string[][] | null>(null);
  const [xlsxSheetName, setXlsxSheetName] = useState("Sheet1");
  const [xlsxSheets, setXlsxSheets] = useState<
    Array<{ name: string; rows: string[][] }> | null
  >(null);
  const [xlsxLoading, setXlsxLoading] = useState(false);
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [resizing, setResizing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editMessages, setEditMessages] = useState<PreviewEditMessage[]>([]);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestHtml = useRef(html ?? "");
  const paintedOnce = useRef(false);
  const prevSaved = useRef(savedPath);
  const editMsgId = useRef(0);

  const clampWidth = useCallback((width: number) => {
    const parentWidth =
      panelRef.current?.parentElement?.clientWidth ?? window.innerWidth;
    const maxWidth = Math.max(PANEL_MIN_WIDTH, Math.floor(parentWidth * 0.85));
    return Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, Math.round(width)));
  }, []);

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startWidth: panelWidth };
    setResizing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Panel is on the right — dragging the left edge leftward grows width.
    const next = clampWidth(drag.startWidth + (drag.startX - e.clientX));
    setPanelWidth(next);
  };

  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    setPanelWidth((w) => {
      const clamped = clampWidth(w);
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(clamped));
      } catch {
        /* ignore */
      }
      return clamped;
    });
  };

  useEffect(() => {
    if (!active) return;
    const onWinResize = () => setPanelWidth((w) => clampWidth(w));
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, [active, clampWidth]);

  useEffect(() => {
    if (!resizing) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [resizing]);

  useEffect(() => {
    if (!savedPath && prevSaved.current) {
      setHtmlView("code");
      setSheetView("sheet");
      setXlsxRows(null);
      setXlsxSheets(null);
      setHydratedHtml("");
      setDisplayHtml("");
      paintedOnce.current = false;
    }
    if (savedPath && savedPath !== prevSaved.current) {
      // Switching between artifacts — drop prior body so we reload from disk.
      setHydratedHtml("");
      setDisplayHtml("");
      setXlsxRows(null);
      setXlsxSheets(null);
      paintedOnce.current = false;
      if (!prevSaved.current) {
        setHtmlView("preview");
        setSheetView("sheet");
      }
      // New artifact path from an edit — keep edit chat, clear only when path stem changes a lot.
      if (prevSaved.current && !editOpen) {
        setEditMessages([]);
      }
    }
    prevSaved.current = savedPath;
  }, [savedPath, editOpen]);

  // Load HTML from durable disk path when session was restored without the body.
  useEffect(() => {
    if (type !== "text/html" || !savedPath || !/\.html?$/i.test(savedPath)) {
      return;
    }
    if (html && html.trim().length > 0) return;
    let cancelled = false;
    Api.readFileText(savedPath)
      .then((text) => {
        if (cancelled || !text?.trim()) return;
        setHydratedHtml(text);
        setDisplayHtml(prepareArtifactHtmlPreview(text));
        paintedOnce.current = true;
      })
      .catch((err) => {
        console.warn("Failed to reload HTML artifact from disk:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [savedPath, type, html]);

  // Load real .xlsx grid after save / restore.
  useEffect(() => {
    if (!savedPath || type !== "text/csv") {
      return;
    }
    if (!/\.xlsx?$/i.test(savedPath)) {
      setXlsxRows(null);
      setXlsxSheets(null);
      return;
    }
    let cancelled = false;
    setXlsxLoading(true);
    Api.parseSpreadsheetData(savedPath, 200)
      .then((data) => {
        if (cancelled) return;
        setXlsxRows(data.rows ?? []);
        setXlsxSheetName(data.sheet_name || title || "Sheet1");
        const multi = (data.sheets ?? []).map((s) => ({
          name: s.sheet_name || "Sheet1",
          rows: s.rows ?? [],
        }));
        setXlsxSheets(multi.length > 0 ? multi : null);
      })
      .catch((err) => {
        console.warn("Failed to parse spreadsheet for panel:", err);
        if (!cancelled) {
          setXlsxRows(null);
          setXlsxSheets(null);
        }
      })
      .finally(() => {
        if (!cancelled) setXlsxLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [savedPath, type, title]);

  const effectiveHtml = (html && html.trim() ? html : hydratedHtml) || "";

  useEffect(() => {
    if (type !== "text/html") return;
    latestHtml.current = effectiveHtml;
    if (!latestHtml.current) {
      if (!savedPath) {
        paintedOnce.current = false;
        setDisplayHtml("");
      }
      return;
    }

    const apply = () => {
      setDisplayHtml(prepareArtifactHtmlPreview(latestHtml.current));
      paintedOnce.current = true;
    };

    if (!paintedOnce.current || savedPath) {
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
      apply();
      return;
    }

    if (throttleRef.current) return;
    throttleRef.current = setTimeout(() => {
      throttleRef.current = null;
      apply();
    }, 250);

    return undefined;
  }, [effectiveHtml, type, savedPath]);

  useEffect(() => {
    return () => {
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
    };
  }, []);

  const csvGridRows = useMemo(() => {
    const cleaned = sanitizeCsvArtifactBody(csv || "");
    const { headers, rows } = parseCSV(cleaned);
    if (!headers.length) return [] as string[][];
    return [headers, ...rows];
  }, [csv]);

  const streamingCsvSheets = useMemo(() => {
    const arts = extractCsvSheetArtifacts(csv || "");
    if (arts.length <= 1) return null;
    return arts
      .map((a, i) => {
        const { headers, rows } = parseCSV(a.csv);
        if (!headers.length) return null;
        return {
          name: sanitizeExcelSheetName(a.title || `Sheet${i + 1}`),
          rows: [headers, ...rows] as string[][],
        };
      })
      .filter((s): s is { name: string; rows: string[][] } => s !== null);
  }, [csv]);

  const sheetRows = xlsxRows && xlsxRows.length > 0 ? xlsxRows : csvGridRows;
  const sheetName =
    xlsxRows && xlsxRows.length > 0
      ? xlsxSheetName
      : streamingCsvSheets?.[0]?.name || title || "Sheet1";
  const workbookSheets =
    xlsxSheets && xlsxSheets.length > 0
      ? xlsxSheets
      : streamingCsvSheets && streamingCsvSheets.length > 0
        ? streamingCsvSheets
        : undefined;

  if (!active) return null;

  const Icon =
    type === "text/csv"
      ? Table2
      : title?.toLowerCase().includes("deck") ||
          title?.toLowerCase().includes("slide")
        ? Presentation
        : FileCode;

  const showHtmlChrome = type === "text/html";
  const showSheetChrome = type === "text/csv";
  const effectiveHtmlView =
    showHtmlChrome && streaming && htmlView === "preview" && !displayHtml
      ? "code"
      : htmlView;
  const canEdit = Boolean(savedPath && onPreviewEdit);

  const pushEditMessage = (
    role: "user" | "assistant",
    content: string,
    kind?: PreviewEditMessage["kind"]
  ) => {
    editMsgId.current += 1;
    setEditMessages((prev) => [
      ...prev,
      { id: `pe-${editMsgId.current}`, role, content, kind },
    ]);
  };

  const handlePreviewSend = async (text: string) => {
    if (!savedPath || !onPreviewEdit || editBusy) return;
    pushEditMessage("user", text);
    setEditBusy(true);
    let lastAssistantId: string | null = null;
    const onStatus = (message: string, kind: "progress" | "done" | "error") => {
      const plain = message.replace(/\*\*/g, "");
      if (lastAssistantId) {
        setEditMessages((prev) =>
          prev.map((m) =>
            m.id === lastAssistantId ? { ...m, content: plain, kind } : m
          )
        );
      } else {
        editMsgId.current += 1;
        lastAssistantId = `pe-${editMsgId.current}`;
        setEditMessages((prev) => [
          ...prev,
          { id: lastAssistantId!, role: "assistant", content: plain, kind },
        ]);
      }
    };
    try {
      await onPreviewEdit(text, savedPath, onStatus);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onStatus(message || "Edit failed.", "error");
    } finally {
      setEditBusy(false);
      if (type === "text/html") setHtmlView("preview");
    }
  };

  return (
    <aside
      ref={panelRef}
      className="relative flex flex-col min-w-0 h-full border-l border-glass-border bg-void-800 shrink-0"
      style={{ width: panelWidth, maxWidth: "85%" }}
      aria-label="Artifact preview"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize artifact panel"
        aria-valuenow={panelWidth}
        aria-valuemin={PANEL_MIN_WIDTH}
        tabIndex={0}
        className={`absolute left-0 top-0 bottom-0 z-20 w-1.5 -ml-0.5 cursor-col-resize touch-none group ${
          resizing ? "bg-neon/50" : "bg-transparent hover:bg-neon/35"
        }`}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setPanelWidth((w) => {
              const next = clampWidth(w + 24);
              try {
                localStorage.setItem(PANEL_WIDTH_KEY, String(next));
              } catch {
                /* ignore */
              }
              return next;
            });
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setPanelWidth((w) => {
              const next = clampWidth(w - 24);
              try {
                localStorage.setItem(PANEL_WIDTH_KEY, String(next));
              } catch {
                /* ignore */
              }
              return next;
            });
          }
        }}
      >
        <span
          className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-10 w-1 rounded-full transition-opacity ${
            resizing ? "bg-neon opacity-100" : "bg-neon/70 opacity-0 group-hover:opacity-100"
          }`}
          aria-hidden
        />
      </div>
      <header className="flex items-center gap-2 px-3 py-2.5 border-b border-glass-border shrink-0 bg-void-900">
        <Icon size={16} className="text-neon shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[0.82rem] font-medium text-txt truncate">
            {title?.trim() || (type === "text/csv" ? "Spreadsheet" : "Artifact")}
          </div>
          <div className="text-[0.68rem] text-txt-muted truncate">
            {type === "text/csv"
              ? sheetView === "code"
                ? "CSV source"
                : "Sheet preview"
              : effectiveHtmlView === "code"
                ? "HTML source"
                : "HTML preview"}
            {savedPath ? " · saved" : " · streaming"}
          </div>
        </div>
        {showHtmlChrome && (
          <div className="flex items-center rounded-lg border border-glass-border overflow-hidden shrink-0">
            <button
              type="button"
              className={`px-2 py-1 text-[0.68rem] flex items-center gap-1 ${
                effectiveHtmlView === "code"
                  ? "bg-void-600 text-txt"
                  : "text-txt-muted hover:text-txt"
              }`}
              onClick={() => setHtmlView("code")}
              title="Show HTML source"
            >
              <Code2 size={12} />
              Code
            </button>
            <button
              type="button"
              className={`px-2 py-1 text-[0.68rem] flex items-center gap-1 ${
                effectiveHtmlView === "preview"
                  ? "bg-void-600 text-txt"
                  : "text-txt-muted hover:text-txt"
              }`}
              onClick={() => setHtmlView("preview")}
              title="Show rendered preview"
              disabled={!displayHtml && !effectiveHtml.trim()}
            >
              <Eye size={12} />
              Preview
            </button>
          </div>
        )}
        {showSheetChrome && (
          <div className="flex items-center rounded-lg border border-glass-border overflow-hidden shrink-0">
            <button
              type="button"
              className={`px-2 py-1 text-[0.68rem] flex items-center gap-1 ${
                sheetView === "sheet"
                  ? "bg-void-600 text-txt"
                  : "text-txt-muted hover:text-txt"
              }`}
              onClick={() => setSheetView("sheet")}
              title="Excel-like sheet"
            >
              <Table2 size={12} />
              Sheet
            </button>
            <button
              type="button"
              className={`px-2 py-1 text-[0.68rem] flex items-center gap-1 ${
                sheetView === "code"
                  ? "bg-void-600 text-txt"
                  : "text-txt-muted hover:text-txt"
              }`}
              onClick={() => setSheetView("code")}
              title="Show CSV source"
            >
              <Code2 size={12} />
              Code
            </button>
          </div>
        )}
        {canEdit ? (
          <button
            type="button"
            className={`px-2 py-1 rounded-lg text-[0.68rem] flex items-center gap-1 shrink-0 border ${
              editOpen
                ? "border-neon/40 bg-neon/10 text-neon"
                : "border-glass-border text-txt-muted hover:text-txt hover:bg-void-600"
            }`}
            onClick={() => setEditOpen((v) => !v)}
            title="Edit this artifact in the preview"
          >
            <Pencil size={12} />
            Edit
          </button>
        ) : null}
        <button
          type="button"
          className="p-1.5 rounded-lg text-txt-muted hover:text-txt hover:bg-void-600"
          onClick={onClose}
          aria-label="Close artifact panel"
        >
          <X size={16} />
        </button>
      </header>
      <div className="flex-1 min-h-0 bg-void-900 flex flex-col">
        <div className="flex-1 min-h-0">
          {type === "text/csv" ? (
            sheetView === "code" ? (
              <CsvSourceStream csv={csv ?? ""} follow={streaming} />
            ) : xlsxLoading && !sheetRows.length ? (
              <div className="p-4 text-sm text-txt-muted flex items-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-neon border-t-transparent rounded-full animate-spin" />
                Opening workbook…
              </div>
            ) : (
              <ExcelSheetGrid
                rows={sheetRows}
                sheetName={sheetName}
                sheets={workbookSheets}
                streaming={streaming && !savedPath}
              />
            )
          ) : effectiveHtmlView === "code" ? (
            <HtmlSourceStream html={effectiveHtml} follow={streaming && !savedPath} />
          ) : displayHtml ? (
            <iframe
              title={title || "Artifact preview"}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin"
              srcDoc={displayHtml}
            />
          ) : (
            <div className="p-4 text-sm text-txt-muted">Waiting for HTML…</div>
          )}
        </div>
        {canEdit ? (
          <ArtifactPreviewEditChat
            open={editOpen}
            busy={editBusy}
            messages={editMessages}
            onClose={() => setEditOpen(false)}
            onSend={(t) => void handlePreviewSend(t)}
          />
        ) : null}
      </div>
    </aside>
  );
}
