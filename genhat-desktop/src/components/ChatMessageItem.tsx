import React, { useState, useEffect, memo } from "react";
import { RotateCcw } from "lucide-react";
import MarkdownRenderer from "./MarkdownRenderer";
import AudioPlayer from "./AudioPlayer";
import SpeakButton from "./SpeakButton";
import InlineArtifact from "./InlineArtifact";
import ArtifactChip from "./ArtifactChip";
import { Api } from "../api";
import type { ChatMessage, EntitlementResponse, MediaAsset } from "../types";
import { COPY } from "../app/copy";
import { friendlyError } from "../app/friendlyError";
import { SlashHighlightedText } from "./SlashHighlightedText";
import GenerationProgressLabel from "./GenerationProgressLabel";
import WebSearchDisclosure from "./WebSearchDisclosure";
import type { PipelineStageKind } from "./ProgressSlate";
import { scrubChatArtifactProtocol } from "../app/streamArtifactParser";
import { useChatModeStore } from "../stores/chatModeStore";
import { useSessionStore } from "../stores/sessionStore";
import { useCloudStore } from "../stores/cloudStore";
import ReasoningDisclosure from "./ReasoningDisclosure";

function modelHoverLabel(
  model: string,
  creditsRemainingAfter: number | undefined,
  entitlement: EntitlementResponse | null
): { text: string; title: string } {
  const freePlan =
    entitlement?.plan === "free" ||
    entitlement?.displayPlan === "free" ||
    entitlement?.isPremium === false;
  const credits =
    typeof creditsRemainingAfter === "number"
      ? creditsRemainingAfter
      : freePlan && typeof entitlement?.credits?.balance === "number"
        ? entitlement.credits.balance
        : null;
  if (!freePlan || credits === null) {
    return { text: model, title: model };
  }
  const title = `${model} · ${credits} credit${credits === 1 ? "" : "s"} remaining`;
  return { text: `${model} · ${credits} left`, title };
}

function looksLikeArtifactDump(text: string): boolean {
  const scrubbed = scrubChatArtifactProtocol(text).trim();
  if (!scrubbed) return true;
  return (
    /Generated artifact successfully/i.test(scrubbed) ||
    /Created artifact:/i.test(scrubbed) ||
    /<!DOCTYPE\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(scrubbed) ||
    scrubbed.includes("/tmp/nela_artifacts") ||
    /^<\/?[a-zA-Z!]/.test(scrubbed)
  );
}

const GenerationTimer = memo(function GenerationTimer({
  active,
  mode,
  stage,
}: {
  active: boolean;
  mode: "artifact" | "chat" | "vision" | "rag" | "mindmap";
  stage?: PipelineStageKind | null;
}) {
  const elapsedSec = useChatModeStore((s) => s.generalElapsedTime);
  return (
    <GenerationProgressLabel
      active={active}
      mode={mode}
      elapsedSec={elapsedSec}
      stage={stage}
    />
  );
});

export { GenerationTimer };

