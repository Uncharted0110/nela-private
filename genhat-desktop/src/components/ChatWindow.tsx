import React, { useState, useEffect, useRef, memo, useCallback, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { X, Wrench } from "lucide-react";
import MarkdownRenderer from "./MarkdownRenderer";
import type { ChatMessage, MediaAsset, IngestionStatus, ChatMode, ChatSession } from "../types";
import { COPY } from "../app/copy";
import { isSpreadsheetPath } from "../app/spreadsheetDashboardIntent";
import {
  attachmentFileName,
  attachmentKindLabel,
  formatAttachmentSize,
} from "../app/attachmentDisplay";
import { useAdvancedMode } from "../hooks/useAdvancedMode";
import { useSlashCommandInput } from "../hooks/useSlashCommandInput";
import SlashCommandMenu from "./SlashCommandMenu";
import { SlashHighlightedText } from "./SlashHighlightedText";
import type { GenerationProgressMode } from "../app/generationProgress";
import { useCloudStore } from "../stores/cloudStore";
import { useChatModeStore } from "../stores/chatModeStore";
import { useArtifactStreamStore } from "../stores/artifactStreamStore";
import ChatMessageItem, { GenerationTimer } from "./ChatMessageItem";
import ReasoningDisclosure from "./ReasoningDisclosure";
import { scrubChatArtifactProtocol } from "../app/streamArtifactParser";
import "./ModeBanner.css";
import "./WebSearchDisclosure.css";

function chatModeToProgressMode(mode: string): GenerationProgressMode {
  if (mode === "vision") return "vision";
  if (mode === "rag") return "rag";
  if (mode === "mindmap") return "mindmap";
  return "chat";
}

function looksLikeArtifactDump(text: string): boolean {
  // Scrub protocol leaks first — a single bad tag line must not hide a useful reply.
  const scrubbed = scrubChatArtifactProtocol(text).trim();
  if (!scrubbed) return true;
  return (
    /Generated artifact successfully/i.test(scrubbed) ||
    /Created artifact:/i.test(scrubbed) ||
    /<!DOCTYPE\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(scrubbed) ||
    scrubbed.includes("/tmp/nela_artifacts") ||
    // Partial stream crumbs ("<h", "<div…") must never render as the reply.
    /^<\/?[a-zA-Z!]/.test(scrubbed)
  );
}

interface ChatWindowProps {
  messages: ChatMessage[];
  streamingContent: string;
  isLoading: boolean;
  onSend: (text: string) => void;
  onRetry?: (assistantMsgIndex: number) => void;
  onCancel?: () => void;
  cancelled?: boolean;
  audioSrc?: string;
  audioOutputs?: string[];
  placeholder?: string;
  mediaAssets?: Record<number, MediaAsset[]>;
  chatMode?: string;
  ttsGenerating?: boolean;
  ttsElapsedTime?: number;
  ttsGenerationTime?: number | null;
  generalGenerating?: boolean;
  generalElapsedTime?: number;
  generalGenerationTime?: number | null;
  ragDocs?: IngestionStatus[];
  ragIngesting?: boolean;
  enrichmentStatus?: string | null;
  ragEnabled?: boolean;
  onToggleRagEnabled?: (enabled: boolean) => void;
  webEnabled?: boolean;
  onToggleWebEnabled?: (enabled: boolean) => void;
  fileIndexerEnabled?: boolean;
  onToggleFileIndexerEnabled?: (enabled: boolean) => void;
  onIngestFile?: () => void;
  onIngestDir?: () => void;
  onAttachDirectDocuments?: () => void;
  directDocumentPaths?: string[];
  onRemoveDirectDocument?: (path: string) => void;
  onClearDirectDocuments?: () => void;
  onSelectVisionImage?: () => void;
  visionImagePath?: string | null;
  visionImagePreview?: string | null;
  onClearVisionImage?: () => void;
  onToggleDocPanel?: () => void;
  showRagControls?: boolean;
  docPanelOpen?: boolean;
  modeOptions?: { mode: ChatMode; label: string }[];
  currentMode?: ChatMode;
  onSelectMode?: (mode: ChatMode) => void;
  modeSwitchNotice?: string | null;
  streamingThinking?: string;
  thinkingEnabled?: boolean;
  onToggleThinking?: () => void;
  saveAudioToSidebar?: (msgIdx: number) => void;
  session?: ChatSession;
}
const ChatWindow: React.FC<ChatWindowProps> = memo(({
  messages,
  streamingContent,
  isLoading,
  onSend,
  onRetry,
  onCancel,
  cancelled = false,
  placeholder = COPY.slashCommandsHint,
  mediaAssets = {},
  chatMode = "text",
  ttsGenerating = false,
  ttsElapsedTime = 0,
  generalGenerating = false,
  generalGenerationTime = null,
  ragDocs = [],
  ragIngesting = false,
  enrichmentStatus = null,
  ragEnabled = false,
  onToggleRagEnabled,
  webEnabled = true,
  onToggleWebEnabled,
  fileIndexerEnabled = true,
  onToggleFileIndexerEnabled,
  onIngestFile,
  onIngestDir,
  onAttachDirectDocuments,
  directDocumentPaths = [],
  onRemoveDirectDocument,
  onClearDirectDocuments,
  onSelectVisionImage,
  visionImagePath = null,
  visionImagePreview = null,
  onClearVisionImage,
  onToggleDocPanel,
  showRagControls = false,
  docPanelOpen = false,
  modeSwitchNotice = null,
  saveAudioToSidebar = () => {},
  streamingThinking = "",
  thinkingEnabled = false,
  onToggleThinking,
  session,
}) => {
  const { advanced } = useAdvancedMode();
  const preferredMode = useCloudStore((s) => s.preferredMode);
  const liveToolStatus = useChatModeStore((s) => s.liveToolStatus);
  const attachmentMetaByPath = useChatModeStore((s) => s.attachmentMetaByPath);
  const pdfEngineByPath = useChatModeStore((s) => s.pdfEngineByPath);
  const liveStreamHasBody = useArtifactStreamStore(
    (s) => s.active && Boolean(s.html || s.csv)
  );
  const modeChatBorderClass =
    preferredMode !== "local" ? "mode-chat-border--cloud" : "mode-chat-border--private";
  const [inputObj, setInputObj] = useState("");
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [previewModal, setPreviewModal] = useState<{ src: string; title: string } | null>(null);
  const onOpenPreview = useCallback((src: string, title: string) => {
    setPreviewModal({ src, title });
  }, []);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightMirrorRef = useRef<HTMLDivElement>(null);
  const messagesParentRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  /** Tracks the number of messages that have already been rendered and animated.
   *  Only messages at index >= this value get the entrance animation.
   *  We use state (not a ref) so ESLint doesn't flag .current reads during render. */
  const [prevMsgCount, setPrevMsgCount] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: track previous render's msg count
    setPrevMsgCount(messages.length);
  }, [messages.length]);

  /** O(n) previous-user lookup for retry (avoids O(n²) scan inside the list). */
  const retryTextByIndex = useMemo(() => {
    const out: Array<string | null> = new Array(messages.length);
    let lastUser: string | null = null;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      out[i] = m.role === "assistant" ? lastUser : null;
      if (m.role === "user" && m.content.trim()) {
        lastUser = m.content;
      }
    }
    return out;
  }, [messages]);

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => messagesParentRef.current,
    estimateSize: () => 180,
    overscan: 5,
    getItemKey: (index) => messages[index]?.id ?? `msg-${index}`,
  });
  const virtualTotalSize = rowVirtualizer.getTotalSize();

  // Track whether the user is near the bottom so we don't yank scroll while they read up.
  useEffect(() => {
    const el = messagesParentRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < 140;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    // Follow the live bubble while tokens stream. While only thinking/loading,
    // respect the user if they scrolled up to read history.
    if (!streamingContent && !stickToBottomRef.current) return;
    const el = messagesParentRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages.length, streamingContent, streamingThinking, isLoading, virtualTotalSize]);

  // Close composer menus while a response is generating.
  if (isLoading && (showAttachMenu || showToolsMenu)) {
    setShowAttachMenu(false);
    setShowToolsMenu(false);
  }

  // Close attach menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setShowAttachMenu(false);
      }
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(e.target as Node)) {
        setShowToolsMenu(false);
      }
    };
    if (showAttachMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    if (showToolsMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showAttachMenu, showToolsMenu]);

  const slash = useSlashCommandInput({
    value: inputObj,
    onChange: setInputObj,
    textareaRef,
    enabled: chatMode === "text",
  });

  useEffect(() => {
    const ta = textareaRef.current;
    const mirror = highlightMirrorRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(Math.max(ta.scrollHeight, 40), 200);
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > 200 ? "auto" : "hidden";
    if (mirror) {
      mirror.style.height = `${next}px`;
    }
  }, [inputObj]);

  const handleSend = () => {
    if (!inputObj.trim() || isLoading) return;
    onSend(inputObj);
    setInputObj("");
    slash.closeMenu();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    slash.handleKeyDown(e, () => {
      if (!isLoading) handleSend();
    });
  };

  const renderChatTextarea = () => (
    <div className="relative flex-1 min-w-0">
      {slash.showMenu && (
        <SlashCommandMenu
          commands={slash.filteredCommands}
          activeIndex={slash.activeIndex}
          onSelect={slash.applyCommand}
        />
      )}
      <div className="relative">
        {/* Highlight mirror — colored /commands behind transparent textarea text */}
        <div
          ref={highlightMirrorRef}
          aria-hidden
          className="slash-input-highlight text-[0.92rem] py-2 px-1 min-h-[40px] max-h-[200px] leading-relaxed font-inherit"
        >
          {inputObj ? (
            <SlashHighlightedText text={inputObj} variant="overlay" />
          ) : (
            "\u00a0"
          )}
        </div>
        <textarea
          ref={textareaRef}
          value={inputObj}
          onChange={(e) => {
            slash.handleChange(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onClick={slash.syncCursor}
          onSelect={slash.syncCursor}
          onKeyUp={slash.syncCursor}
          onScroll={() => {
            const ta = textareaRef.current;
            const mirror = highlightMirrorRef.current;
            if (ta && mirror) {
              mirror.scrollTop = ta.scrollTop;
              mirror.scrollLeft = ta.scrollLeft;
            }
          }}
          placeholder={placeholder}
          rows={1}
          className="slash-input-textarea w-full border-none outline-none text-[0.92rem] py-2 px-1 min-h-[40px] max-h-[200px] resize-none leading-relaxed font-inherit placeholder:text-txt-muted overflow-hidden"
          data-tour="chat-input"
        />
      </div>
    </div>
  );

  const hasMessages = messages.length > 0 || isLoading;
  const showAttachButton = showRagControls || chatMode === "vision";
  const visionFileName = visionImagePath ? visionImagePath.split(/[/\\]/).pop() ?? "image" : "image";
  const canToggleThinking = Boolean(onToggleThinking);
  const canToggleRag = chatMode === "text" && Boolean(onToggleRagEnabled);
  const canToggleWeb = chatMode === "text" && Boolean(onToggleWebEnabled);
  const canToggleFileIndexer = chatMode === "text" && Boolean(onToggleFileIndexerEnabled);

  const renderToolsMenu = () => {
    return (
      <div className="animate-attach-menu absolute bottom-full right-0 mb-2 w-[220px] rounded-xl bg-void-700/90 backdrop-blur-xl border border-glass-border shadow-[0_8px_32px_rgba(0,0,0,0.5)] p-2 z-50">
        <div className="flex flex-col gap-2">
          {advanced && (
            <button
              className={`w-full flex items-center justify-between gap-2 py-2 px-2.5 rounded-lg text-sm transition-all duration-150 ${
                ragEnabled
                  ? "bg-neon-subtle text-neon"
                  : "text-txt-secondary hover:bg-glass-hover hover:text-txt"
              } ${canToggleRag ? "" : "opacity-50 cursor-not-allowed"}`}
              onClick={() => {
                if (!canToggleRag) return;
                onToggleRagEnabled?.(!ragEnabled);
              }}
              title={canToggleRag ? COPY.toolSearchDocsHint : "Available when chatting"}
              disabled={!canToggleRag}
              aria-label={COPY.toolSearchDocs}
            >
              <span className="text-[0.78rem] font-medium">{COPY.toolSearchDocs}</span>
              <span
                className={`relative inline-flex h-4 w-8 rounded-full transition-colors ${
                  ragEnabled ? "bg-neon" : "bg-void-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                    ragEnabled ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
          )}

          <div className={`w-full rounded-lg ${canToggleWeb ? "" : "opacity-50 cursor-not-allowed"}`}>
            <button
              className={`w-full flex items-center justify-between gap-2 py-2 px-2.5 rounded-lg text-sm transition-all duration-150 ${
                webEnabled
                  ? "bg-neon-subtle text-neon"
                  : "text-txt-secondary hover:bg-glass-hover hover:text-txt"
              } ${canToggleWeb ? "" : "opacity-50 cursor-not-allowed"}`}
              onClick={() => {
                if (!canToggleWeb) return;
                onToggleWebEnabled?.(!webEnabled);
              }}
              title={canToggleWeb ? COPY.toolSearchWebHint : "Available when chatting"}
              disabled={!canToggleWeb}
              aria-label={COPY.toolSearchWeb}
            >
              <span className="text-[0.78rem] font-medium">{COPY.toolSearchWeb}</span>
              <span
                className={`relative inline-flex h-4 w-8 rounded-full transition-colors ${
                  webEnabled ? "bg-neon" : "bg-void-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                    webEnabled ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
          </div>

          <button
            className={`w-full flex items-center justify-between gap-2 py-2 px-2.5 rounded-lg text-sm transition-all duration-150 ${
              fileIndexerEnabled
                ? "bg-neon-subtle text-neon"
                : "text-txt-secondary hover:bg-glass-hover hover:text-txt"
            } ${canToggleFileIndexer ? "" : "opacity-50 cursor-not-allowed"}`}
            onClick={() => {
              if (!canToggleFileIndexer) return;
              onToggleFileIndexerEnabled?.(!fileIndexerEnabled);
            }}
            title={canToggleFileIndexer ? COPY.toolSearchFilesHint : "Available when chatting"}
            disabled={!canToggleFileIndexer}
            aria-label={COPY.toolSearchFiles}
          >
            <span className="text-[0.78rem] font-medium">{COPY.toolSearchFiles}</span>
            <span
              className={`relative inline-flex h-4 w-8 rounded-full transition-colors ${
                fileIndexerEnabled ? "bg-neon" : "bg-void-700"
              }`}
            >
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                  fileIndexerEnabled ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </span>
          </button>

          {advanced && (
            <button
              className={`w-full flex items-center justify-between gap-2 py-2 px-2.5 rounded-lg text-sm transition-all duration-150 ${
                thinkingEnabled
                  ? "bg-neon-subtle text-neon"
                  : "text-txt-secondary hover:bg-glass-hover hover:text-txt"
              } ${canToggleThinking ? "" : "opacity-50 cursor-not-allowed"}`}
              onClick={() => {
                if (!canToggleThinking) return;
                onToggleThinking?.();
              }}
              title={canToggleThinking ? COPY.toolShowReasoningHint : "Available when chatting"}
              disabled={!canToggleThinking}
              aria-label={COPY.toolShowReasoning}
            >
              <span className="text-[0.78rem] font-medium">{COPY.toolShowReasoning}</span>
              <span
                className={`relative inline-flex h-4 w-8 rounded-full transition-colors ${
                  thinkingEnabled ? "bg-neon" : "bg-void-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                    thinkingEnabled ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderAttachMenu = () => {
    if (chatMode === "vision") {
      return (
        <button
          className="w-full flex items-center gap-2.5 py-2 px-3 rounded-lg text-sm text-txt-secondary bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-glass-hover hover:text-txt"
          onClick={() => {
            onSelectVisionImage?.();
            setShowAttachMenu(false);
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          <div className="flex flex-col items-start">
            <span className="font-medium">{COPY.uploadImageTitle}</span>
            <span className="text-[0.78rem] text-txt-muted">{COPY.uploadImageHint}</span>
          </div>
        </button>
      );
    }

    const attachToChatButton = (
      <button
        className="w-full flex items-center gap-2.5 py-2 px-3 rounded-lg text-sm text-txt-secondary bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-glass-hover hover:text-txt"
        onClick={() => {
          onAttachDirectDocuments?.();
          setShowAttachMenu(false);
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        <div className="flex flex-col items-start">
          <span className="font-medium">{COPY.attachToChatTitle}</span>
          <span className="text-[0.78rem] text-txt-muted">{COPY.attachToChatHint}</span>
        </div>
      </button>
    );

    const libraryButtons = (
      <>
        <button
          className="w-full flex items-center gap-2.5 py-2 px-3 rounded-lg text-sm text-txt-secondary bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-glass-hover hover:text-txt"
          onClick={() => {
            onIngestFile?.();
            setShowAttachMenu(false);
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <div className="flex flex-col items-start">
            <span className="font-medium">{COPY.addToLibraryTitle}</span>
            <span className="text-[0.78rem] text-txt-muted">{COPY.addToLibraryHint}</span>
          </div>
        </button>
        <button
          className="w-full flex items-center gap-2.5 py-2 px-3 rounded-lg text-sm text-txt-secondary bg-transparent border-none cursor-pointer transition-all duration-150 hover:bg-glass-hover hover:text-txt"
          onClick={() => {
            onIngestDir?.();
            setShowAttachMenu(false);
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <div className="flex flex-col items-start">
            <span className="font-medium">{COPY.addFolderTitle}</span>
            <span className="text-[0.78rem] text-txt-muted">{COPY.addFolderHint}</span>
          </div>
        </button>
      </>
    );

    if (chatMode === "text") {
      const showLibrary = !advanced || ragEnabled;
      return (
        <>
          {attachToChatButton}
          {showLibrary ? libraryButtons : null}
        </>
      );
    }

    return libraryButtons;
  };

  const attachButtonLabel =
    chatMode === "vision" ? COPY.uploadImageTitle : COPY.addDocumentsTitle;

  const renderVisionAttachment = () => {
    if (chatMode !== "vision" || !visionImagePreview) return null;

    return (
      <div className="w-full mb-2">
        <div className="inline-flex items-center gap-2 py-1.5 pl-1.5 pr-2 rounded-xl bg-void-700 border border-glass-border max-w-full">
          <button
            className="shrink-0 w-11 h-11 rounded-lg overflow-hidden border border-glass-border hover:border-neon transition-colors duration-150"
            onClick={() => {
              setPreviewModal({ src: visionImagePreview, title: visionFileName });
            }}
            title="Preview image"
          >
            <img src={visionImagePreview} alt="Vision attachment" className="w-full h-full object-cover" />
          </button>
          <button
            className="text-[0.8rem] text-txt-secondary max-w-[180px] truncate text-left hover:text-txt"
            onClick={() => {
              setPreviewModal({ src: visionImagePreview, title: visionFileName });
            }}
            title={visionFileName}
          >
            {visionFileName}
          </button>
          <button
            className="ml-1 w-6 h-6 inline-flex items-center justify-center rounded-md text-txt-muted hover:text-danger hover:bg-danger/10"
            onClick={onClearVisionImage}
            title="Remove image"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  const renderDirectDocumentAttachments = () => {
    if (chatMode !== "text" || directDocumentPaths.length === 0) return null;
    const spreadsheetAttached = directDocumentPaths.some(isSpreadsheetPath);
    const destination = preferredMode === "local" ? COPY.attachLocalDestination : COPY.attachCloudDestination;

    return (
      <div className="w-full mb-2 min-w-0">
        <div className="flex items-start gap-2 mb-1.5">
          <span className="text-[0.78rem] text-txt-muted">
            Attached files ({directDocumentPaths.length})
          </span>
          <button
            className="text-[0.78rem] text-txt-muted hover:text-danger"
            onClick={onClearDirectDocuments}
            title="Clear all attached documents"
            aria-label="Clear all attached documents"
          >
            Clear all
          </button>
        </div>
        {preferredMode !== "local" ? (
          <p className="mt-0 mb-1.5 text-[0.75rem] text-txt-muted">
            {COPY.attachCloudDisclosure}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5 min-w-0">
          {directDocumentPaths.map((path) => {
            const meta = attachmentMetaByPath[path];
            const name = attachmentFileName(path, meta?.name);
            const kindLabel = attachmentKindLabel({
              name,
              mime: meta?.mime,
              kind: meta?.kind,
            });
            const sizeLabel = formatAttachmentSize(meta?.sizeBytes);
            const spreadsheet = isSpreadsheetPath(path);
            const isPdf = meta?.kind === "pdf" || name.toLowerCase().endsWith(".pdf");
            const scanned = pdfEngineByPath[path] === "mistral-ocr";
            return (
              <span
                key={path}
                className="inline-flex items-center gap-1.5 py-1 px-2 rounded-lg bg-void-700 border border-glass-border text-[0.78rem] text-txt-secondary min-w-0 max-w-full overflow-hidden"
                title={path}
              >
                <span className="truncate font-medium min-w-0">{name}</span>
                <span className="shrink-0 text-txt-muted">
                  · {destination} · {kindLabel}
                  {sizeLabel ? ` · ${sizeLabel}` : ""}
                </span>
                {spreadsheet ? (
                  <span className="shrink-0 text-txt-muted">· spreadsheet</span>
                ) : null}
                {meta?.error ? (
                  <span className="shrink-0 text-danger truncate max-w-[10rem]">{meta.error}</span>
                ) : null}
                {isPdf && preferredMode !== "local" ? (
                  <button
                    className={`shrink-0 text-[0.7rem] ${scanned ? "text-txt" : "text-txt-muted"}`}
                    onClick={() =>
                      useChatModeStore.getState().setPdfEngineForPath(
                        path,
                        scanned ? "cloudflare-ai" : "mistral-ocr"
                      )
                    }
                    title={COPY.attachScannedPdf}
                  >
                    {scanned ? "OCR on" : "OCR"}
                  </button>
                ) : null}
                <button
                  className="w-4 h-4 inline-flex items-center justify-center rounded text-txt-muted hover:text-danger shrink-0"
                  onClick={() => onRemoveDirectDocument?.(path)}
                  title="Remove document"
                  aria-label={`Remove ${name}`}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </span>
            );
          })}
        </div>
        {spreadsheetAttached ? (
          <p className="mt-1.5 mb-0 text-[0.75rem] text-txt-muted">
            Ask for a dashboard or charts from this file.
          </p>
        ) : null}
      </div>
    );
  };

  // ─── Centered Welcome State (Claude/Copilot style) ───
  if (!hasMessages) {
    const SUGGESTIONS: Array<{ title: string; prompt: string }> = [
      { title: "Summarize a document", prompt: "Summarize the key points in my document." },
      { title: "Find an answer", prompt: "Answer this question using my documents: " },
      { title: "Draft an email", prompt: "Draft a professional email about: " },
    ];

    return (
      <div className="h-full flex-1 flex flex-col items-center justify-center relative px-6">
        {/* Animated orb */}
        <div className="welcome-orb" />

        {/* Brand & Greeting */}
        <div className="relative z-10 flex flex-col items-center mb-8">
          <img
            src="/logo-dark.png"
            alt="NELA"
            className="w-14 h-14 rounded-2xl object-contain mb-4"
            draggable={false}
          />
          <h2 className="text-2xl font-bold text-txt m-0 mb-1">What would you like to do?</h2>
          <p className="text-[0.95rem] text-txt-muted m-0 text-center max-w-md">
            {COPY.welcomeHint}
          </p>
          <p className="text-[0.85rem] text-txt-muted/80 m-0 mt-1">
            Ask a question, or add documents with the <strong>+</strong> button.
          </p>
        </div>

        {/* Centered Input */}
        <div className="relative z-10 w-full max-w-2xl">
          <div className="flex flex-wrap justify-center gap-2 mb-3">
              {SUGGESTIONS.map((s) => (
              <button
                key={s.title}
                type="button"
                className="px-3 py-1.5 rounded-full border border-glass-border bg-glass-bg text-[0.82rem] text-txt-secondary hover:text-txt hover:bg-glass-hover transition-colors"
                onClick={() => {
                  setInputObj(s.prompt);
                }}
                aria-label={s.title}
                title={s.title}
              >
                {s.title}
              </button>
            ))}
          </div>

          {/* RAG doc indicators */}
          {showRagControls && (
            <div className="flex items-center gap-2 mb-2 justify-center">
              <button
                className={`glass-btn inline-flex items-center gap-1.5 py-1 px-3 text-[0.78rem] font-medium rounded-full cursor-pointer transition-colors duration-150 border ${docPanelOpen ? "bg-neon-subtle text-neon border-neon/30" : "bg-glass-bg text-txt-secondary border-glass-border hover:text-txt"}`}
                onClick={onToggleDocPanel}
                title="Show or hide your documents"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
                {ragDocs.length > 0 ? `${ragDocs.length} file${ragDocs.length !== 1 ? "s" : ""} loaded` : COPY.libraryTitle}
              </button>
              {ragIngesting && (
                <span className="inline-flex items-center gap-1 text-[0.78rem] text-warning">
                  <svg className="spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                  {COPY.processing}
                </span>
              )}
              {enrichmentStatus && (
                <span className="inline-flex items-center gap-1 text-[0.78rem] text-success">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  {COPY.docStateEnhanced}
                </span>
              )}
            </div>
          )}

          <div className={`input-wrapper glass-strong flex flex-col gap-2 rounded-2xl px-2 py-2 transition-colors duration-150 focus-within:border-neon ${modeChatBorderClass}`}>
            {renderVisionAttachment()}
            {renderDirectDocumentAttachments()}
            <div className="flex items-center gap-2">
            {showAttachButton && (
              <div className="relative" ref={attachMenuRef}>
                <button
                  className="glass-btn flex items-center justify-center w-10 h-10 bg-glass-bg border border-glass-border text-txt-muted cursor-pointer rounded-lg transition-colors duration-150 hover:text-txt disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => {
                    if (isLoading) return;
                    setShowAttachMenu(!showAttachMenu);
                  }}
                  title={attachButtonLabel}
                  aria-label={attachButtonLabel}
                  disabled={isLoading}
                  data-tour="attach-button"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform: showAttachMenu ? "rotate(45deg)" : "none", transition: "transform 0.2s" }}>
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>

                {showAttachMenu && !isLoading && (
                  <div className="animate-attach-menu absolute bottom-full left-0 mb-2 w-[280px] rounded-xl bg-void-700/80 backdrop-blur-xl border border-glass-border shadow-[0_8px_32px_rgba(0,0,0,0.5)] p-1 z-50">
                    {renderAttachMenu()}
                  </div>
                )}
              </div>
            )}

            {renderChatTextarea()}
            <div className="relative" ref={toolsMenuRef}>
              <button
                className="glass-btn flex items-center justify-center w-10 h-10 rounded-lg bg-glass-bg border border-glass-border text-txt-muted cursor-pointer transition-colors duration-150 hover:text-txt disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={() => {
                  if (isLoading) return;
                  setShowToolsMenu((v) => !v);
                }}
                title="Tools"
                aria-label="Tools"
                disabled={isLoading}
                data-tour="tools-button"
              >
                <Wrench size={16} strokeWidth={1.9} />
              </button>

              {showToolsMenu && !isLoading && renderToolsMenu()}
            </div>
                        <button className="send-btn flex items-center justify-center w-10 h-10 rounded-lg bg-neon text-void-900 border border-neon/50 cursor-pointer transition-colors duration-150 hover:bg-neon-hover disabled:opacity-30 disabled:cursor-not-allowed shrink-0" onClick={handleSend} disabled={!inputObj.trim()} aria-label="Send message">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 12H19M19 12L12 5M19 12L12 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            </div>
          </div>
        </div>

        {previewModal && (
          <div className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="relative w-full max-w-6xl h-[90vh] bg-void-800 border border-glass-border rounded-2xl overflow-hidden flex flex-col">
              <div className="h-12 shrink-0 border-b border-glass-border flex items-center justify-between px-3">
                <span className="text-[0.78rem] text-txt-secondary truncate max-w-[75%]" title={previewModal.title}>{previewModal.title}</span>
                <button className="glass-btn w-8 h-8 rounded-lg text-txt-secondary hover:text-danger" onClick={() => setPreviewModal(null)} title="Close">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
              <div className="flex-1 overflow-hidden flex items-center justify-center p-4 sm:p-6">
                <img
                  src={previewModal.src}
                  alt="Vision preview"
                  className="max-w-full max-h-full object-contain"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Normal Chat State ───
  return (
    <div className="h-full flex-1 flex flex-col min-h-0">
      <div
        ref={messagesParentRef}
        className="messages-area flex-1 overflow-y-auto px-6 py-4"
      >
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const idx = virtualRow.index;
            const msg = messages[idx];
            if (!msg) return null;
            const isLast = idx === messages.length - 1;
            return (
              <div
                key={virtualRow.key}
                data-index={idx}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <ChatMessageItem
                  msg={msg}
                  idx={idx}
                  isNew={idx >= prevMsgCount}
                  isLast={isLast}
                  advanced={advanced}
                  mediaForMsg={mediaAssets[idx]}
                  liveToolStatus={isLast ? liveToolStatus : null}
                  sessionId={session?.id}
                  sessionArtifactPath={session?.artifactPath}
                  sessionArtifactPanelOpen={session?.artifactPanelOpen}
                  sessionStreamingArtifactTitle={
                    isLast ? session?.streamingArtifactTitle : undefined
                  }
                  sessionStreamingArtifactType={
                    isLast
                      ? session?.streamingArtifactType
                      : msg.streamingArtifactType
                  }
                  hasLiveStreamBody={
                    isLast &&
                    Boolean(
                      liveStreamHasBody ||
                        session?.streamingArtifactHtml ||
                        session?.streamingArtifactCsv
                    )
                  }
                  retryText={retryTextByIndex[idx] ?? null}
                  isLoading={isLoading}
                  onSend={onSend}
                  onRetry={onRetry}
                  saveAudioToSidebar={saveAudioToSidebar}
                  onOpenPreview={onOpenPreview}
                />
              </div>
            );
          })}
        </div>

        {isLoading &&
          !messages.some(
            (m) =>
              m.artifactStage &&
              m.artifactStage !== "LivePreview" &&
              m.artifactStage !== "Error"
          ) && (
          <div className="flex gap-3 mb-5 max-w-3xl mx-auto">
            <img
              src="/logo-dark.png"
              alt="NELA"
              className="w-8 h-8 rounded-xl object-contain shrink-0 shadow-[0_2px_10px_rgba(0,212,255,0.2)]"
              draggable={false}
            />
            <div className="flex-1 min-w-0 text-[0.9rem] leading-relaxed text-txt glass rounded-2xl rounded-tl-sm py-3 px-4">
              {liveToolStatus && (
                <div className="web-search-live" role="status">
                  <span className="web-search-live__pulse" aria-hidden />
                  <span>{liveToolStatus}</span>
                </div>
              )}
              {streamingThinking.trim() ? (
                <ReasoningDisclosure thinking={streamingThinking} streaming />
              ) : null}
              {streamingContent && !looksLikeArtifactDump(streamingContent) ? (
                <MarkdownRenderer
                  content={scrubChatArtifactProtocol(streamingContent)}
                  streaming
                />
              ) : !streamingThinking.trim() ? (
                !liveToolStatus || looksLikeArtifactDump(streamingContent) ? (
                  <GenerationTimer
                    active
                    mode={
                      session?.artifactStreamActive
                        ? "artifact"
                        : chatModeToProgressMode(chatMode)
                    }
                  />
                ) : null
              ) : null}
            </div>
          </div>
        )}

        {/* Response Time Timer - Audio Mode */}
        {chatMode === "audio" && ttsGenerating && (
          <div className="flex items-center gap-2 py-1.5 px-3 rounded-full bg-neon-subtle border border-neon/20 max-w-3xl mx-auto text-sm text-txt-secondary">
            <div className="tts-timer-pulse" />
            <span>Generating speech... <span className="text-neon font-semibold tabular-nums">{ttsElapsedTime.toFixed(1)}s</span></span>
          </div>
        )}

        {/* Audio Player (legacy block removed; now only rendered inline after assistant messages) */}

        {/* Response time completion (advanced only; keeps simple mode calmer) */}
        {advanced && chatMode !== "audio" && generalGenerationTime !== null && !generalGenerating && (
          <div className="flex items-center gap-1.5 py-1 px-3 rounded-full max-w-3xl mx-auto text-[0.78rem] text-success">
            <span>✓</span>
            <span>
              {chatMode === "vision" && `Analyzed in ${generalGenerationTime.toFixed(1)}s`}
              {chatMode === "rag" && `Processed in ${generalGenerationTime.toFixed(1)}s`}
              {chatMode === "text" && `Generated in ${generalGenerationTime.toFixed(1)}s`}
              {chatMode === "mindmap" && `Mindmap built in ${generalGenerationTime.toFixed(1)}s`}
            </span>
          </div>
        )}

        {/* Cancelled notice */}
        {cancelled && (
          <div className="text-center py-1.5 text-[0.78rem] text-txt-muted">⏹ Response stopped</div>
        )}

        {/* Mode switch notice */}
        {modeSwitchNotice && (
          <div className="text-center py-1.5 text-[0.78rem] text-txt-muted">{modeSwitchNotice}</div>
        )}

        <div ref={endRef} />
      </div>

      {/* ── Input Area ── */}
      <div className="px-6 py-3 shrink-0 border-t border-glass-border bg-void-900">
        {chatMode === "text" &&
        session?.artifactPath &&
        session?.artifactStage === "LivePreview" ? (
          <p className="max-w-3xl mx-auto mb-2 text-[0.72rem] text-txt-muted">
            Edits apply to the open artifact
            {session.artifactPanelOpen ? "" : " (panel closed — still editable from here)"}
            . Use the pencil for advanced element select.
          </p>
        ) : null}
        {/* RAG doc indicators */}
        {showRagControls && (
          <div className="flex items-center gap-2 mb-2 max-w-3xl mx-auto">
            <button
              className={`glass-btn inline-flex items-center gap-1.5 py-1 px-3 text-[0.78rem] font-medium rounded-full cursor-pointer transition-all duration-200 border backdrop-blur-md ${docPanelOpen ? "bg-neon-subtle text-neon border-neon/30 shadow-[0_0_12px_rgba(0,212,255,0.12)]" : "bg-glass-bg text-txt-secondary border-glass-border hover:border-neon hover:text-neon hover:shadow-[0_0_12px_rgba(0,212,255,0.08)]"}`}
              onClick={onToggleDocPanel}
              title="Show or hide your documents"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              {ragDocs.length > 0 ? `${ragDocs.length} file${ragDocs.length !== 1 ? "s" : ""} loaded` : COPY.libraryTitle}
            </button>
            {ragIngesting && (
              <span className="inline-flex items-center gap-1 text-[0.78rem] text-warning">
                <svg className="spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                {COPY.processing}
              </span>
            )}
            {enrichmentStatus && (
              <span className="inline-flex items-center gap-1 text-[0.78rem] text-success">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                {COPY.docStateEnhanced}
              </span>
            )}
          </div>
        )}

          <div className={`input-wrapper glass-strong flex flex-col gap-2 rounded-2xl px-2 py-2 max-w-3xl mx-auto transition-all duration-200 shadow-[0_4px_24px_rgba(0,0,0,0.3)] focus-within:border-neon focus-within:shadow-[0_0_24px_rgba(0,212,255,0.15),0_4px_24px_rgba(0,0,0,0.3)] ${modeChatBorderClass}`}>
            {renderVisionAttachment()}
            {renderDirectDocumentAttachments()}
            <div className="flex items-center gap-2">
          {showAttachButton && (
            <div className="relative" ref={attachMenuRef}>
              <button
                className="glass-btn flex items-center justify-center w-10 h-10 bg-glass-bg border border-glass-border text-txt-muted cursor-pointer rounded-lg transition-all duration-200 backdrop-blur-sm hover:text-neon hover:border-neon/30 hover:shadow-[0_0_8px_rgba(0,212,255,0.1)] disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={() => {
                  if (isLoading) return;
                  setShowAttachMenu(!showAttachMenu);
                }}
                title={attachButtonLabel}
                aria-label={attachButtonLabel}
                disabled={isLoading}
                data-tour="attach-button"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  style={{ transform: showAttachMenu ? "rotate(45deg)" : "none", transition: "transform 0.2s" }}>
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>

              {showAttachMenu && !isLoading && (
                <div className="animate-attach-menu absolute bottom-full left-0 mb-2 w-[280px] rounded-xl bg-void-700/80 backdrop-blur-xl border border-glass-border shadow-[0_8px_32px_rgba(0,0,0,0.5)] p-1 z-50">
                  {renderAttachMenu()}
                </div>
              )}
            </div>
          )}

          {renderChatTextarea()}
                    <div className="relative" ref={toolsMenuRef}>
            <button
              className="glass-btn flex items-center justify-center w-10 h-10 rounded-lg bg-glass-bg border border-glass-border text-txt-muted cursor-pointer transition-all duration-200 hover:text-neon hover:border-neon/30 hover:shadow-[0_0_10px_rgba(0,212,255,0.12)] disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => {
                if (isLoading) return;
                setShowToolsMenu((v) => !v);
              }}
              title="Tools"
              aria-label="Tools"
              disabled={isLoading}
              data-tour="tools-button"
            >
              <Wrench size={16} strokeWidth={1.9} />
            </button>

            {showToolsMenu && !isLoading && renderToolsMenu()}
          </div>
          {isLoading ? (
            <button className="flex items-center justify-center w-10 h-10 rounded-lg bg-danger/80 backdrop-blur-sm text-white border border-danger/30 cursor-pointer transition-all duration-200 shadow-[0_0_12px_rgba(248,113,113,0.2)] hover:bg-danger hover:shadow-[0_0_20px_rgba(248,113,113,0.3)] shrink-0" onClick={onCancel} title="Stop generation" aria-label="Stop response">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
            </button>
          ) : (
            <button className="send-btn flex items-center justify-center w-10 h-10 rounded-lg bg-neon text-void-900 border border-neon/50 cursor-pointer transition-all duration-200 shadow-[0_0_16px_rgba(0,212,255,0.2)] hover:bg-neon-hover hover:shadow-[0_0_24px_rgba(0,212,255,0.35)] disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none shrink-0" onClick={handleSend} disabled={!inputObj.trim()} aria-label="Send message">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 12H19M19 12L12 5M19 12L12 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          </div>
        </div>
      </div>

      {previewModal && (
        <div className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="relative w-full max-w-6xl h-[90vh] bg-void-800 border border-glass-border rounded-2xl overflow-hidden flex flex-col">
            <div className="h-12 shrink-0 border-b border-glass-border flex items-center justify-between px-3">
              <span className="text-[0.78rem] text-txt-secondary truncate max-w-[75%]" title={previewModal.title}>{previewModal.title}</span>
              <button className="flex items-center justify-center w-8 h-8 rounded-lg text-txt-secondary hover:text-danger transition-colors duration-200" onClick={() => setPreviewModal(null)} title="Close">
                <X size={16} strokeWidth={2} />
              </button>
            </div>
            <div className="flex-1 overflow-hidden flex items-center justify-center p-4 sm:p-6">
              <img
                src={previewModal.src}
                alt="Vision preview"
                className="max-w-full max-h-full object-contain"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

ChatWindow.displayName = "ChatWindow";

export default ChatWindow;
