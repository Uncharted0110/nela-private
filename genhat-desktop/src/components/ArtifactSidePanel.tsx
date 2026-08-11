import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  FileCode,
  Table2,
  Presentation,
  Code2,
  Eye,
  Pencil,
  SendHorizontal,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { prepareArtifactHtmlPreview } from "../app/artifactHtmlPreview";
import { parseCSV } from "../app/send/csvParse";
import { extractCsvSheetArtifacts, sanitizeCsvArtifactBody } from "../app/sanitizeCsvArtifact";
import { sanitizeExcelSheetName } from "../app/spreadsheetPlan";
import { Api } from "../api";
import ExcelSheetGrid from "./ExcelSheetGrid";
import type { PreviewEditMessage } from "./ArtifactPreviewEditChat";
import ArtifactPreviewEditBar from "./ArtifactPreviewEditBar";
import ArtifactPreviewEditLog from "./ArtifactPreviewEditLog";
import ArtifactImagePicker from "./ArtifactImagePicker";
import { cancelImagePicker } from "../stores/imagePickerStore";

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
    onStatus: (message: string, kind: "progress" | "done" | "error") => void,
    editContext?: { activeSlideIndex?: number }
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
  const [editDraft, setEditDraft] = useState("");
  const [editMessages, setEditMessages] = useState<PreviewEditMessage[]>([]);
  // 0-based index of the slide currently shown inside the deck iframe
  // (reported by the deck's nav script via postMessage). Null for non-deck HTML.
  const [activeSlideIndex, setActiveSlideIndex] = useState<number | null>(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const previewCanvasRef = useRef<HTMLDivElement>(null);
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
      setEditDraft("");
      cancelImagePicker();
    }
    if (savedPath && savedPath !== prevSaved.current) {
      // Switching between artifacts — drop prior body so we reload from disk.
      setHydratedHtml("");
      setDisplayHtml("");
      setXlsxRows(null);
      setXlsxSheets(null);
      setActiveSlideIndex(null);
      paintedOnce.current = false;
      cancelImagePicker();
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

  // Never leave a picker await hanging if the panel unmounts or closes.
  useEffect(() => {
    if (!active) cancelImagePicker();
  }, [active]);
  useEffect(() => () => cancelImagePicker(), []);

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

  useEffect(() => {
    const onFsChange = () => {
      const el = previewCanvasRef.current;
      setPreviewFullscreen(Boolean(el && document.fullscreenElement === el));
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const togglePreviewFullscreen = useCallback(async () => {
    const el = previewCanvasRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch (err) {
      console.warn("Preview fullscreen failed:", err);
    }
  }, []);

  // Track which slide is visible inside the deck iframe ("this slide" edits),
  // and apply in-canvas image-library clicks onto that slide.
  useEffect(() => {
    const pushLibMsg = (
      content: string,
      kind: PreviewEditMessage["kind"]
    ) => {
      editMsgId.current += 1;
      setEditMessages((prev) => [
        ...prev,
        {
          id: `pe-${editMsgId.current}`,
          role: "assistant" as const,
          content,
          kind,
        },
      ]);
    };

    const onMessage = (e: MessageEvent) => {
      const data = e.data as {
        type?: string;
        index?: number;
        libId?: number;
        slideIndex?: number;
      } | null;
      if (!data || typeof data.type !== "string") return;

      if (
        data.type === "nela-active-slide" &&
        typeof data.index === "number" &&
        Number.isFinite(data.index) &&
        data.index >= 0
      ) {
        setActiveSlideIndex(Math.floor(data.index));
        return;
      }

      if (data.type === "nela-apply-library-image") {
        if (editBusy || !savedPath) return;
        const libId = data.libId;
        const slideIndex =
          typeof data.slideIndex === "number" && data.slideIndex >= 0
            ? Math.floor(data.slideIndex)
            : activeSlideIndex ?? 0;
        if (typeof libId !== "number" || !Number.isFinite(libId) || libId < 0) {
          return;
        }
        void (async () => {
          setEditBusy(true);
          pushLibMsg(
            `Applying saved image to slide ${slideIndex + 1}…`,
            "progress"
          );
          try {
            const { buildSendHandlerContext } = await import(
              "../app/send/buildContext"
            );
            const { applyDeckLibraryImageChoice } = await import(
              "../app/send/applyDeckLibraryImage"
            );
            const { useSessionStore } = await import("../stores/sessionStore");
            const sid = useSessionStore.getState().activeSessionId;
            if (!sid) throw new Error("No active session");
            const ctx = buildSendHandlerContext();
            const result = await applyDeckLibraryImageChoice({
              artifactPath: savedPath,
              sid,
              ctx,
              libId: Math.floor(libId),
              slideIndex,
            });
            const filename = result.path.split(/[/\\]/).pop();
            pushLibMsg(
              `Applied library image to slide ${slideIndex + 1} → ${filename}`,
              "done"
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            pushLibMsg(message || "Couldn't apply that image.", "error");
          } finally {
            setEditBusy(false);
            if (type === "text/html") setHtmlView("preview");
          }
        })();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [editBusy, savedPath, activeSlideIndex, type]);


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
      await onPreviewEdit(
        text,
        savedPath,
        onStatus,
        activeSlideIndex != null ? { activeSlideIndex } : undefined
      );
      if (!lastAssistantId) {
        onStatus("Edit applied.", "done");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onStatus(message || "Edit failed.", "error");
    } finally {
      setEditBusy(false);
      if (type === "text/html") setHtmlView("preview");
    }
  };

  const submitEditDraft = async (text: string) => {
    if (!savedPath || !onPreviewEdit) return;
    if (!text.trim()) return;
    await handlePreviewSend(text);
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
        {/* NOTE: Edit control moved onto the preview canvas (top-right). */}
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
            <div
              ref={previewCanvasRef}
              className="relative w-full h-full bg-void-900"
            >
              {/* No allow-same-origin: scripts+same-origin lets srcdoc escape
                  its sandbox. Active-slide tracking uses postMessage('*'),
                  which works from an opaque origin. */}
              <iframe
                title={title || "Artifact preview"}
                className="w-full h-full border-0 bg-white"
                sandbox="allow-scripts"
                srcDoc={displayHtml}
              />
              <button
                type="button"
                className={`absolute top-3 left-3 z-20 p-3 rounded-full border ${
                  previewFullscreen
                    ? "border-neon/80 bg-neon/10 text-neon"
                    : "border-neon/60 text-neon hover:bg-neon/15"
                }`}
                onClick={() => void togglePreviewFullscreen()}
                title={
                  previewFullscreen
                    ? "Exit full screen"
                    : "Full screen preview"
                }
                aria-label={
                  previewFullscreen
                    ? "Exit full screen"
                    : "Full screen preview"
                }
              >
                {previewFullscreen ? (
                  <Minimize2 size={20} />
                ) : (
                  <Maximize2 size={20} />
                )}
              </button>
              {canEdit ? (
                <button
                  type="button"
                  className={`absolute top-3 right-3 z-20 p-3 rounded-full border ${
                    editOpen
                      ? "border-neon/80 bg-neon/10 text-neon"
                      : "border-neon/60 text-neon hover:bg-neon/15"
                  }`}
                  onClick={() => {
                    if (editBusy) return;

                    if (!editOpen) {
                      setEditDraft("");
                      setEditOpen(true);
                      return;
                    }

                    // Open: icon = X when empty, Send when typed.
                    const trimmed = editDraft.trim();
                    if (!trimmed) {
                      setEditDraft("");
                      setEditOpen(false);
                      return;
                    }

                    void (async () => {
                      const t = trimmed;
                      await submitEditDraft(t);
                      setEditDraft("");
                      setEditOpen(false);
                    })();
                  }}
                  title="Edit this artifact in the preview"
                  aria-label="Edit this artifact"
                >
                  <Pencil
                    size={20}
                    className={!editOpen ? "block" : "hidden"}
                  />
                  <X
                    size={20}
                    className={editOpen && !editDraft.trim() ? "block" : "hidden"}
                  />
                  <SendHorizontal
                    size={20}
                    className={editOpen && editDraft.trim() ? "block" : "hidden"}
                  />
                </button>
              ) : null}

              {canEdit ? (
                <div className="absolute top-3 left-0 right-0 z-10 flex justify-center pl-16 pr-16">
                  <div className="w-full max-w-[720px]">
                    <ArtifactPreviewEditBar
                      open={editOpen}
                      busy={editBusy}
                      draft={editDraft}
                      onDraftChange={(v) => setEditDraft(v)}
                      onSubmit={(t) =>
                        void (async () => {
                          await submitEditDraft(t);
                          setEditDraft("");
                          setEditOpen(false);
                        })()
                      }
                    />
                  </div>
                </div>
              ) : null}

              {canEdit && (editMessages.length > 0 || editBusy) ? (
                <div className="absolute bottom-3 left-3 right-16 z-20 max-w-[420px] flex flex-col gap-2">
                  <ArtifactImagePicker />
                  <ArtifactPreviewEditLog
                    messages={editMessages}
                    busy={editBusy}
                    onClear={() => setEditMessages([])}
                  />
                </div>
              ) : (
                <div className="absolute bottom-3 left-3 right-16 z-20 max-w-[420px]">
                  <ArtifactImagePicker />
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 text-sm text-txt-muted">Waiting for HTML…</div>
          )}
        </div>
      </div>
    </aside>
  );
}
