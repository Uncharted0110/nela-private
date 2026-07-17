import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { Api } from "../api";
import type {
  ChatMessage,
  ChatMode,
  ChatSession,
  ChatContextUsage,
  DirectDocumentAttachment,
  IngestionStatus,
  KittenTtsVoice,
  MindMapGraph,
  WebSearchResult,
  ArtifactResult,
} from "../types";
import type { PipelineStageKind } from "../components/ProgressSlate";
import { extractTaskText, parseMindMapGraph } from "./mindmapUtils";
import { parseArtifactPlanJson, parseHtmlPlanJson } from "./artifactPlanJson";
import { normalizePresentationPlan } from "./artifactPlanNormalize";
import { deriveTitleFromMessage } from "./sessionUtils";
import {
  applyCompactionResultToSession,
  CONTEXT_COMPACTION_KEEP_RECENT,
  CONTEXT_COMPACTION_THRESHOLD,
  DISCOVERY_NOTICE_PREFIX,
  AMBIENT_FOUND_PREFIX,
  normalizeMessagesForLlm,
  resolveReservedOutputTokens,
  toContextMessages,
} from "./contextCompaction";
import {
  extractAmbientSearchQuery,
  hasDocumentFileIntent,
  hasSearchKeywords,
  selectAmbientResultsForInjection,
  shouldRunAmbientFileSearch,
} from "./ambientSearch";
import {
  formatAmbientFileSection,
  hasLocalFilePathReference,
  loadAmbientFileBody,
  MAX_ARTIFACT_SOURCE_CHARS,
} from "./ambientFileContent";
import { parseSlashCommands, slashPromptForSend } from "./slashCommands";
import {
  HTML_PLAN_MAX_TOKENS,
  buildHtmlArtifactSystemPrompt,
  defaultThemeForArchetype,
  htmlPlanRequest,
  inferHtmlPageStructure,
  mapHtmlRendererTheme,
} from "./htmlArtifactPrompt";
import {
  extractWebSearchQuery,
  webArtifactGroundingPreamble,
  webContextCharLimit,
  webSearchOptionsForArtifact,
} from "./webSearchQuery";
import { fitArtifactPlanPrompt } from "./artifactContextBudget";
import {
  buildSpreadsheetDataContext,
  buildSpreadsheetFallbackPlan,
  buildSpreadsheetSystemPrompt,
  extractSpreadsheetRowCount,
  normalizeSpreadsheetPlan,
  parseSpreadsheetPlanJson,
  spreadsheetPlanMaxTokens,
} from "./spreadsheetPlan";
import { tryBuildDeterministicWebSpreadsheetPlan } from "./spreadsheetWebPlan";
import { inferHtmlTheme } from "./htmlThemeInference";
import {
  attachSpreadsheetToPlan,
  buildHtmlDataContext,
  spreadsheetFromParsed,
  type SpreadsheetData,
} from "./htmlChartData";
import {
  artifactKindFromPath,
  buildSpreadsheetEditSample,
  editedOutputName,
  findSessionArtifactPath,
  isEditableArtifactPath,
  isNelaPresentationDeckHtml,
  isPresentationSlideAddRequest,
  matchesArtifactEditIntent,
  MAX_EDIT_SPREADSHEET_ROWS,
  MAX_PATCH_SOURCE_CHARS,
  parseAddSlideFromPrompt,
  parseSlideInsertIndex,
  truncateForPatchEdit,
  type ArtifactEditKind,
} from "./artifactEdit";
import {
  attachImagesToHtmlPlan,
  attachImagesToPresentationPlan,
  buildArtifactImagePool,
  formatImageCatalogForPrompt,
} from "./artifactImagePool";

export interface MindmapOverlayState {
  sessionId: string;
  mindmapId: string | null;
  isGenerating?: boolean;
  query?: string;
}

interface GenerationOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
}

type UpdateSessionFn = (
  sessionId: string,
  patch: Partial<ChatSession> | ((prev: ChatSession) => Partial<ChatSession>)
) => void;

export interface SendHandlerContext {
  activeSessionId: string;
  sessions: ChatSession[];
  chatMode: ChatMode;
  ragEnabled: boolean;
  webEnabled: boolean;
  webDepth: "snippets" | "full";
  imagePath: string | null;
  directDocumentPaths: string[];
  ragDocs: IngestionStatus[];
  selectedModel: string;
  selectedVisionModel: string;
  selectedTtsEngine: string;
  ttsVoice: KittenTtsVoice;
  ttsSpeed: number;
  thinkingEnabled: boolean;
  abortControllersRef: MutableRefObject<Map<string, AbortController>>;
  visionUnlistenRef: MutableRefObject<(() => void) | null>;
  generalIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  ttsIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  updateSession: UpdateSessionFn;
  setActiveMindmapOverlay: Dispatch<SetStateAction<MindmapOverlayState | null>>;
  setGeneralGenerating: Dispatch<SetStateAction<boolean>>;
  setGeneralElapsedTime: Dispatch<SetStateAction<number>>;
  setGeneralGenerationTime: Dispatch<SetStateAction<number | null>>;
  setMindmapsBySession: Dispatch<SetStateAction<Record<string, MindMapGraph[]>>>;
  setStreamingThinking: Dispatch<SetStateAction<string>>;
  setTtsGenerating: Dispatch<SetStateAction<boolean>>;
  setTtsElapsedTime: Dispatch<SetStateAction<number>>;
  setTtsGenerationTime: Dispatch<SetStateAction<number | null>>;
  setContextUsageForSession: (sessionId: string, usage: ChatContextUsage) => void;
  clearImage: () => void;
  clearDirectDocuments: () => void;
  getContextWindowTokens: (modelIdentifier: string | null | undefined) => number;
  getChatGenerationOptions: (modelIdentifier: string | null | undefined) => GenerationOptions;
}