/** Copy button for a chat message (prompt or response) */
const CopyMsgButton: React.FC<{ text: string; label?: string }> = ({
  text,
  label = "Copy",
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      className="p-1.5 glass border border-glass-border text-txt-muted cursor-pointer rounded-lg transition-colors duration-150 hover:text-neon hover:border-glass-border"
      onClick={handleCopy}
      title={label}
      aria-label={label}
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M20 6L9 17L4 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <rect x="9" y="2" width="6" height="4" rx="1" stroke="currentColor" strokeWidth="2" />
          <path d="M9 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2h-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
};

/** Re-run the prior user prompt that produced this assistant response. */
const RetryMsgButton: React.FC<{
  disabled?: boolean;
  onRetry: () => void;
}> = ({ disabled, onRetry }) => (
  <button
    type="button"
    className="p-1.5 glass border border-glass-border text-txt-muted cursor-pointer rounded-lg transition-colors duration-150 hover:text-neon hover:border-glass-border disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-txt-muted"
    onClick={onRetry}
    disabled={disabled}
    title={COPY.retryPrompt}
    aria-label={COPY.retryPrompt}
  >
    <RotateCcw size={13} strokeWidth={2.25} />
  </button>
);

/** Inline gallery for extracted images/tables attached to an assistant message. */
const MediaGallery: React.FC<{ assets: MediaAsset[] }> = ({ assets }) => {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [dataUrls, setDataUrls] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!assets || assets.length === 0) return;
    let cancelled = false;

    const loadAll = async () => {
      const entries: [number, string][] = [];
      for (const asset of assets) {
        try {
          const dataUrl = await Api.readImageBase64(asset.file_path);
          if (!cancelled) entries.push([asset.id, dataUrl]);
        } catch (e) {
          console.warn(`Failed to load media ${asset.id}:`, e);
        }
      }
      if (!cancelled) {
        setDataUrls(Object.fromEntries(entries));
      }
    };

    loadAll();
    return () => { cancelled = true; };
  }, [assets]);

  if (!assets || assets.length === 0) return null;

  return (
    <div className="mt-2.5 pt-2.5 border-t border-glass-border">
      <div className="text-[0.75rem] text-txt-muted mb-2 font-medium">
        📎 {assets.length} related {assets.length === 1 ? "figure" : "figures"}
      </div>
      <div className="flex flex-wrap gap-2">
        {assets.map((asset) => (
          <div
            key={asset.id}
            className={`media-thumb relative rounded-lg overflow-hidden cursor-pointer transition-all duration-200 border border-glass-border hover:border-neon hover:shadow-md ${expanded === asset.id ? "max-w-full flex-[1_1_100%]" : "max-w-[200px]"}`}
            onClick={() => setExpanded(expanded === asset.id ? null : asset.id)}
          >
            {dataUrls[asset.id] ? (
              <img
                src={dataUrls[asset.id]}
                alt={asset.caption || `${asset.asset_type} from document`}
                loading="lazy"
                className={`block w-full h-auto ${expanded === asset.id ? "" : "max-h-[160px] object-cover"}`}
              />
            ) : (
              <div className="flex items-center justify-center w-[160px] h-[120px] text-txt-muted text-[0.75rem] bg-void-800">Loading…</div>
            )}
            <span className="absolute top-1 right-1 text-[0.78rem] bg-black/60 rounded px-1 py-0.5 leading-none">
              {asset.asset_type === "table" ? "📊" : "🖼️"}
            </span>
            {expanded === asset.id && asset.caption && (
              <div className="p-1.5 px-2 text-[0.78rem] text-txt-muted bg-void-800 leading-snug max-h-[100px] overflow-y-auto">{asset.caption}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

/** Thumbnail renderer for user-uploaded vision images stored on a chat message. */
const VisionMessageImage: React.FC<{
  imagePath: string;
  imageName: string;
  onOpen: (src: string, title: string) => void;
}> = ({ imagePath, imageName, onOpen }) => {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Api.readImageBase64(imagePath)
      .then((src) => {
        if (!cancelled) setPreviewSrc(src);
      })
      .catch((err) => {
        console.warn(`Failed to load vision image preview for ${imagePath}:`, err);
      });

    return () => {
      cancelled = true;
    };
  }, [imagePath]);

  return (
    <button
      className="group block w-[180px] rounded-xl overflow-hidden border border-glass-border bg-void-800/70 hover:border-neon/40 transition-colors"
      onClick={() => previewSrc && onOpen(previewSrc, imageName)}
      title={previewSrc ? `Preview ${imageName}` : imageName}
      disabled={!previewSrc}
    >
      {previewSrc ? (
        <img src={previewSrc} alt={imageName} className="w-full h-[130px] object-cover" />
      ) : (
        <div className="w-full h-[130px] flex items-center justify-center text-[0.78rem] text-txt-muted">Loading image...</div>
      )}
      <div className="px-2.5 py-1.5 text-[0.78rem] text-txt-secondary truncate text-left group-hover:text-txt">
        {imageName}
      </div>
    </button>
  );
};

export interface ChatMessageItemProps {
  msg: ChatMessage;
  idx: number;
  isNew: boolean;
  isLast: boolean;
  advanced: boolean;
  mediaForMsg?: MediaAsset[];
  liveToolStatus: string | null;
  sessionId?: string;
  sessionArtifactPath?: string | null;
  sessionArtifactPanelOpen?: boolean;
  sessionStreamingArtifactTitle?: string;
  sessionStreamingArtifactType?: "text/html" | "text/csv";
  hasLiveStreamBody: boolean;
  retryText: string | null;
  /** True while any generation is in flight (disables retry). */
  isLoading?: boolean;
  onSend: (text: string) => void;
  /** Replace this assistant reply by re-running its prior user prompt. */
  onRetry?: (assistantMsgIndex: number) => void;
  saveAudioToSidebar?: (msgIdx: number) => void;
  onOpenPreview: (src: string, title: string) => void;
}

function ChatMessageItemInner({
  msg,
  idx,
  isNew,
  isLast,
  advanced,
  mediaForMsg,
  liveToolStatus,
  sessionId,
  sessionArtifactPath,
  sessionArtifactPanelOpen,
  sessionStreamingArtifactTitle,
  sessionStreamingArtifactType,
  hasLiveStreamBody,
  retryText,
  isLoading = false,
  onRetry,
  saveAudioToSidebar,
  onOpenPreview,
}: ChatMessageItemProps) {
  const updateSession = useSessionStore((s) => s.updateSession);
  const entitlement = useCloudStore((s) => s.entitlement);
  const canRetry = Boolean(retryText?.trim()) && !isLoading && Boolean(onRetry);
  const runRetry = () => {
    if (!canRetry || !onRetry) return;
    onRetry(idx);
  };
  const modelLabel = msg.generatedByModel
    ? modelHoverLabel(
        msg.generatedByModel,
        msg.creditsRemainingAfter,
        entitlement
      )
    : null;

  return (
              <div className={`${isNew ? "animate-msg-fade" : ""} group/msg flex gap-3 mb-6 max-w-3xl mx-auto ${msg.role === "user" ? "justify-end" : ""}`}>
                {msg.role === "user" ? (
                  <>
                    <div className="flex flex-col items-end flex-1 min-w-0">
                      <div className="py-3 px-4 rounded-2xl rounded-tr-sm text-[0.9rem] leading-relaxed text-txt max-w-[85%] bg-glass-bg border border-glass-border">
                        {msg.visionImage && (
                          <div className="mb-2.5">
                            <VisionMessageImage
                              imagePath={msg.visionImage.path}
                              imageName={msg.visionImage.name}
                              onOpen={(src, title) => {
                                onOpenPreview(src, title);
                              }}
                            />
                          </div>
                        )}
                        {msg.directDocuments && msg.directDocuments.length > 0 && (
                          <div className="mb-2 flex flex-wrap gap-1.5">
                            {msg.directDocuments.map((doc, docIdx) => (
                              <span
                                key={`${doc.path}-${docIdx}`}
                                className="inline-flex items-center gap-1 py-0.5 px-2 rounded-md bg-void-800/70 border border-glass-border text-[0.78rem] text-txt-secondary"
                                title={doc.path}
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                  <polyline points="14 2 14 8 20 8" />
                                </svg>
                                <span className="truncate max-w-[12rem]">{doc.name || doc.path.split(/[/\\]/).pop()}</span>
                              </span>
                            ))}
                          </div>
                        )}
                        {msg.content ? (
                          <SlashHighlightedText text={msg.content} variant="bubble" />
                        ) : null}
                      </div>
                      {msg.content?.trim() ? (
                        <div className="flex items-center gap-1 mt-1.5 mr-0.5">
                          <CopyMsgButton text={msg.content} label="Copy prompt" />
                        </div>
                      ) : null}
                    </div>
                    <div className="w-8 h-8 rounded-xl bg-neon-subtle text-neon flex items-center justify-center shrink-0 border border-neon/15">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 12c2.761 0 5-2.239 5-5s-2.239-5-5-5-5 2.239-5 5 2.239 5 5 5z" fill="currentColor" />
                        <path d="M4 20c0-3.3137 2.6863-6 6-6h4c3.3137 0 6 2.6863 6 6v1H4v-1z" fill="currentColor" />
                      </svg>
                    </div>
                  </>
                ) : (
                  <>
                    <img
                      src="/logo-dark.png"
                      alt="NELA"
                      className="w-8 h-8 rounded-xl object-contain shrink-0"
                      draggable={false}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-[0.9rem] leading-relaxed text-txt glass rounded-2xl rounded-tl-sm py-3 px-4">
                        {msg.thinking?.trim() ? (
                          <ReasoningDisclosure thinking={msg.thinking} />
                        ) : null}
                        {msg.webSearchResult && msg.webSearchResult.results.length > 0 ? (
                          <WebSearchDisclosure result={msg.webSearchResult} />
                        ) : null}
                        {msg.artifactUseSidePanel ? (
                          <>
                            {(() => {
                              const stage = msg.artifactStage as PipelineStageKind | null | undefined;
                              const generating =
                                Boolean(stage) &&
                                stage !== "LivePreview" &&
                                stage !== "Error";
                              const safeContent =
                                msg.content?.trim() && !looksLikeArtifactDump(msg.content)
                                  ? scrubChatArtifactProtocol(msg.content)
                                  : "";
                              const chipTitle =
                                msg.artifactTitle ||
                                sessionStreamingArtifactTitle ||
                                (msg.artifactPath
                                  ? msg.artifactPath.split(/[/\\]/).pop()?.replace(/\.html?$/i, "")
                                  : undefined) ||
                                "Artifact";
                              const chipType =
                                msg.streamingArtifactType ||
                                sessionStreamingArtifactType ||
                                "text/html";
                              const panelOpen = Boolean(
                                sessionArtifactPanelOpen === true &&
                                  msg.artifactPath &&
                                  sessionArtifactPath === msg.artifactPath
                              );
                              const showChip =
                                Boolean(msg.artifactPath) ||
                                (isLast && hasLiveStreamBody) ||
                                stage === "LivePreview" ||
                                stage === "WritingCode";

                              return (
                                <>
                                  {generating && !safeContent && (
                                    <div className="space-y-2">
                                      {liveToolStatus && isLast && (
                                        <div className="web-search-live" role="status">
                                          <span className="web-search-live__pulse" aria-hidden />
                                          <span>{liveToolStatus}</span>
                                        </div>
                                      )}
                                      {isLast ? (
                                        <GenerationTimer
                                          active
                                          mode="artifact"
                                          stage={stage}
                                        />
                                      ) : (
                                        <GenerationProgressLabel
                                          active
                                          mode="artifact"
                                          elapsedSec={0}
                                          stage={stage}
                                        />
                                      )}
                                    </div>
                                  )}
                                  {safeContent ? (
                                    <MarkdownRenderer
                                      content={safeContent}
                                      sources={msg.webSearchResult?.results}
                                    />
                                  ) : null}
                                  {msg.artifactStage === "Error" && (
                                    <div className="mt-2 text-[0.85rem] text-red-300/90">
                                      {friendlyError(msg.content)}
                                      <button
                                        type="button"
                                        className="mt-2 block text-[0.78rem] text-neon hover:text-neon-hover underline-offset-2 hover:underline"
                                        onClick={runRetry}
                                        disabled={!canRetry}
                                      >
                                        {COPY.retry}
                                      </button>
                                    </div>
                                  )}
                                  {showChip && msg.artifactStage !== "Error" && (
                                    <ArtifactChip
                                      title={chipTitle}
                                      type={chipType}
                                      path={msg.artifactPath}
                                      panelOpen={panelOpen}
                                      loading={generating || !msg.artifactPath}
                                      onTogglePanel={() => {
                                        if (!sessionId) return;
                                        const path = msg.artifactPath;
                                        if (!path) {
                                          updateSession(sessionId, {
                                            artifactPanelOpen: !panelOpen,
                                            artifactStreamActive: true,
                                          });
                                          return;
                                        }
                                        if (panelOpen) {
                                          updateSession(sessionId, {
                                            artifactPanelOpen: false,
                                          });
                                          return;
                                        }
                                        const inferredType: "text/html" | "text/csv" =
                                          msg.streamingArtifactType ||
                                          (/\.xlsx?$/i.test(path)
                                            ? "text/csv"
                                            : "text/html");
                                        updateSession(sessionId, {
                                          artifactPanelOpen: true,
                                          artifactStreamActive: true,
                                          artifactPath: path,
                                          artifactStage: "LivePreview",
                                          // Clear any other artifact's streamed body so the
                                          // panel reloads this message's file from disk.
                                          streamingArtifactHtml: undefined,
                                          streamingArtifactCsv: undefined,
                                          streamingArtifactType: inferredType,
                                          streamingArtifactTitle: chipTitle,
                                        });
                                      }}
                                    />
                                  )}
                                  {msg.artifactFollowup?.trim() &&
                                    msg.artifactStage !== "Error" && (
                                      <div className="mt-3">
                                        <MarkdownRenderer
                                          content={scrubChatArtifactProtocol(
                                            msg.artifactFollowup
                                          )}
                                          sources={msg.webSearchResult?.results}
                                        />
                                      </div>
                                    )}
                                </>
                              );
                            })()}
                          </>
                        ) : (
                          <>
                            <MarkdownRenderer
                              content={scrubChatArtifactProtocol(msg.content)}
                              sources={msg.webSearchResult?.results}
                            />
                            {mediaForMsg && mediaForMsg.length > 0 && <MediaGallery assets={mediaForMsg} />}
                            {(msg.artifactPath || msg.artifactStage) && (
                              <div className="mt-3">
                                <InlineArtifact
                                  key={`artifact-${idx}-${msg.artifactPath ?? "pending"}`}
                                  artifactPath={msg.artifactPath}
                                  artifactStage={msg.artifactStage as PipelineStageKind | null | undefined}
                                  errorMessage={msg.artifactStage === "Error" ? friendlyError(msg.content) : undefined}
                                />
                                {msg.artifactStage === "Error" && (
                                  <button
                                    type="button"
                                    className="mt-2 text-[0.78rem] text-neon hover:text-neon-hover underline-offset-2 hover:underline"
                                    onClick={runRetry}
                                    disabled={!canRetry}
                                  >
                                    {COPY.retry}
                                  </button>
                                )}
                              </div>
                            )}
                          </>
                        )}
                        {mediaForMsg && mediaForMsg.length > 0 && msg.artifactUseSidePanel && (
                          <MediaGallery assets={mediaForMsg} />
                        )}
                        <div className="flex items-center gap-1 mt-2 pt-1.5 min-h-[1.5rem]">
                          <CopyMsgButton text={msg.content} label="Copy response" />
                          {retryText?.trim() && onRetry ? (
                            <RetryMsgButton
                              disabled={!canRetry}
                              onRetry={runRetry}
                            />
                          ) : null}
                          {/* Read response aloud button */}
                          <SpeakButton text={msg.content} compact />
                        {advanced && msg.generateTime !== undefined && (
                            <span className="text-[0.78rem] text-txt-muted ml-1" title={msg.firstTokenTime !== undefined ? `Generated in ${msg.generateTime}s\nFirst token in ${msg.firstTokenTime}s` : `Generated in ${msg.generateTime}s`}>
                              Generated in {msg.generateTime}s {msg.firstTokenTime !== undefined && `• First token in ${msg.firstTokenTime}s`}
                            </span>
                          )}
                          {modelLabel ? (
                            <span
                              className="ml-auto max-w-[55%] truncate text-[0.72rem] text-txt-muted opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100"
                              title={modelLabel.title}
                            >
                              {modelLabel.text}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {/* Render AudioPlayer after assistant message if audioUrl is present */}
                      {msg.audioUrl && (
                        <div className="mt-2 flex items-center gap-2">
                          <AudioPlayer src={msg.audioUrl} key={msg.audioUrl} />
                          <button
                            className="px-2 py-1 text-xs rounded bg-neon/10 text-neon border border-neon/30 hover:bg-neon/20 transition ml-1"
                            style={{ marginLeft: 0 }}
                            onClick={() => saveAudioToSidebar && saveAudioToSidebar(idx)}
                            title="Save audio to sidebar"
                          >
                            Save
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

  );
}

function propsAreEqual(prev: ChatMessageItemProps, next: ChatMessageItemProps): boolean {
  return (
    prev.msg === next.msg &&
    prev.idx === next.idx &&
    prev.isNew === next.isNew &&
    prev.isLast === next.isLast &&
    prev.advanced === next.advanced &&
    prev.mediaForMsg === next.mediaForMsg &&
    prev.liveToolStatus === next.liveToolStatus &&
    prev.sessionId === next.sessionId &&
    prev.sessionArtifactPath === next.sessionArtifactPath &&
    prev.sessionArtifactPanelOpen === next.sessionArtifactPanelOpen &&
    prev.sessionStreamingArtifactTitle === next.sessionStreamingArtifactTitle &&
    prev.sessionStreamingArtifactType === next.sessionStreamingArtifactType &&
    prev.hasLiveStreamBody === next.hasLiveStreamBody &&
    prev.retryText === next.retryText &&
    prev.isLoading === next.isLoading &&
    prev.onSend === next.onSend &&
    prev.onRetry === next.onRetry &&
    prev.saveAudioToSidebar === next.saveAudioToSidebar &&
    prev.onOpenPreview === next.onOpenPreview
  );
}

const ChatMessageItem = memo(ChatMessageItemInner, propsAreEqual);
export default ChatMessageItem;