export async function executeHandleSend(
  text: string,
  ctx: SendHandlerContext
): Promise<void> {
  const sid = ctx.activeSessionId;
  const session = ctx.sessions.find((s) => s.id === sid);
  if (!session || session.loading) return;

  const slash = parseSlashCommands(text);
  const promptText = slashPromptForSend(slash);
  const effectiveWebEnabled = ctx.webEnabled || slash.web;
  const effectiveRagEnabled = ctx.ragEnabled || slash.rag;
  const slashFileSearch = slash.files;

  const currentVisionImagePath = ctx.chatMode === "vision" ? ctx.imagePath : null;
  const ragDocPaths = ctx.ragDocs.map((doc) => doc.file_path).filter((path) => !!path);
  const promptDocumentPaths =
    ctx.chatMode === "text" && !effectiveRagEnabled
      ? (ctx.directDocumentPaths.length > 0 ? ctx.directDocumentPaths : ragDocPaths)
      : ctx.directDocumentPaths;

  const visionAttachment =
    ctx.chatMode === "vision" && currentVisionImagePath
      ? {
          path: currentVisionImagePath,
          name: currentVisionImagePath.split(/[/\\]/).pop() ?? "image",
        }
      : undefined;

  const directDocAttachments: DirectDocumentAttachment[] | undefined =
    ctx.chatMode === "text" && ctx.directDocumentPaths.length > 0
      ? ctx.directDocumentPaths.map((path) => ({
          path,
          name: path.split(/[/\\]/).pop() ?? "document",
        }))
      : undefined;

  const newMsg: ChatMessage = {
    role: "user",
    content: promptText,
    ...(visionAttachment ? { visionImage: visionAttachment } : {}),
    ...(directDocAttachments && directDocAttachments.length > 0
      ? { directDocuments: directDocAttachments }
      : {}),
  };

  const isFirstMessage = session.messages.length === 0;
  const titlePatch = isFirstMessage ? { title: deriveTitleFromMessage(promptText) } : {};

  ctx.updateSession(sid, (prev) => ({
    messages: [...prev.messages, newMsg],
    loading: true,
    streamingContent: "",
    audioOutputs: prev.audioOutputs ?? [],
    cancelled: false,
    ...titlePatch,
  }));

  if (ctx.chatMode === "vision" && currentVisionImagePath) {
    ctx.clearImage();
  }
  if (
    ctx.chatMode === "text" &&
    ctx.directDocumentPaths.length > 0 &&
    directDocAttachments &&
    directDocAttachments.length > 0
  ) {
    ctx.clearDirectDocuments();
  }

  const ctrl = new AbortController();
  ctx.abortControllersRef.current.set(sid, ctrl);
  const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

  let resolvedIntentKind = slashFileSearch ? "FileSearch" : "";
  const artifactOptions = {
    webEnabled: effectiveWebEnabled,
    webDepth: ctx.webDepth,
    ragEnabled: effectiveRagEnabled,
    forceFileSearch: slashFileSearch,
  };

  // ── Slash-command routing (explicit user intent) ─────────────────────────
  if (ctx.chatMode === "text" && slash.artifact) {
    const { tool, schemaId } = slash.artifact;
    await handleArtifactGeneration(
      promptText,
      tool,
      schemaId,
      sid,
      ctx,
      ctrl,
      artifactOptions
    );
    return;
  }

  // ── Intent Resolution (Revamp P3/P5) ──────────────────────────────────────
  if (ctx.chatMode === "text") {
    const sessionArtifactPath = findSessionArtifactPath(session);
    const attachedEditable = promptDocumentPaths.filter(isEditableArtifactPath);
    const editTargetPath =
      attachedEditable[0] ??
      sessionArtifactPath ??
      null;

    if (
      matchesArtifactEditIntent(promptText, {
        artifactPath: editTargetPath,
        attachedPaths: promptDocumentPaths,
      })
    ) {
      await handleArtifactEdit(
        promptText,
        editTargetPath ?? "",
        sid,
        ctx,
        ctrl,
        { attachedPaths: promptDocumentPaths }
      );
      return;
    }

    try {
      const intentExtra: Record<string, string> = {};
      if (sessionArtifactPath) {
        intentExtra.artifact_path = sessionArtifactPath;
      }
      const intent = await Api.resolveIntent(promptText, intentExtra);
      resolvedIntentKind = intent.kind.kind;
      if (intent.kind.kind === "Artifact") {
        const { tool, schema_id } = intent.kind;
        await handleArtifactGeneration(
          promptText,
          tool,
          schema_id,
          sid,
          ctx,
          ctrl,
          artifactOptions
        );
        return;
      }
      if (intent.kind.kind === "Patch") {
        const { artifact_path } = intent.kind;
        await handleArtifactEdit(
          promptText,
          artifact_path || sessionArtifactPath || "",
          sid,
          ctx,
          ctrl,
          { attachedPaths: promptDocumentPaths }
        );
        return;
      }
    } catch (err) {
      console.warn("Intent resolution failed, falling back to standard chat:", err);
    }
  }

  try {
    if (ctx.chatMode === "mindmap") {
      try {
        ctx.setActiveMindmapOverlay({
          sessionId: sid,
          mindmapId: null,
          isGenerating: true,
          query: promptText,
        });
        ctx.setGeneralGenerating(true);
        ctx.setGeneralElapsedTime(0);
        ctx.setGeneralGenerationTime(null);
        const startTime = Date.now();

        if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
        ctx.generalIntervalRef.current = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startTime) / 100) / 10;
          ctx.setGeneralElapsedTime(elapsed);
        }, 100);

        let generatedFrom: "documents" | "model" = "model";
        let sourceCount = 0;
        let sourceContext = "";

        if (ctx.ragDocs.length > 0) {
          try {
            const setup = await Api.queryRagStream(promptText);
            ctx.updateSession(sid, { ragResult: { answer: "", sources: setup.sources } });
            if (!setup.no_retrieval && setup.sources.length > 0) {
              generatedFrom = "documents";
              sourceCount = setup.sources.length;
              sourceContext = setup.sources
                .map((source, index) => `Source ${index + 1} (${source.doc_title}):\n${source.text}`)
                .join("\n\n");
            }
          } catch (e) {
            console.warn("Mindmap RAG grounding failed; using model knowledge.", e);
          }
        }

        const prompt = generatedFrom === "documents"
          ? [
              `User query: ${promptText}`,
              "Build a concise mindmap grounded ONLY in the provided sources.",
              "Return ONLY valid JSON and no markdown/code fences.",
              "Schema:",
              '{"title":"string","root":{"label":"string","children":[{"label":"string","children":[...]}]}}',
              "Rules:",
              "- 3 to 6 first-level branches.",
              "- Keep labels short (2 to 8 words).",
              "- Depth max 3.",
              "- Do not invent unsupported facts.",
              "Sources:",
              sourceContext,
            ].join("\n")
          : [
              `User query: ${promptText}`,
              "Create a concise conceptual mindmap from your own knowledge.",
              "Return ONLY valid JSON and no markdown/code fences.",
              "Schema:",
              '{"title":"string","root":{"label":"string","children":[{"label":"string","children":[...]}]}}',
              "Rules:",
              "- 3 to 6 first-level branches.",
              "- Keep labels short (2 to 8 words).",
              "- Depth max 3.",
            ].join("\n");

        let graph: MindMapGraph | undefined;
        let lastError: unknown;

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            const raw = await Api.routeRequest("mindmap", prompt, ctx.selectedModel || undefined);
            const modelText = extractTaskText(raw);
            graph = parseMindMapGraph(modelText, promptText, generatedFrom, sourceCount);
            break;
          } catch (e) {
            console.warn(`Mindmap generation attempt ${attempt} failed:`, e);
            lastError = e;
          }
        }

        if (!graph) {
          throw lastError;
        }

        ctx.setMindmapsBySession((prev) => ({
          ...prev,
          [sid]: [...(prev[sid] ?? []), graph],
        }));

        ctx.setActiveMindmapOverlay({
          sessionId: sid,
          mindmapId: graph.id,
          isGenerating: false,
          query: promptText,
        });

        if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
        const totalTime = Math.floor((Date.now() - startTime) / 100) / 10;
        ctx.setGeneralGenerating(false);
        ctx.setGeneralElapsedTime(totalTime);
        ctx.setGeneralGenerationTime(totalTime);

        ctx.updateSession(sid, (prev) => ({
          messages: [
            ...prev.messages,
            {
              role: "assistant" as const,
              content:
                generatedFrom === "documents"
                  ? `Mindmap generated from ${sourceCount} retrieved document source${sourceCount === 1 ? "" : "s"}.`
                  : "Mindmap generated from model knowledge.",
              generateTime: totalTime,
            },
          ],
          streamingContent: "",
          loading: false,
        }));
      } catch (e) {
        ctx.setActiveMindmapOverlay(null);
        if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
        ctx.setGeneralGenerating(false);
        console.error("Mindmap generation failed:", e);
        ctx.updateSession(sid, (prev) => ({
          messages: [
            ...prev.messages,
            {
              role: "assistant" as const,
              content:
                "Mindmap generation failed. The model produced malformed data. Try selecting a larger model or rewording your input.",
            },
          ],
          loading: false,
        }));
      }
      return;
    }

    if (ctx.chatMode === "text" && !effectiveRagEnabled && promptDocumentPaths.length > 0) {
      try {
        ctx.setGeneralGenerating(true);
        ctx.setGeneralElapsedTime(0);
        ctx.setGeneralGenerationTime(null);
        const directStartTime = Date.now();

        if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
        ctx.generalIntervalRef.current = setInterval(() => {
          const elapsed = Math.floor((Date.now() - directStartTime) / 100) / 10;
          ctx.setGeneralElapsedTime(elapsed);
        }, 100);

        const contextWindowTokens = ctx.getContextWindowTokens(ctx.selectedModel);
        const maxTotalChars = Math.max(
          6_000,
          Math.min(160_000, Math.floor(contextWindowTokens * 2.5))
        );
        const maxCharsPerDocument = Math.max(
          1_500,
          Math.floor(maxTotalChars / Math.max(promptDocumentPaths.length, 1))
        );

        const directSetup = await Api.prepareDirectDocumentPrompt(
          promptText,
          promptDocumentPaths,
          {
            maxCharsPerDocument,
            maxTotalChars,
          }
        );

        if (directSetup.warnings.length > 0) {
          console.warn("Direct document prompt warnings:", directSetup.warnings);
        }

        const directMessages: ChatMessage[] = [
          {
            role: "system",
            content:
              "You are a helpful assistant. Treat the attached document excerpts in the next message as the primary source of truth. If the answer is not present in those excerpts, explicitly say you don't know.",
          },
          { role: "user", content: directSetup.prompt },
        ];

        try {
          const directCtx = await Api.compactChatContext({
            messages: toContextMessages(directMessages),
            contextWindowTokens,
            reservedOutputTokens: resolveReservedOutputTokens(generationOptions.maxTokens),
            thresholdPercent: CONTEXT_COMPACTION_THRESHOLD,
            allowAutoCompaction: false,
            forceCompaction: false,
            preserveRecentMessages: CONTEXT_COMPACTION_KEEP_RECENT,
            modelOverride: ctx.selectedModel || null,
          });
          ctx.setContextUsageForSession(sid, directCtx.usage);
        } catch (err) {
          console.warn("Failed to analyze direct-document context usage:", err);
        }

        let fullAnswer = "";
        let fullThinking = "";
        let firstTokenTimeMs: number | null = null;

        await Api.streamChat(
          directMessages,
          (chunk) => {
            if (firstTokenTimeMs === null) {
              firstTokenTimeMs = Date.now();
            }
            fullAnswer += chunk;
            ctx.updateSession(sid, (prev) => ({
              streamingContent: prev.streamingContent + chunk,
            }));
          },
          (thinkingChunk) => {
            fullThinking += thinkingChunk;
            ctx.setStreamingThinking((prev) => prev + thinkingChunk);
          },
          () => {
            if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
            const totalTime = Math.floor((Date.now() - directStartTime) / 100) / 10;
            const timeToFirstToken =
              firstTokenTimeMs
                ? Math.floor((firstTokenTimeMs - directStartTime) / 100) / 10
                : null;

            ctx.setGeneralGenerating(false);
            ctx.setGeneralElapsedTime(totalTime);
            ctx.setGeneralGenerationTime(totalTime);
            ctx.setStreamingThinking("");

            if (fullAnswer) {
              ctx.updateSession(sid, (prev) => ({
                messages: [
                  ...prev.messages,
                  {
                    role: "assistant" as const,
                    content: fullAnswer,
                    thinking: fullThinking || undefined,
                    generateTime: totalTime,
                    firstTokenTime:
                      timeToFirstToken !== null ? timeToFirstToken : undefined,
                  },
                ],
                streamingContent: "",
                loading: false,
              }));
            } else {
              ctx.updateSession(sid, { loading: false });
            }
          },
          (err) => {
            console.error("Direct-document stream error:", err);
            ctx.updateSession(sid, (prev) => ({
              messages: [
                ...prev.messages,
                {
                  role: "assistant" as const,
                  content: `Direct document query error: ${err}`,
                },
              ],
              loading: false,
            }));
          },
          undefined,
          ctx.selectedModel || undefined,
          ctrl.signal,
          !ctx.thinkingEnabled,
          generationOptions
        );
        return;
      } catch (e) {
        if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
        ctx.setGeneralGenerating(false);
        console.error("Direct-document attempt failed, falling back to normal chat:", e);
      }
    }

    if (ctx.chatMode === "text" && effectiveRagEnabled && ctx.ragDocs.length > 0) {
      try {
        ctx.setGeneralGenerating(true);
        ctx.setGeneralElapsedTime(0);
        ctx.setGeneralGenerationTime(null);
        const ragStartTime = Date.now();

        if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
        ctx.generalIntervalRef.current = setInterval(() => {
          const elapsed = Math.floor((Date.now() - ragStartTime) / 100) / 10;
          ctx.setGeneralElapsedTime(elapsed);
        }, 100);

        const setup = await Api.queryRagStream(promptText);
        ctx.updateSession(sid, { ragResult: { answer: "", sources: setup.sources } });

        if (!setup.prompt || setup.sources.length === 0) {
          // Fall through to plain chat
        } else {
          const ragMessages: ChatMessage[] = [
            {
              role: "system",
              content:
                "You are a helpful assistant. Answer the question using the provided reference text. Write a clear, natural response without repeating source labels, tags, or brackets. If the user asks for a specific format (table, list, bullet points, etc.), use that format. If the reference text does not cover the question, say you don't know.",
            },
            { role: "user", content: setup.prompt },
          ];

          try {
            const ragCtx = await Api.compactChatContext({
              messages: toContextMessages(ragMessages),
              contextWindowTokens: ctx.getContextWindowTokens(ctx.selectedModel),
              reservedOutputTokens: resolveReservedOutputTokens(generationOptions.maxTokens),
              thresholdPercent: CONTEXT_COMPACTION_THRESHOLD,
              allowAutoCompaction: false,
              forceCompaction: false,
              preserveRecentMessages: CONTEXT_COMPACTION_KEEP_RECENT,
              modelOverride: ctx.selectedModel || null,
            });
            ctx.setContextUsageForSession(sid, ragCtx.usage);
          } catch (err) {
            console.warn("Failed to analyze RAG context window usage:", err);
          }

          let fullAnswer = "";
          let fullThinking = "";
          let firstTokenTimeMs: number | null = null;

          await Api.streamChat(
            ragMessages,
            (chunk) => {
              if (firstTokenTimeMs === null) {
                firstTokenTimeMs = Date.now();
              }
              fullAnswer += chunk;
              ctx.updateSession(sid, (prev) => ({
                streamingContent: prev.streamingContent + chunk,
              }));
            },
            (thinkingChunk) => {
              fullThinking += thinkingChunk;
              ctx.setStreamingThinking((prev) => prev + thinkingChunk);
            },
            () => {
              if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
              const totalTime = Math.floor((Date.now() - ragStartTime) / 100) / 10;
              const timeToFirstToken =
                firstTokenTimeMs
                  ? Math.floor((firstTokenTimeMs - ragStartTime) / 100) / 10
                  : null;

              ctx.setGeneralGenerating(false);
              ctx.setGeneralElapsedTime(totalTime);
              ctx.setGeneralGenerationTime(totalTime);
              ctx.setStreamingThinking("");

              ctx.updateSession(sid, (prev) => {
                const updated: ChatMessage[] = [
                  ...prev.messages,
                  {
                    role: "assistant",
                    content: fullAnswer,
                    thinking: fullThinking || undefined,
                    generateTime: totalTime,
                    firstTokenTime:
                      timeToFirstToken !== null ? timeToFirstToken : undefined,
                  },
                ];

                const assistantIdx = updated.length - 1;
                Api.retrieveMediaForResponse(fullAnswer)
                  .then((assets) => {
                    console.log(`Media retrieval: found ${assets.length} assets`);
                    if (assets.length > 0) {
                      ctx.updateSession(sid, (prev2) => ({
                        mediaAssets: {
                          ...prev2.mediaAssets,
                          [assistantIdx]: assets,
                        },
                      }));
                    }
                  })
                  .catch((e) => console.error("Media retrieval failed:", e));

                return {
                  messages: updated,
                  ragResult: prev.ragResult
                    ? { ...prev.ragResult, answer: fullAnswer }
                    : null,
                  streamingContent: "",
                  loading: false,
                };
              });
            },
            (err) => {
              console.error("RAG stream error:", err);
              ctx.updateSession(sid, (prev) => ({
                messages: [
                  ...prev.messages,
                  { role: "assistant" as const, content: `RAG query error: ${err}` },
                ],
                loading: false,
              }));
            },
            setup.llama_port,
            ctx.selectedModel || undefined,
            ctrl.signal,
            !ctx.thinkingEnabled,
            generationOptions
          );
          return;
        }
      } catch (e) {
        if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
        ctx.setGeneralGenerating(false);
        console.error("RAG attempt failed, falling back to normal chat:", e);
      }
    }

    if (ctx.chatMode === "audio" && ctx.selectedTtsEngine) {
      try {
        ctx.setTtsGenerating(true);
        ctx.setTtsElapsedTime(0);
        ctx.setTtsGenerationTime(null);
        const startTime = Date.now();

        if (ctx.ttsIntervalRef.current) clearInterval(ctx.ttsIntervalRef.current);
        ctx.ttsIntervalRef.current = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startTime) / 100) / 10;
          ctx.setTtsElapsedTime(elapsed);
        }, 100);

        const audioUrl = await Api.generateSpeech(text, {
          voice: ctx.ttsVoice,
          speed: ctx.ttsSpeed,
        });

        if (ctx.ttsIntervalRef.current) clearInterval(ctx.ttsIntervalRef.current);
        const totalTime = Math.floor((Date.now() - startTime) / 100) / 10;
        ctx.setTtsGenerating(false);
        ctx.setTtsElapsedTime(totalTime);
        ctx.setTtsGenerationTime(totalTime);

        ctx.updateSession(sid, (prev) => ({
          audioOutputs: [(prev.audioOutputs ?? []), audioUrl].flat(),
          audioOutput: audioUrl,
          messages: [
            ...prev.messages,
            {
              role: "assistant" as const,
              content: `🔊 Audio generated (${ctx.ttsVoice}, ${ctx.ttsSpeed}x speed).`,
              generateTime: totalTime,
              audioUrl,
            },
          ],
        }));
      } catch (e) {
        console.error(e);
        if (ctx.ttsIntervalRef.current) clearInterval(ctx.ttsIntervalRef.current);
        ctx.setTtsGenerating(false);
        ctx.updateSession(sid, (prev) => ({
          messages: [
            ...prev.messages,
            { role: "assistant" as const, content: `Error generating audio: ${e}` },
          ],
        }));
      }
      ctx.updateSession(sid, { loading: false });
      return;
    }

    if (ctx.chatMode === "vision") {
      try {
        ctx.setGeneralGenerating(true);
        ctx.setGeneralElapsedTime(0);
        ctx.setGeneralGenerationTime(null);
        const startTime = Date.now();

        if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
        ctx.generalIntervalRef.current = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startTime) / 100) / 10;
          ctx.setGeneralElapsedTime(elapsed);
        }, 100);

        ctx.visionUnlistenRef.current?.();
        ctx.visionUnlistenRef.current = null;

        let visionResponse = "";
        let firstTokenTimeMs: number | null = null;

        const unlisten = await listen<{ chunk: string; done: boolean }>(
          "vision-stream",
          (event) => {
            if (event.payload.done) {
              if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
              const totalTime = Math.floor((Date.now() - startTime) / 100) / 10;
              const timeToFirstToken =
                firstTokenTimeMs
                  ? Math.floor((firstTokenTimeMs - startTime) / 100) / 10
                  : null;

              ctx.setGeneralGenerating(false);
              ctx.setGeneralElapsedTime(totalTime);
              ctx.setGeneralGenerationTime(totalTime);

              if (visionResponse) {
                ctx.updateSession(sid, (prev) => ({
                  messages: [
                    ...prev.messages,
                    {
                      role: "assistant" as const,
                      content: visionResponse,
                      generateTime: totalTime,
                      firstTokenTime:
                        timeToFirstToken !== null ? timeToFirstToken : undefined,
                    },
                  ],
                  streamingContent: "",
                  loading: false,
                }));
              } else {
                ctx.updateSession(sid, { loading: false });
              }
              ctx.visionUnlistenRef.current?.();
              ctx.visionUnlistenRef.current = null;
            } else if (event.payload.chunk) {
              if (firstTokenTimeMs === null) {
                firstTokenTimeMs = Date.now();
              }
              visionResponse += event.payload.chunk;
              ctx.updateSession(sid, (prev) => ({
                streamingContent: prev.streamingContent + event.payload.chunk,
              }));
            }
          }
        );

        ctx.visionUnlistenRef.current = unlisten;

        const visionPrompt =
          promptText ||
          (currentVisionImagePath ? "What's in this image?" : "Hello! Let's chat.");

        await Api.visionChatStream(
          currentVisionImagePath || undefined,
          visionPrompt,
          ctx.selectedVisionModel || undefined
        );
      } catch (e) {
        console.error(e);
        if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
        ctx.setGeneralGenerating(false);
        ctx.updateSession(sid, (prev) => ({
          messages: [
            ...prev.messages,
            { role: "assistant" as const, content: `Vision error: ${e}` },
          ],
          loading: false,
        }));
        ctx.visionUnlistenRef.current?.();
        ctx.visionUnlistenRef.current = null;
      }
      return;
    }

    // ── Web search context injection ───────────────────────────────────────
    let webSearchResult: WebSearchResult | null = null;
    if (ctx.chatMode === "text" && effectiveWebEnabled) {
      try {
        const searchQuery = extractWebSearchQuery(promptText);
        const fetchContent = ctx.webDepth === "full";
        const maxResults = fetchContent ? 4 : 5;
        const result = await Api.webSearch(searchQuery, maxResults, fetchContent);
        if (result.results.length > 0) {
          webSearchResult = result;
        }
      } catch (e) {
        console.warn("[web_search] Failed, continuing without web context:", e);
      }
    }

    // ── Ambient FTS5 file search context injection (Revamp P4 grounding) ───
    let ambientFileContext = "";
    let attachedFile = ctx.directDocumentPaths.length > 0 ? ctx.directDocumentPaths[0] : null;
    let discoveryMsg: ChatMessage | null = null;

    // Decide whether to run the ambient OS file search. Two tiers:
    //  - explicit: a clear file request (search/find/get the file, a locality cue like
    //    "from my system", a filename with extension) OR a deterministic FileSearch
    //    intent. These trigger the search AND, on a miss, a "couldn't find it" notice.
    //  - soft: a likely file reference ("get form 1a", "what does X say", "contents of X").
    //    These trigger the search too, but on a miss they silently continue so general
    //    questions are not hijacked into a false "I couldn't find the file" answer.
    // When web search already supplied context and the request wasn't an explicit file
    // request, skip ambient search to avoid the two grounding sources clashing.
    const explicitFileSearch =
      resolvedIntentKind === "FileSearch" ||
      slashFileSearch ||
      hasSearchKeywords(promptText) ||
      hasDocumentFileIntent(promptText) ||
      hasLocalFilePathReference(promptText);
    const wantsFileSearch = shouldRunAmbientFileSearch(promptText, {
      forceFileSearch: resolvedIntentKind === "FileSearch" || slashFileSearch,
    });
    const skipForWebSearch = !!webSearchResult && !explicitFileSearch;

    if (ctx.chatMode === "text" && !attachedFile && wantsFileSearch && !skipForWebSearch) {
      {
        const searchQuery = extractAmbientSearchQuery(promptText);
        try {
          const results = await Api.searchAmbientFiles(searchQuery);
          const top = selectAmbientResultsForInjection(results ?? []);
          if (top.length > 0) {
            const sections: string[] = [];

            for (const rec of top) {
              const filename = rec.path.split(/[/\\]/).pop() ?? "file";
              if (rec.path.endsWith(".csv") || rec.path.endsWith(".tsv")) {
                try {
                  const fileContent = await Api.readFileText(rec.path);
                  const parsed = parseCSV(fileContent);
                  if (parsed.headers.length > 0) {
                    sections.push(
                      `File: "${filename}" (Path: ${rec.path})\n` +
                      `Columns: [${parsed.headers.join(", ")}]\n` +
                      `First rows:\n${parsed.rows.slice(0, 10).map(r => r.join(", ")).join("\n")}`
                    );
                    continue;
                  }
                } catch (err) { console.warn("CSV read failed:", err); }
              } else if (rec.path.endsWith(".xlsx") || rec.path.endsWith(".xls") || rec.path.endsWith(".ods")) {
                try {
                  const cached = await Api.getAmbientFileContent(rec.path);
                  if (cached) {
                    sections.push(`File: "${filename}" (Path: ${rec.path})\nSchema:\n${cached}`);
                    continue;
                  }
                } catch (err) { console.warn("Excel schema read failed:", err); }
              }
              const body = await loadAmbientFileBody(rec.path);
              sections.push(formatAmbientFileSection(rec.path, body));
            }

            if (sections.length > 0) {
              // Surface the best match in the chat UI only (not sent to the LLM — see
              // fullSessionMessages below and isDiscoveryNotice in contextCompaction).
              const bestName = top[0].path.split(/[/\\]/).pop() ?? "file";
              attachedFile = top[0].path;
              const normalizedPath = top[0].path.replace(/\\/g, "/");
              const fileUrl = normalizedPath.startsWith("/")
                ? `file://${normalizedPath}`
                : `file:///${normalizedPath}`;
              discoveryMsg = {
                role: "assistant" as const,
                content: `${AMBIENT_FOUND_PREFIX} ${top.length} matching file(s). Top match: **${bestName}**\nPath: [${top[0].path}](${fileUrl})`,
              };
              ctx.updateSession(sid, (prev) => ({ messages: [...prev.messages, discoveryMsg!] }));
              ambientFileContext =
                `The following local files were retrieved (most relevant first):\n\n${sections.join("\n\n---\n\n")}`;
            }
          }
        } catch (err) {
          console.warn("Ambient search in standard chat failed:", err);
        }

        // If an EXPLICIT file request found nothing, tell the model the file is missing
        // so it doesn't hallucinate file contents. For a soft reference that missed, we
        // leave the context empty and let the model answer the query normally.
        if (!ambientFileContext && !attachedFile && explicitFileSearch) {
          ambientFileContext = "FILE_SEARCH_NO_RESULTS";
        }
      }
    }

    ctx.setGeneralGenerating(true);
    ctx.setGeneralElapsedTime(0);
    ctx.setGeneralGenerationTime(null);
    const chatStartTime = Date.now();

    if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
    ctx.generalIntervalRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - chatStartTime) / 100) / 10;
      ctx.setGeneralElapsedTime(elapsed);
    }, 100);

    let fullResponse = "";
    let fullThinking = "";
    let textFirstTokenTimeMs: number | null = null;

    const sessionMessages = session.messages;
    const fullSessionMessages: ChatMessage[] = [
      ...sessionMessages,
      newMsg,
      // discoveryMsg is UI-only; omit it here so the LLM sees user as the last turn.
    ];
    let apiMessages = toContextMessages(fullSessionMessages);

    // Inject ambient file search results. The retrieved document text goes into the
    // FINAL USER message (not a system message): small local models weight the current
    // user turn far more heavily, and wording like "you have access to local files"
    // tends to trip their "I can't access your files" guardrail. The document text is
    // presented inline as the source of truth — mirroring the direct-document path.
    if (ambientFileContext === "FILE_SEARCH_NO_RESULTS") {
      apiMessages = [
        {
          role: "system",
          content:
            "The user asked about a specific local file, but it could not be located in Documents, Desktop, Downloads, or indexed workspaces. " +
            "Tell them you could not find that file on their system. Do NOT claim you lack the ability to access local files — this app can search them, but this particular file was not found. " +
            "Suggest they verify the path, wait for indexing to finish after restart, or attach the file directly.",
        },
        ...apiMessages,
      ];
    } else if (ambientFileContext) {
      apiMessages = [
        {
          role: "system",
          content:
            "You are NELA, a local desktop assistant. The user's message includes text retrieved from their computer. " +
            "You ALREADY have the file contents below — answer directly from that text. " +
            "NEVER say you cannot access local files, paths, or the user's system. " +
            "Summarize or explain the document in clear prose. If the excerpt is incomplete, say what you can from the provided text.",
        },
        ...apiMessages,
      ];
      // Fold the document text into the last user message so the model reads it as part
      // of the current request rather than as background context it might ignore.
      for (let i = apiMessages.length - 1; i >= 0; i--) {
        if (apiMessages[i].role === "user") {
          apiMessages[i] = {
            ...apiMessages[i],
            content:
              `${apiMessages[i].content}\n\n` +
              `--- Retrieved document text (source of truth) ---\n${ambientFileContext}\n--- End of document text ---`,
          };
          break;
        }
      }
    }

    // Prepend web search context as a system message so the model can cite it
    if (webSearchResult && webSearchResult.formatted_context) {
      apiMessages = [
        { role: "system", content: webSearchResult.formatted_context },
        ...apiMessages,
      ];
    }

    try {
      const compaction = await Api.compactChatContext({
        messages: apiMessages,
        contextWindowTokens: ctx.getContextWindowTokens(ctx.selectedModel),
        reservedOutputTokens: resolveReservedOutputTokens(generationOptions.maxTokens),
        thresholdPercent: CONTEXT_COMPACTION_THRESHOLD,
        allowAutoCompaction: true,
        forceCompaction: false,
        preserveRecentMessages: CONTEXT_COMPACTION_KEEP_RECENT,
        modelOverride: ctx.selectedModel || null,
      });

      ctx.setContextUsageForSession(sid, compaction.usage);
      apiMessages = compaction.messages;

      if (compaction.compacted) {
        const rebuilt = applyCompactionResultToSession(
          fullSessionMessages,
          session.mediaAssets ?? {},
          compaction
        );
        ctx.updateSession(sid, {
          messages: rebuilt.messages,
          mediaAssets: rebuilt.mediaAssets,
        });
      }
    } catch (err) {
      console.warn("Context compaction failed; continuing with original context:", err);
    }

    // Collapse every injected `system` message (web search, ambient file context,
    // auto-compaction summary) into a single leading system message and strip the
    // UI-only discovery notice. This prevents llama-server's strict chat template
    // from rejecting the request with "System message must be at the beginning".
    apiMessages = normalizeMessagesForLlm(apiMessages);

    Api.streamChat(
      apiMessages,
      (chunk) => {
        if (textFirstTokenTimeMs === null) {
          textFirstTokenTimeMs = Date.now();
        }
        ctx.updateSession(sid, (prev) => ({
          streamingContent: prev.streamingContent + chunk,
        }));
        fullResponse += chunk;
      },
      (thinkingChunk) => {
        fullThinking += thinkingChunk;
        ctx.setStreamingThinking((prev) => prev + thinkingChunk);
      },
      () => {
        if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
        const totalTime = Math.floor((Date.now() - chatStartTime) / 100) / 10;
        const timeToFirstToken =
          textFirstTokenTimeMs
            ? Math.floor((textFirstTokenTimeMs - chatStartTime) / 100) / 10
            : null;

        ctx.setGeneralGenerating(false);
        ctx.setGeneralElapsedTime(totalTime);
        ctx.setGeneralGenerationTime(totalTime);
        ctx.setStreamingThinking("");

        if (fullResponse) {
          ctx.updateSession(sid, (prev) => ({
            messages: [
              ...prev.messages,
              {
                role: "assistant" as const,
                content: fullResponse,
                thinking: fullThinking || undefined,
                webSearchResult: webSearchResult ?? undefined,
                generateTime: totalTime,
                firstTokenTime:
                  timeToFirstToken !== null ? timeToFirstToken : undefined,
              },
            ],
            streamingContent: "",
            loading: false,
          }));
        } else {
          ctx.updateSession(sid, { loading: false });
        }
      },
      (err) => {
        if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
        ctx.setGeneralGenerating(false);
        ctx.setStreamingThinking("");
        console.error("Stream error", err);
        ctx.updateSession(sid, (prev) => ({
          messages: [
            ...prev.messages,
            { role: "assistant" as const, content: `Error: ${err}` },
          ],
          loading: false,
        }));
      },
      undefined,
      ctx.selectedModel || undefined,
      ctrl.signal,
      !ctx.thinkingEnabled,
      generationOptions
    );
  } catch (err) {
    if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
    ctx.setGeneralGenerating(false);
    console.error(err);
    ctx.updateSession(sid, (prev) => ({
      messages: [
        ...prev.messages,
        { role: "assistant" as const, content: "An unexpected error occurred." },
      ],
      loading: false,
    }));
  }
}

async function handleArtifactGeneration(
  text: string,
  _tool: string,
  schemaId: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  options?: {
    webEnabled?: boolean;
    webDepth?: "snippets" | "full";
    ragEnabled?: boolean;
    forceFileSearch?: boolean;
  }
): Promise<void> {
  ctx.updateSession(sid, (prev) => ({
    loading: true,
    artifactStage: "IntentLocked",
    artifactPath: null,
    messages: [
      ...prev.messages,
      {
        role: "assistant",
        content: `Generating artifact for: "${text}"`,
        artifactStage: "IntentLocked",
        artifactPath: null,
      }
    ]
  }));

  const updateArtifactMsg = (stage: PipelineStageKind, path: string | null = null, contentOverride?: string) => {
    ctx.updateSession(sid, (prev) => {
      const updated = [...prev.messages];
      const idx = updated.map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === "assistant" && m.artifactStage !== undefined)?.i;
      if (idx !== undefined && updated[idx]) {
        updated[idx] = {
          ...updated[idx],
          artifactStage: stage,
          ...(path !== null ? { artifactPath: path } : {}),
          ...(contentOverride !== undefined ? { content: contentOverride } : {}),
        };
      }
      return {
        artifactStage: stage,
        ...(path !== null ? { artifactPath: path } : {}),
        messages: updated,
      };
    });
  };

  try {
    const grammar = await Api.getSchemaGrammar(schemaId);

    let headers: string[] | undefined;
    let rows: string[][] | undefined;
    let spreadsheetData: SpreadsheetData | null = null;
    let ambientFileContent = "";

    let attachedFile = ctx.directDocumentPaths.length > 0 ? ctx.directDocumentPaths[0] : null;

    const wantsAmbientFileSearch = shouldRunAmbientFileSearch(text, {
      forceFileSearch: options?.forceFileSearch,
    });

    // Proactive ambient FTS5 search if no file is attached but query references a file
    if (!attachedFile && wantsAmbientFileSearch) {
      updateArtifactMsg("SearchingDisk");
      const searchQuery = extractAmbientSearchQuery(text);
      try {
        const results = await Api.searchAmbientFiles(searchQuery);
        const top = selectAmbientResultsForInjection(results ?? []);
        if (top.length > 0) {
          const best = top[0];
          attachedFile = best.path;
          const filename = attachedFile.split(/[/\\]/).pop() ?? "file";
          ctx.updateSession(sid, (prev) => ({
            messages: [
              ...prev.messages,
              {
                role: "assistant" as const,
                content: `${DISCOVERY_NOTICE_PREFIX} **${filename}**\nPath: \`${attachedFile}\`\nReading document content…`,
              },
            ],
          }));
        }
      } catch (err) {
        console.warn("Ambient search failed:", err);
      }
    }

    if (attachedFile) {
      updateArtifactMsg("SearchingDisk");
      const isSpreadsheet =
        attachedFile.endsWith(".csv") ||
        attachedFile.endsWith(".tsv") ||
        attachedFile.endsWith(".xlsx") ||
        attachedFile.endsWith(".xls") ||
        attachedFile.endsWith(".ods");

      if (isSpreadsheet) {
        try {
          const parsed = await Api.parseSpreadsheetData(attachedFile);
          const sheet = spreadsheetFromParsed(parsed.rows);
          if (sheet) {
            headers = sheet.headers;
            rows = sheet.rows;
            spreadsheetData = sheet;
          }
        } catch (err) {
          console.warn("Failed to parse spreadsheet file:", err);
        }
        if (!spreadsheetData) {
          try {
            const cached = await Api.getAmbientFileContent(attachedFile);
            if (cached) {
              ambientFileContent = formatAmbientFileSection(attachedFile, cached);
            }
          } catch (err) {
            console.warn("Failed to query Excel metadata cache:", err);
          }
        }
      } else {
        // Documents (PDF, DOCX, resume, etc.): cache first, then on-demand parse.
        const contentLimit =
          schemaId === "spreadsheet_synthesis"
            ? 20480
            : MAX_ARTIFACT_SOURCE_CHARS;
        const body = await loadAmbientFileBody(attachedFile, contentLimit);
        ambientFileContent = formatAmbientFileSection(attachedFile, body);
      }
    }

    // Ensure document text is loaded for PDF/DOC paths (index cache or search snippet may be incomplete).
    if (
      attachedFile &&
      !headers?.length &&
      !ambientFileContent &&
      /\.(pdf|docx|pptx|doc|ppt)$/i.test(attachedFile)
    ) {
      try {
        const fileContent = await Api.readFileText(attachedFile);
        const contentLimit =
          schemaId === "spreadsheet_synthesis" ? 20480 : 10240;
        ambientFileContent = fileContent.substring(0, contentLimit);
      } catch (err) {
        console.warn("Failed to read attached document for artifact context:", err);
      }
    }

    updateArtifactMsg("CrunchingMetrics");

    const contextWindowTokens = ctx.getContextWindowTokens(ctx.selectedModel);
    const webActive = Boolean(options?.webEnabled);

    let supplementalContext = "";

    let webHitsForImages: import("../types").SearchHit[] = [];
    const rowPlan =
      schemaId === "spreadsheet_synthesis"
        ? extractSpreadsheetRowCount(text)
        : { count: null, explicit: false };
    let deterministicWebPlan = null as ReturnType<
      typeof tryBuildDeterministicWebSpreadsheetPlan
    >;

    if (options?.ragEnabled && ctx.ragDocs.length > 0) {
      try {
        const setup = await Api.queryRagStream(text);
        if (setup.sources.length > 0) {
          supplementalContext +=
            "Knowledge base sources:\n" +
            setup.sources
              .map((source, index) => `Source ${index + 1} (${source.doc_title}):\n${source.text}`)
              .join("\n\n") +
            "\n\n";
        }
      } catch (err) {
        console.warn("RAG grounding for artifact generation failed:", err);
      }
    }

    if (options?.webEnabled) {
      try {
        const { fetchContent, maxResults } = webSearchOptionsForArtifact(
          schemaId,
          contextWindowTokens
        );
        const searchQuery = extractWebSearchQuery(text);
        const result = await Api.webSearch(searchQuery, maxResults, fetchContent);
        if (
          schemaId === "spreadsheet_synthesis" &&
          result.extracted_tables &&
          result.extracted_tables.length > 0
        ) {
          deterministicWebPlan = tryBuildDeterministicWebSpreadsheetPlan(
            result.extracted_tables,
            text,
            rowPlan.explicit ? rowPlan.count : null
          );
          if (deterministicWebPlan) {
            console.info(
              "Using deterministic web table for spreadsheet:",
              result.extracted_tables[0]?.source_url
            );
          }
        }
        if (result.formatted_context) {
          const webLimit = webContextCharLimit(contextWindowTokens);
          const trimmedWeb =
            result.formatted_context.length > webLimit
              ? result.formatted_context.slice(0, webLimit) +
                "\n\n[...web excerpts truncated for context limit]\n--- End of web sources ---\n"
              : result.formatted_context;
          supplementalContext +=
            webArtifactGroundingPreamble() + `${trimmedWeb}\n\n`;
        }
        webHitsForImages = result.results ?? [];
      } catch (err) {
        console.warn("Web grounding for artifact generation failed:", err);
      }
    }

    // When web grounding is active, cap document text so prompts fit 4k models.
    if (webActive && ambientFileContent) {
      const docCap = contextWindowTokens <= 4096 ? 3000 : 8000;
      ambientFileContent = ambientFileContent.substring(0, docCap);
    }

    const hasSourceData = Boolean(headers && headers.length > 0 && rows);

    if (
      schemaId === "spreadsheet_synthesis" &&
      deterministicWebPlan &&
      !hasSourceData
    ) {
      updateArtifactMsg("WritingCode");
      try {
        const result = await Api.generateSpreadsheet(deterministicWebPlan);
        ctx.updateSession(sid, {
          loading: false,
        });
        const filename = result.path.split(/[/\\]/).pop();
        updateArtifactMsg(
          "LivePreview",
          result.path,
          `Generated spreadsheet from verified web data: **${filename}**\nPath: \`${result.path}\``
        );
      } catch (execErr: unknown) {
        const message =
          execErr instanceof Error ? execErr.message : String(execErr);
        console.error("Deterministic web spreadsheet failed:", execErr);
        ctx.updateSession(sid, { loading: false });
        updateArtifactMsg(
          "Error",
          null,
          `Failed to build spreadsheet from web data: ${message}`
        );
      }
      return;
    }

    const imagePool = await buildArtifactImagePool({
      webHits: webHitsForImages,
      documentPath: attachedFile,
    });
    const imageCatalog = formatImageCatalogForPrompt(imagePool);

    let dataContext = supplementalContext;
    const hasSourceDocument =
      !!ambientFileContent &&
      !ambientFileContent.includes("(Content could not be extracted");
    if (schemaId === "spreadsheet_synthesis") {
      dataContext += buildSpreadsheetDataContext({
        headers: hasSourceData ? headers : undefined,
        rows: hasSourceData ? rows : undefined,
        ambientContent: !hasSourceData ? ambientFileContent : undefined,
      });
    } else if (headers && headers.length > 0) {
      if (spreadsheetData) {
        dataContext += buildHtmlDataContext(spreadsheetData, 12);
      } else {
        dataContext +=
          `Source data columns: [${headers.join(", ")}].\n` +
          `Number of rows: ${rows ? rows.length : 0}.\n\n`;
      }
    } else if (ambientFileContent) {
      if (schemaId === "presentation_synthesis" && hasSourceDocument) {
        dataContext +=
          `=== ATTACHED SOURCE DOCUMENT (authoritative — every slide must cite concrete facts from here) ===\n` +
          `${ambientFileContent}\n` +
          `=== END SOURCE DOCUMENT ===\n\n`;
      } else {
        dataContext += `Source data details:\n${ambientFileContent}\n\n`;
      }
    }

    const sourceDocumentRules =
      schemaId === "presentation_synthesis" && hasSourceDocument
        ? `
SOURCE DOCUMENT RULES (mandatory when source is provided in the user message):
- Every slide MUST reflect specific facts from the attached source document.
- Use the person's real name, employers, schools, skills, projects, and achievements from the source.
- Do NOT produce a generic template deck ("Resume Analysis Overview", "Key Skills", "Experience" as empty section headers).
- Do NOT use placeholder names or filler ("John Doe", "Company X", "Skill 1", "Lorem ipsum").
- Structure the deck to present what is actually in the document: introduction → experience → skills → education → highlights/summary.
- Pack each slide with concrete facts — sparse title-only slides are not acceptable when source text is available.
`
        : "";

    const slidePlan = extractSlideCount(text);
    const slideCountInstruction = slidePlan.explicit
      ? `Produce EXACTLY ${slidePlan.count} slides, as the user explicitly requested.`
      : `Produce a complete multi-slide deck of about ${slidePlan.count} slides (add or remove a few only if the topic clearly needs it).`;
    const themeHint = inferPresentationTheme(text);
    const htmlThemeHint = inferHtmlTheme(text);
    const htmlArchetype =
      schemaId === "html_synthesis" ? inferHtmlPageStructure(text) : "landing";
    const htmlHasSourceData =
      schemaId === "html_synthesis" && spreadsheetData !== null;

    const systemPrompt =
      schemaId === "html_synthesis"
        ? buildHtmlArtifactSystemPrompt(htmlArchetype, {
            hasSourceData: htmlHasSourceData,
            hasImages: imagePool.length > 0,
          })
        : schemaId === "spreadsheet_synthesis"
        ? buildSpreadsheetSystemPrompt(hasSourceData, rowPlan.count)
        : `You are a professional assistant that generates precise structural JSON plans for creating artifacts.
You must return ONLY a JSON object conforming to the schema contract. Do NOT include markdown formatting, code fences (e.g. \`\`\`json), or thinking/explanations.

Schema Contract:
{"slides": [{"title": "string", "layout": "TITLE" | "SECTION" | "BULLET" | "TWO_COLUMN" | "IMAGE_LEFT" | "STAT" | "QUOTE" | "CARDS" | "COMPARISON" | "CENTERED" | "BLANK", "bullets": ["string"], "notes": "string"}], "theme": "midnight" | "corporate" | "sunset" | "minimal" | "academic" | "cyber" | "ocean" | "forest" | "lavender" | "neon" | "rose" | "slate"}

Allowed Operations/Fields:
Layouts — choose the ONE that best fits each slide's content. Shape "bullets" to match the chosen layout:
- TITLE: cover slide. bullets[0] = subtitle; add bullets[1..] with 1-2 extra taglines or key highlights when source material is rich.
- SECTION: divider before a new part. title = section name; bullets = 1-3 intro lines with real detail from the source (not just the section name repeated).
- BULLET: 4-6 substantive bullet points (each 15-45 words). Never fewer than 4 bullets on a BULLET slide when source data exists.
- TWO_COLUMN: 4-8 points total (split across columns), each with concrete detail.
- IMAGE_LEFT: 4-6 substantive points beside the image. Set image_index when images are available.
- STAT: bullets[0] = the big metric/value; bullets[1..] = 2-4 supporting facts with numbers or specifics from the source.
- QUOTE: bullets[0] = full quote or key takeaway (1-3 sentences); bullets[1] = attribution; bullets[2..] = optional context lines.
- CARDS: 3-4 cards minimum. Format EACH bullet as "Label: 1-2 sentence description with specifics".
- COMPARISON: 6-10 bullets total (3-5 per side). Set left_title and right_title to meaningful names. First half = left side; second half = right side.
- CENTERED: title + 2-4 short paragraphs in bullets (each 1-2 sentences with real content).
- BLANK: avoid unless nothing else fits.

Use the optional "notes" field for extra detail that supports the slide; it will appear on the slide when bullets alone are sparse.

Themes — set the "theme" field to the ONE theme that best matches the topic tone:
- midnight (sleek dark/modern), corporate (professional navy), sunset (warm/vibrant marketing),
  minimal (clean light), academic (scholarly serif), cyber (tech/AI/futuristic), ocean (blue/health/calm),
  forest (green/nature/sustainability), lavender (creative/soft purple), neon (bold/gaming/entertainment),
  rose (elegant/luxury/fashion), slate (industrial/engineering monochrome).
Always choose the single best-fitting theme for the subject matter.

Deck requirements:
- ${slideCountInstruction}
- The FIRST slide must be TITLE; the LAST slide should be a CENTERED or SECTION conclusion / "Thank you" slide.
- DESIGN VARIETY IS REQUIRED: do NOT make every slide a BULLET list. Use at least 4 DIFFERENT layouts across the deck, and never use BULLET on more than ~1/3 of slides. Reach for STAT, QUOTE, CARDS, COMPARISON, IMAGE_LEFT, TWO_COLUMN, and CENTERED wherever the content fits.
- Pick the layout from the CONTENT: a metric → STAT, a key insight → QUOTE or CENTERED, distinct features/steps → CARDS, two options → COMPARISON, a visual topic → IMAGE_LEFT.
- Every content slide must cover a DISTINCT sub-topic; break the subject into a logical progression (intro → key points → details/examples → summary).
- CONTENT DENSITY: When source material is provided, fill each slide generously — prefer more specific bullets over sparse titles-only slides. Do not leave slides with only a heading and one vague line.
- Write substantive presentation text: 15-45 words per bullet where the layout allows; use multiple bullets rather than one short phrase.
- Include at least 1-2 IMAGE_LEFT slides when images are available in the catalog; set image_index accordingly.
- Use the optional "notes" field for brief speaker notes when helpful.${sourceDocumentRules}`;

    const themeSuffix = ` Use the "${themeHint}" theme for this deck.`;
    const rowCountSuffix =
      schemaId === "spreadsheet_synthesis" &&
      rowPlan.explicit &&
      rowPlan.count
        ? ` WRITE_DATA must contain EXACTLY ${rowPlan.count} data rows (not counting headers).`
        : "";
    const planRequest =
      schemaId === "presentation_synthesis"
        ? hasSourceDocument
          ? `Using the ATTACHED SOURCE DOCUMENT above, create a ${slidePlan.count}-slide presentation that explains the person or content in that document. User request: "${text}". Every slide must use real details from the source (name, roles, companies, skills, education) — never generic placeholders.${themeSuffix}`
          : `Generate a multi-slide presentation plan (${slidePlan.count} slides) for the user request: "${text}".${themeSuffix}`
        : schemaId === "html_synthesis"
        ? htmlPlanRequest(text, htmlArchetype, { hasSourceData: htmlHasSourceData })
        : `Generate a plan for the user request: "${text}".${rowCountSuffix}`;
    const spreadsheetContext =
      schemaId === "html_synthesis" && spreadsheetData
        ? buildHtmlDataContext(spreadsheetData)
        : "";
    const dataContextBody = `${dataContext}${spreadsheetContext}${imageCatalog}`;
    const planRequestText = planRequest;

    // Presentations need far more output room than a single artifact plan: budget
    // roughly per-slide so larger decks aren't truncated mid-array.
    const desiredPlanMaxTokens =
      schemaId === "presentation_synthesis"
        ? Math.min(
            8192,
            900 + slidePlan.count * 420 + (hasSourceDocument ? 1400 : 0)
          )
        : schemaId === "html_synthesis"
        ? HTML_PLAN_MAX_TOKENS
        : schemaId === "spreadsheet_synthesis"
        ? spreadsheetPlanMaxTokens(hasSourceData, ambientFileContent, rowPlan.count)
        : 500;

    const fitted = fitArtifactPlanPrompt({
      contextWindowTokens,
      systemPrompt,
      dataContext: dataContextBody,
      planRequest: planRequestText,
      desiredMaxOutputTokens: desiredPlanMaxTokens,
    });

    const planMaxTokens = fitted.maxOutputTokens;
    const planTemperature =
      schemaId === "html_synthesis" ? 0.4 : 0.1;

    let planJson = "";
    const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

    await Api.streamChat(
      [
        { role: "system", content: fitted.systemPrompt },
        { role: "user", content: fitted.userPrompt }
      ],
      (chunk) => {
        planJson += chunk;
      },
      () => {},
      async () => {
        updateArtifactMsg("WritingCode");
        try {
          let planObj: any;
          if (schemaId === "html_synthesis") {
            planObj = parseHtmlPlanJson(planJson, {
              prompt: text,
              archetype: htmlArchetype,
              theme: defaultThemeForArchetype(htmlArchetype),
            });
          } else if (schemaId === "spreadsheet_synthesis") {
            const sheetFallback = {
              prompt: text,
              hasSourceData: Boolean(headers && headers.length > 0 && rows),
              ambientContent: ambientFileContent || undefined,
            };
            try {
              planObj = parseSpreadsheetPlanJson(planJson, sheetFallback);
            } catch (parseErr) {
              const docFallback = buildSpreadsheetFallbackPlan(sheetFallback);
              if (docFallback) {
                console.warn(
                  "Spreadsheet parse failed; using document fallback:",
                  parseErr
                );
                planObj = docFallback;
              } else {
                throw parseErr;
              }
            }
          } else {
            try {
              planObj = parseArtifactPlanJson(planJson, {
                userPrompt: text,
                schemaId,
              });
            } catch (jsonErr) {
              console.warn("Failed to parse artifact plan JSON:", jsonErr);
              throw jsonErr;
            }
          }

          planObj = repairNestedKeys(planObj);

          if (schemaId === "html_synthesis") {
            planObj.archetype = htmlArchetype;
            planObj.theme = mapHtmlRendererTheme(
              planObj.theme || htmlThemeHint || defaultThemeForArchetype(htmlArchetype)
            );
            if (!planObj.title || String(planObj.title).trim() === "") {
              planObj.title = text.trim().slice(0, 120) || "Generated Page";
            }
            if (!Array.isArray(planObj.sections)) {
              planObj.sections = [];
            }
            if (spreadsheetData) {
              planObj = attachSpreadsheetToPlan(planObj, spreadsheetData);
            }
            if (imagePool.length) {
              planObj = attachImagesToHtmlPlan(planObj, imagePool);
            }
          }

          if (schemaId === "presentation_synthesis" && imagePool.length) {
            planObj = attachImagesToPresentationPlan(planObj, imagePool);
          }

          if (headers && rows && schemaId === "spreadsheet_synthesis") {
            planObj.headers = headers;
            planObj.source_rows = rows;
          }

          // The theme is decided directly from the prompt and is authoritative:
          // the same prompt always yields the same theme, chosen among all 12.
          if (schemaId === "presentation_synthesis") {
            planObj.theme = themeHint;
            planObj = normalizePresentationPlan(planObj, text);
            // Name the deck file after its title slide (falls back to the first
            // slide's title) instead of the generic "nela_presentation".
            if (!planObj.output_name) {
              const slides = Array.isArray(planObj.slides) ? planObj.slides : [];
              const titleSlide =
                slides.find((s: any) => s?.layout === "TITLE") ?? slides[0];
              const deckTitle = (titleSlide?.title ?? "").toString().trim();
              const slug = deckTitle
                .replace(/[\\/:*?"<>|]+/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 80);
              if (slug) planObj.output_name = slug;
            }
          }

          let result: ArtifactResult;
          if (schemaId === "spreadsheet_synthesis") {
            result = await Api.generateSpreadsheet(
              normalizeSpreadsheetPlan(planObj, {
                prompt: text,
                hasSourceData: Boolean(headers && headers.length > 0 && rows),
                expectedRowCount: rowPlan.count,
              })
            );
          } else if (schemaId === "presentation_synthesis") {
            result = await Api.generatePresentation(planObj);
          } else {
            result = await Api.generateHtml(planObj);
          }

          ctx.updateSession(sid, {
            loading: false,
          });

          const filename = result.path.split(/[/\\]/).pop();
          updateArtifactMsg("LivePreview", result.path, `Generated artifact successfully: **${filename}**\nPath: \`${result.path}\``);

        } catch (execErr: any) {
          console.error("Artifact generation execution failed:", execErr);
          ctx.updateSession(sid, {
            loading: false,
          });
          updateArtifactMsg("Error", null, `Failed to compile/execute artifact plan: ${execErr.message || execErr}`);
        }
      },
      (err) => {
        console.error("Artifact plan generation failed:", err);
        ctx.updateSession(sid, {
          loading: false,
        });
        updateArtifactMsg("Error", null, `Failed to generate artifact plan: ${err}`);
      },
      undefined,
      ctx.selectedModel || undefined,
      ctrl.signal,
      true,
      {
        ...generationOptions,
        maxTokens: planMaxTokens,
        temperature: planTemperature,
        grammar,
      }
    );

  } catch (err: any) {
    console.error("Artifact setup failed:", err);
    ctx.updateSession(sid, {
      loading: false,
    });
    updateArtifactMsg("Error", null, `Failed to initialize artifact creation: ${err.message || err}`);
  }
}

async function handleArtifactEdit(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  options?: { attachedPaths?: string[] }
): Promise<void> {
  const session = ctx.sessions.find((s) => s.id === sid);

  if (!artifactPath) {
    artifactPath = findSessionArtifactPath(session!) ?? "";
  }
  if (!artifactPath && options?.attachedPaths?.length) {
    artifactPath =
      options.attachedPaths.find(isEditableArtifactPath) ?? options.attachedPaths[0];
  }

  if (!artifactPath) {
    const searchQuery = extractAmbientSearchQuery(text);
    try {
      const results = await Api.searchAmbientFiles(searchQuery);
      const top = selectAmbientResultsForInjection(results ?? []);
      const match = top.find((r) => isEditableArtifactPath(r.path));
      if (match) artifactPath = match.path;
    } catch (err) {
      console.warn("Ambient search for artifact edit failed:", err);
    }
  }

  if (!artifactPath) {
    ctx.updateSession(sid, (prev) => ({
      loading: false,
      messages: [
        ...prev.messages,
        {
          role: "assistant" as const,
          content:
            "I couldn't find an HTML page, spreadsheet, or presentation to edit. " +
            "Open an artifact in the chat, attach a `.html` / `.xlsx` / `.pptx` file, or name the file path.",
        },
      ],
    }));
    return;
  }

  const editKind: ArtifactEditKind | null = artifactKindFromPath(artifactPath);
  if (!editKind) {
    ctx.updateSession(sid, (prev) => ({
      loading: false,
      messages: [
        ...prev.messages,
        {
          role: "assistant" as const,
          content: `Unsupported file type for editing: \`${artifactPath}\`. Supported: HTML, XLSX/CSV, PPTX.`,
        },
      ],
    }));
    return;
  }

  ctx.updateSession(sid, (prev) => ({
    loading: true,
    artifactStage: "CrunchingMetrics",
    messages: [
      ...prev.messages,
      {
        role: "assistant",
        content: `Applying edits to **${artifactPath.split(/[/\\]/).pop()}**: "${text}"`,
        artifactStage: "CrunchingMetrics",
        artifactPath,
      },
    ],
  }));

  const updateEditMsg = (
    stage: PipelineStageKind,
    path: string | null = null,
    contentOverride?: string
  ) => {
    ctx.updateSession(sid, (prev) => {
      const updated = [...prev.messages];
      const idx = updated
        .map((m, i) => ({ m, i }))
        .reverse()
        .find(({ m }) => m.role === "assistant" && m.artifactStage !== undefined)?.i;
      if (idx !== undefined && updated[idx]) {
        updated[idx] = {
          ...updated[idx],
          artifactStage: stage,
          ...(path !== null ? { artifactPath: path } : {}),
          ...(contentOverride !== undefined ? { content: contentOverride } : {}),
        };
      }
      return {
        artifactStage: stage,
        ...(path !== null ? { artifactPath: path } : {}),
        messages: updated,
      };
    });
  };

  const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

  try {
    let effectiveEditKind: ArtifactEditKind | null = editKind;
    if (editKind === "html") {
      try {
        const preview = await Api.readFileText(artifactPath);
        if (isNelaPresentationDeckHtml(preview)) {
          effectiveEditKind = "presentation_deck";
        }
      } catch (err) {
        console.warn("Could not inspect HTML artifact for deck format:", err);
      }
    }

    if (effectiveEditKind === "presentation_deck") {
      await runPresentationDeckEdit(
        text,
        artifactPath,
        sid,
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg
      );
      return;
    }

    if (effectiveEditKind === "html") {
      await runHtmlArtifactPatch(
        text,
        artifactPath,
        sid,
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg
      );
      return;
    }

    if (effectiveEditKind === "spreadsheet") {
      await runSpreadsheetArtifactEdit(
        text,
        artifactPath,
        sid,
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg
      );
      return;
    }

    await runPresentationArtifactEdit(
      text,
      artifactPath,
      sid,
      ctx,
      ctrl,
      generationOptions,
      updateEditMsg
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Artifact edit failed:", err);
    ctx.updateSession(sid, { loading: false });
    updateEditMsg("Error", null, `Failed to edit artifact: ${message}`);
  }
}

async function runPresentationDeckEdit(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  generationOptions: GenerationOptions,
  updateEditMsg: (
    stage: PipelineStageKind,
    path?: string | null,
    contentOverride?: string
  ) => void
): Promise<void> {
  const outputName = editedOutputName(artifactPath);

  // Fast path: insert slide(s) deterministically — no LLM, no diff patch.
  if (isPresentationSlideAddRequest(text)) {
    updateEditMsg("SearchingDisk");
    let parsedDeck: Awaited<ReturnType<typeof Api.parsePresentationDeck>>;
    try {
      parsedDeck = await Api.parsePresentationDeck(artifactPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.updateSession(sid, { loading: false });
      updateEditMsg("Error", null, `Could not parse presentation deck: ${message}`);
      return;
    }

    const position = parseSlideInsertIndex(text, parsedDeck.slideCount);
    const slideSpec = parseAddSlideFromPrompt(text, position.index);

    updateEditMsg("WritingCode");
    try {
      const result = await Api.editPresentationDeck({
        path: artifactPath,
        appendSlides: [
          {
            title: slideSpec.title,
            layout: slideSpec.layout,
            bullets: slideSpec.bullets,
          },
        ],
        insertAt: position.index,
        outputName,
      });
      ctx.updateSession(sid, { loading: false });
      const filename = result.path.split(/[/\\]/).pop();
      updateEditMsg(
        "LivePreview",
        result.path,
        `Added slide ${position.label}: **${slideSpec.title}** (${filename})`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.updateSession(sid, { loading: false });
      updateEditMsg("Error", null, `Failed to add slide: ${message}`);
    }
    return;
  }

  updateEditMsg("SearchingDisk");
  let parsedDeck: Awaited<ReturnType<typeof Api.parsePresentationDeck>>;
  try {
    parsedDeck = await Api.parsePresentationDeck(artifactPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.updateSession(sid, { loading: false });
    updateEditMsg("Error", null, `Could not parse presentation deck: ${message}`);
    return;
  }

  updateEditMsg("CrunchingMetrics");

  const grammar = await Api.getSchemaGrammar("presentation_synthesis");
  const themeHint = parsedDeck.theme ?? inferPresentationTheme(text);
  const slidesJson = JSON.stringify(parsedDeck.slides);

  const systemPrompt = `You are a professional assistant that EDITS existing presentation slide decks.
Return ONLY a JSON object with the FULL updated "slides" array — no markdown fences.

EDIT RULES:
- Start from the EXISTING SLIDES below; apply the user's requested changes.
- Preserve slides and content unless the user asks to remove or replace them.
- When adding slides, insert at the position the user specifies:
  * beginning / first / starting / opening → index 0
  * end / last / closing → append after final slide
  * before slide N → insert at index N-1 (1-based slide numbers)
  * after slide N → insert at index N
  * at slide N / position N → insert at index N-1
  * between slide A and B → insert at index A (after slide A)
- Keep real names, numbers, and facts — no placeholders.
- Each slide needs: title, layout, bullets (array of strings). Optional: notes.

Schema: {"slides": [{"title": "string", "layout": "TITLE" | "BULLET" | "CENTERED" | ..., "bullets": ["string"]}], "theme": "optional"}`;

  const userPrompt = `EXISTING SLIDES (${parsedDeck.slideCount} slides, theme: ${themeHint}):
${slidesJson}

User edit request: "${text}"

Return the complete updated slides array with the requested changes applied.`;

  let planJson = "";
  await Api.streamChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    (chunk) => {
      planJson += chunk;
    },
    () => {},
    async () => {
      updateEditMsg("WritingCode");
      try {
        let planObj = parseArtifactPlanJson(planJson, {
          userPrompt: text,
          schemaId: "presentation_synthesis",
        });
        planObj = repairNestedKeys(planObj);
        planObj.theme = themeHint;
        planObj = normalizePresentationPlan(planObj, text);

        const result = await Api.editPresentationDeck({
          path: artifactPath,
          replacementPlan: planObj,
          outputName,
        });

        ctx.updateSession(sid, { loading: false });
        const filename = result.path.split(/[/\\]/).pop();
        updateEditMsg(
          "LivePreview",
          result.path,
          `Updated presentation deck: **${filename}**`
        );
      } catch (execErr: unknown) {
        const message = execErr instanceof Error ? execErr.message : String(execErr);
        ctx.updateSession(sid, { loading: false });
        updateEditMsg("Error", null, `Failed to apply deck edits: ${message}`);
      }
    },
    (err) => {
      ctx.updateSession(sid, { loading: false });
      updateEditMsg("Error", null, `Failed to generate deck edit plan: ${err}`);
    },
    undefined,
    ctx.selectedModel || undefined,
    ctrl.signal,
    true,
    {
      ...generationOptions,
      maxTokens: 6144,
      temperature: 0.15,
      grammar,
    }
  );
}

async function runHtmlArtifactPatch(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  generationOptions: GenerationOptions,
  updateEditMsg: (
    stage: PipelineStageKind,
    path?: string | null,
    contentOverride?: string
  ) => void
): Promise<void> {
  const rawContent = await Api.readFileText(artifactPath);
  const currentContent = truncateForPatchEdit(rawContent, MAX_PATCH_SOURCE_CHARS);

  const systemPrompt = `You are a professional assistant that modifies HTML artifacts (pages and slide decks).
Generate a valid, minimal unified git-style diff (patch) to apply the user's modifications.
Do NOT output anything else — no markdown fences, no explanations. Start with raw unified diff hunk lines ("@@").

Original HTML (may be truncated in the middle for large files):
\`\`\`html
${currentContent}
\`\`\``;

  const userPrompt = `Generate a unified diff patch to: "${text}"`;

  let patchText = "";
  await Api.streamChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    (chunk) => {
      patchText += chunk;
    },
    () => {},
    async () => {
      updateEditMsg("WritingCode");
      try {
        let cleanPatch = patchText.trim();
        if (cleanPatch.startsWith("```")) {
          const lines = cleanPatch.split("\n");
          if (lines[0].startsWith("```")) lines.shift();
          if (lines[lines.length - 1] === "```") lines.pop();
          cleanPatch = lines.join("\n").trim();
        }

        await Api.applyDiffPatch(artifactPath, cleanPatch);

        import("@tauri-apps/api/event").then(({ emit }) => {
          emit("artifact-patch", { patch: cleanPatch, path: artifactPath });
        });

        ctx.updateSession(sid, { loading: false });
        const filename = artifactPath.split(/[/\\]/).pop();
        updateEditMsg(
          "LivePreview",
          artifactPath,
          `Updated **${filename}** with your changes.`
        );
      } catch (execErr: unknown) {
        const message = execErr instanceof Error ? execErr.message : String(execErr);
        ctx.updateSession(sid, { loading: false });
        updateEditMsg("Error", null, `Failed to apply HTML patch: ${message}`);
      }
    },
    (err) => {
      ctx.updateSession(sid, { loading: false });
      updateEditMsg("Error", null, `Failed to generate HTML patch: ${err}`);
    },
    undefined,
    ctx.selectedModel || undefined,
    ctrl.signal,
    true,
    {
      ...generationOptions,
      maxTokens: 2048,
      temperature: 0.1,
    }
  );
}

async function runSpreadsheetArtifactEdit(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  generationOptions: GenerationOptions,
  updateEditMsg: (
    stage: PipelineStageKind,
    path?: string | null,
    contentOverride?: string
  ) => void
): Promise<void> {
  updateEditMsg("SearchingDisk");

  let headers: string[] = [];
  let rows: string[][] = [];

  if (artifactPath.endsWith(".csv") || artifactPath.endsWith(".tsv")) {
    const fileContent = await Api.readFileText(artifactPath);
    const parsed = parseCSV(fileContent);
    headers = parsed.headers;
    rows = parsed.rows.slice(0, MAX_EDIT_SPREADSHEET_ROWS);
  } else {
    const parsed = await Api.parseSpreadsheetData(
      artifactPath,
      MAX_EDIT_SPREADSHEET_ROWS
    );
    const sheet = spreadsheetFromParsed(parsed.rows);
    if (sheet) {
      headers = sheet.headers;
      rows = sheet.rows;
    }
  }

  if (!headers.length) {
    ctx.updateSession(sid, { loading: false });
    updateEditMsg("Error", null, "Could not read spreadsheet data from the file.");
    return;
  }

  updateEditMsg("CrunchingMetrics");

  const grammar = await Api.getSchemaGrammar("spreadsheet_synthesis");
  const sampleContext = buildSpreadsheetEditSample(headers, rows);
  const outputName = editedOutputName(artifactPath);

  const systemPrompt = `You are a professional assistant that EDITS existing spreadsheets via a JSON plan.
Return ONLY a JSON object — no markdown fences or explanations.

EDIT MODE RULES:
- Preserve all existing data unless the user asks to remove or replace it.
- Prefer spreadsheet ops (SUM_COLUMN, ADD_COLUMN, FILTER_ROWS, SORT_ASC, SORT_DESC, etc.) over rewriting data.
- Use WRITE_DATA only when the user requests wholesale data replacement or cell edits that ops cannot express.
- When using WRITE_DATA, include the COMPLETE updated dataset (headers + all rows).
- Do NOT invent columns that are not in the source unless the user asks for them.

Schema: {"ops": [{"op": "SUM_COLUMN" | "AVERAGE_BY_GROUP" | "PIVOT" | "SORT_DESC" | "SORT_ASC" | "FILTER_ROWS" | "COUNT_BY_GROUP" | "ADD_COLUMN" | "RENAME_SHEET" | "WRITE_DATA", ...}]}`;

  const userPrompt = `Existing spreadsheet (file: ${artifactPath.split(/[/\\]/).pop()}):
${sampleContext}

User edit request: "${text}"

Produce a plan that applies the requested changes to this spreadsheet.`;

  let planJson = "";
  await Api.streamChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    (chunk) => {
      planJson += chunk;
    },
    () => {},
    async () => {
      updateEditMsg("WritingCode");
      try {
        let planObj = parseArtifactPlanJson(planJson, {
          userPrompt: text,
          schemaId: "spreadsheet_synthesis",
        });
        planObj = repairNestedKeys(planObj);
        planObj.headers = headers;
        planObj.source_rows = rows;
        planObj.output_name = outputName;

        const hasWriteData = Array.isArray(planObj.ops)
          && planObj.ops.some(
            (op: { op?: string }) => String(op?.op ?? "").toUpperCase() === "WRITE_DATA"
          );
        if (hasWriteData) {
          const writeOp = (planObj.ops as Array<{ op?: string; headers?: string[]; rows?: string[][] }>).find(
            (op) => String(op?.op ?? "").toUpperCase() === "WRITE_DATA"
          );
          if (writeOp?.headers?.length) {
            planObj.headers = writeOp.headers;
          }
          if (writeOp?.rows?.length) {
            planObj.source_rows = writeOp.rows;
          }
        }

        const result = await Api.generateSpreadsheet(
          normalizeSpreadsheetPlan(planObj, {
            prompt: text,
            hasSourceData: true,
          })
        );
        ctx.updateSession(sid, { loading: false });
        const filename = result.path.split(/[/\\]/).pop();
        updateEditMsg(
          "LivePreview",
          result.path,
          `Updated spreadsheet: **${filename}**\nPath: \`${result.path}\``
        );
      } catch (execErr: unknown) {
        const message = execErr instanceof Error ? execErr.message : String(execErr);
        ctx.updateSession(sid, { loading: false });
        updateEditMsg("Error", null, `Failed to apply spreadsheet edits: ${message}`);
      }
    },
    (err) => {
      ctx.updateSession(sid, { loading: false });
      updateEditMsg("Error", null, `Failed to generate spreadsheet edit plan: ${err}`);
    },
    undefined,
    ctx.selectedModel || undefined,
    ctrl.signal,
    true,
    {
      ...generationOptions,
      maxTokens: 4096,
      temperature: 0.1,
      grammar,
    }
  );
}

async function runPresentationArtifactEdit(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  generationOptions: GenerationOptions,
  updateEditMsg: (
    stage: PipelineStageKind,
    path?: string | null,
    contentOverride?: string
  ) => void
): Promise<void> {
  updateEditMsg("SearchingDisk");

  let sourceContext = "";
  if (artifactPath.endsWith(".html") || artifactPath.endsWith(".htm")) {
    const html = await Api.readFileText(artifactPath);
    sourceContext = truncateForPatchEdit(html, MAX_ARTIFACT_SOURCE_CHARS);
  } else {
    const body = await loadAmbientFileBody(artifactPath, MAX_ARTIFACT_SOURCE_CHARS);
    sourceContext = formatAmbientFileSection(artifactPath, body);
  }

  updateEditMsg("CrunchingMetrics");

  const grammar = await Api.getSchemaGrammar("presentation_synthesis");
  const themeHint = inferPresentationTheme(text);
  const outputName = editedOutputName(artifactPath);

  const systemPrompt = `You are a professional assistant that EDITS existing presentations via a JSON slide plan.
Return ONLY JSON — no markdown fences or explanations.

EDIT MODE RULES:
- Start from the EXISTING content below; apply the user's requested changes.
- Preserve slide order and topics unless the user asks to add, remove, or reorder slides.
- Keep real names, numbers, and facts from the source — do not replace with placeholders.
- When adding slides, pick varied layouts (BULLET, STAT, CARDS, COMPARISON, etc.).

Schema: {"slides": [{"title": "string", "layout": "TITLE" | "SECTION" | "BULLET" | "TWO_COLUMN" | "IMAGE_LEFT" | "STAT" | "QUOTE" | "CARDS" | "COMPARISON" | "CENTERED" | "BLANK", "bullets": ["string"], "notes": "string"}], "theme": "midnight" | "corporate" | "sunset" | "minimal" | "academic" | "cyber" | "ocean" | "forest" | "lavender" | "neon" | "rose" | "slate"}`;

  const userPrompt = `=== EXISTING PRESENTATION CONTENT (authoritative baseline) ===
${sourceContext}
=== END EXISTING CONTENT ===

User edit request: "${text}"

Produce an updated presentation plan that applies these edits. Use the "${themeHint}" theme unless the user specifies another style.`;

  let planJson = "";
  await Api.streamChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    (chunk) => {
      planJson += chunk;
    },
    () => {},
    async () => {
      updateEditMsg("WritingCode");
      try {
        let planObj = parseArtifactPlanJson(planJson, {
          userPrompt: text,
          schemaId: "presentation_synthesis",
        });
        planObj = repairNestedKeys(planObj);
        planObj.theme = themeHint;
        planObj = normalizePresentationPlan(planObj, text);
        planObj.output_name = outputName;

        const result = await Api.generatePresentation(planObj);
        ctx.updateSession(sid, { loading: false });
        const filename = result.path.split(/[/\\]/).pop();
        updateEditMsg(
          "LivePreview",
          result.path,
          `Updated presentation: **${filename}**\nPath: \`${result.path}\``
        );
      } catch (execErr: unknown) {
        const message = execErr instanceof Error ? execErr.message : String(execErr);
        ctx.updateSession(sid, { loading: false });
        updateEditMsg("Error", null, `Failed to apply presentation edits: ${message}`);
      }
    },
    (err) => {
      ctx.updateSession(sid, { loading: false });
      updateEditMsg("Error", null, `Failed to generate presentation edit plan: ${err}`);
    },
    undefined,
    ctx.selectedModel || undefined,
    ctrl.signal,
    true,
    {
      ...generationOptions,
      maxTokens: 6144,
      temperature: 0.15,
      grammar,
    }
  );
}

/**
 * Decide how many slides a presentation deck should contain.
 *
 * Honors an explicit count in the prompt (e.g. "make a 7 slide deck",
 * "10-slide presentation", "slides: 8"), clamped to a sane range. Falls back
 * to a default when the user doesn't specify a number.
 *
 * Returns the resolved count plus whether it was explicitly requested so the
 * prompt can phrase the instruction accordingly.
 */
function extractSlideCount(text: string): { count: number; explicit: boolean } {
  const MIN_SLIDES = 3;
  const MAX_SLIDES = 20;
  const DEFAULT_SLIDES = 6;

  const lower = text.toLowerCase();

  const explicitMatch =
    lower.match(/(\d{1,2})\s*-?\s*slides?\b/) ||
    lower.match(/\bslides?\s*[:=]?\s*(\d{1,2})\b/) ||
    lower.match(/\b(\d{1,2})\s*-?\s*slide\b/);

  if (explicitMatch) {
    const n = parseInt(explicitMatch[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      return {
        count: Math.min(MAX_SLIDES, Math.max(MIN_SLIDES, n)),
        explicit: true,
      };
    }
  }

  return { count: DEFAULT_SLIDES, explicit: false };
}

/** The complete set of presentation themes supported by the renderer. */
const PRESENTATION_THEMES = [
  "midnight",
  "corporate",
  "sunset",
  "minimal",
  "academic",
  "cyber",
  "ocean",
  "forest",
  "lavender",
  "neon",
  "rose",
  "slate",
] as const;

type PresentationTheme = (typeof PRESENTATION_THEMES)[number];

/**
 * Maps each theme to keyword groups. The first group holds the explicit theme
 * names/aliases (highest priority); the second holds topic/domain keywords so a
 * theme can be inferred from the subject matter even when no style is named.
 */
const THEME_KEYWORDS: Record<PresentationTheme, { aliases: string[]; topics: string[] }> = {
  corporate: {
    aliases: ["corporate", "business", "professional", "executive", "formal", "enterprise"],
    topics: ["strategy", "quarterly", "revenue", "sales", "finance", "investor", "stakeholder", "roi", "market share", "company", "startup", "pitch deck", "kpi", "b2b"],
  },
  academic: {
    aliases: ["academic", "research", "university", "thesis", "serif", "scholarly", "scholar", "dissertation"],
    topics: ["study", "literature", "hypothesis", "methodology", "paper", "history", "philosophy", "education", "lecture", "curriculum", "experiment", "citation"],
  },
  cyber: {
    aliases: ["cyber", "tech", "hacker", "matrix", "futuristic", "sci-fi", "scifi"],
    topics: ["ai", "machine learning", "artificial intelligence", "software", "programming", "cybersecurity", "security", "blockchain", "crypto", "cloud", "devops", "data science", "neural", "algorithm", "robotics", "quantum"],
  },
  ocean: {
    aliases: ["ocean", "aqua", "marine", "blue", "sea", "water"],
    topics: ["health", "wellness", "medical", "medicine", "healthcare", "ocean", "water", "climate ocean", "fishery", "diving", "hydro", "calm", "meditation"],
  },
  forest: {
    aliases: ["forest", "nature", "eco", "green", "organic"],
    topics: ["environment", "sustainability", "climate", "renewable", "ecology", "biology", "agriculture", "conservation", "carbon", "green energy", "plant", "wildlife", "farming"],
  },
  sunset: {
    aliases: ["sunset", "warm", "vibrant", "colorful", "energetic"],
    topics: ["marketing", "campaign", "branding", "social media", "advertising", "growth", "launch", "event", "festival", "travel", "food", "lifestyle"],
  },
  lavender: {
    aliases: ["lavender", "purple", "violet", "dreamy", "soft"],
    topics: ["creativity", "art", "storytelling", "writing", "poetry", "imagination", "wedding", "beauty", "spa"],
  },
  neon: {
    aliases: ["neon", "electric", "bright", "bold", "punchy", "loud"],
    topics: ["gaming", "game", "esports", "music", "concert", "nightlife", "entertainment", "streaming", "youth", "party", "hype"],
  },
  rose: {
    aliases: ["rose", "pink", "elegant", "luxury", "luxurious", "premium"],
    topics: ["fashion", "luxury", "cosmetics", "jewelry", "romance", "valentine", "boutique", "couture", "perfume"],
  },
  slate: {
    aliases: ["slate", "gray", "grey", "mono", "monochrome", "neutral", "industrial"],
    topics: ["engineering", "architecture", "manufacturing", "logistics", "infrastructure", "hardware", "construction", "operations", "supply chain", "report"],
  },
  minimal: {
    aliases: ["minimal", "minimalist", "clean", "simple", "light theme", "white background", "plain"],
    topics: ["overview", "summary", "introduction", "getting started", "basics", "tutorial", "guide", "checklist"],
  },
  midnight: {
    aliases: ["midnight", "dark", "default", "sleek", "modern"],
    topics: ["product", "roadmap", "vision", "future", "innovation", "general", "tech demo"],
  },
};

/** Small stable string hash (djb2) for deterministic theme fallback. */
function hashString(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Decide a presentation theme DIRECTLY from the prompt, always returning one of
 * the 12 supported themes. Resolution order:
 *   1. Explicit theme name/alias in the prompt (e.g. "neon", "corporate").
 *   2. Topic/domain keywords inferred from the subject (e.g. "AI" -> cyber).
 *   3. Stable hash of the prompt across all 12 themes (deterministic + varied).
 * The result is stable: the same prompt always maps to the same theme.
 */
function inferPresentationTheme(text: string): PresentationTheme {
  const lower = text.toLowerCase();

  // 1. Explicit theme name / alias wins.
  for (const theme of PRESENTATION_THEMES) {
    if (THEME_KEYWORDS[theme].aliases.some((kw) => lower.includes(kw))) {
      return theme;
    }
  }

  // 2. Topic / domain keyword inference — score each theme by keyword hits.
  let best: PresentationTheme | null = null;
  let bestScore = 0;
  for (const theme of PRESENTATION_THEMES) {
    const score = THEME_KEYWORDS[theme].topics.reduce(
      (acc, kw) => (lower.includes(kw) ? acc + 1 : acc),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      best = theme;
    }
  }
  if (best) {
    return best;
  }

  // 3. Deterministic fallback: stable across runs, varied across prompts.
  const idx = hashString(lower.trim()) % PRESENTATION_THEMES.length;
  return PRESENTATION_THEMES[idx];
}

function parseCSV(content: string): { headers: string[]; rows: string[][] } {
  const lines = content.split(/\r?\n/).map(line => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += c;
      }
    }
    result.push(current.trim());
    return result;
  }).filter(line => line.length > 0 && line.some(cell => cell !== ""));

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = lines[0];
  const rows = lines.slice(1);
  return { headers, rows };
}

function repairNestedKeys(obj: any): any {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(repairNestedKeys);
  }

  const repaired: any = {};
  for (const key of Object.keys(obj)) {
    let newKey = key;
    const lower = key.toLowerCase();

    // Map common misspellings of functional schema keys
    if (lower === "column" || lower === "col_name" || lower === "target_col" || lower === "cols" || lower === "colname") {
      newKey = "col";
    } else if (lower === "group" || lower === "group_column" || lower === "groupcol" || lower === "by_col" || lower === "group_by" || lower === "by") {
      newKey = "group_col";
    } else if (lower === "value" || lower === "value_column" || lower === "val_col" || lower === "valcol" || lower === "val") {
      newKey = "value_col";
    } else if (lower === "row_column" || lower === "rowcol") {
      newKey = "row_col";
    } else if (lower === "column_column" || lower === "column_col" || lower === "colcol") {
      newKey = "col_col";
    } else if (lower === "expression" || lower === "expr" || lower === "calc") {
      newKey = "formula";
    }

    repaired[newKey] = repairNestedKeys(obj[key]);
  }

  // Operation-specific structural repair
  if (repaired.op) {
    const op = String(repaired.op).toUpperCase();
    repaired.op = op; // Ensure uppercase

    if (op === "COUNT_BY_GROUP") {
      // COUNT_BY_GROUP expects group_col. If model generated col/column (which mapped to col), move it.
      if (repaired.col && !repaired.group_col) {
        repaired.group_col = repaired.col;
        delete repaired.col;
      }
    } else if (op === "AVERAGE_BY_GROUP") {
      if (repaired.col && !repaired.group_col) {
        repaired.group_col = repaired.col;
        delete repaired.col;
      }
    } else if (op === "SUM_COLUMN" || op === "SORT_DESC" || op === "SORT_ASC" || op === "FILTER_ROWS") {
      if (repaired.group_col && !repaired.col) {
        repaired.col = repaired.group_col;
        delete repaired.group_col;
      }
    }
  }

  return repaired;
}

