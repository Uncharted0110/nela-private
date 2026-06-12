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
import { extractTaskText, parseMindMapGraph, extractJsonObject } from "./mindmapUtils";
import { deriveTitleFromMessage } from "./sessionUtils";
import {
  applyCompactionResultToSession,
  CONTEXT_COMPACTION_KEEP_RECENT,
  CONTEXT_COMPACTION_THRESHOLD,
  resolveReservedOutputTokens,
  toContextMessages,
} from "./contextCompaction";

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

  const currentVisionImagePath = ctx.chatMode === "vision" ? ctx.imagePath : null;
  const ragDocPaths = ctx.ragDocs.map((doc) => doc.file_path).filter((path) => !!path);
  const promptDocumentPaths =
    ctx.chatMode === "text" && !ctx.ragEnabled
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
    content: text,
    ...(visionAttachment ? { visionImage: visionAttachment } : {}),
    ...(directDocAttachments && directDocAttachments.length > 0
      ? { directDocuments: directDocAttachments }
      : {}),
  };

  const isFirstMessage = session.messages.length === 0;
  const titlePatch = isFirstMessage ? { title: deriveTitleFromMessage(text) } : {};

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

  let resolvedIntentKind = "";
  // ── Intent Resolution (Revamp P3/P5) ──────────────────────────────────────
  if (ctx.chatMode === "text") {
    try {
      const intent = await Api.resolveIntent(text);
      resolvedIntentKind = intent.kind.kind;
      if (intent.kind.kind === "Artifact") {
        const { tool, schema_id } = intent.kind;
        await handleArtifactGeneration(text, tool, schema_id, sid, ctx, ctrl);
        return;
      }
      if (intent.kind.kind === "Patch") {
        const { artifact_path } = intent.kind;
        await handlePatchApplication(text, artifact_path || "", sid, ctx, ctrl);
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
          query: text,
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
            const setup = await Api.queryRagStream(text);
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
              `User query: ${text}`,
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
              `User query: ${text}`,
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
            graph = parseMindMapGraph(modelText, text, generatedFrom, sourceCount);
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
          query: text,
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

    if (ctx.chatMode === "text" && !ctx.ragEnabled && promptDocumentPaths.length > 0) {
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
          text,
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

    if (ctx.chatMode === "text" && ctx.ragEnabled && ctx.ragDocs.length > 0) {
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

        const setup = await Api.queryRagStream(text);
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
          text ||
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
    if (ctx.chatMode === "text" && ctx.webEnabled) {
      try {
        const fetchContent = ctx.webDepth === "full";
        const maxResults = fetchContent ? 2 : 5;
        const result = await Api.webSearch(text.slice(0, 150), maxResults, fetchContent);
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

    if (ctx.chatMode === "text" && !attachedFile) {
      if (resolvedIntentKind === "FileSearch" || hasSearchKeywords(text)) {
        const searchQuery = extractSearchQuery(text);
        try {
          const results = await Api.searchAmbientFiles(searchQuery);
          if (results && results.length > 0) {
            // Find first file that is not a directory, preferably text/code or spreadsheet
            const fileToRead = results.find(
              (f) =>
                !f.is_dir &&
                (f.path.endsWith(".csv") ||
                  f.path.endsWith(".xlsx") ||
                  f.path.endsWith(".xls") ||
                  f.path.endsWith(".txt") ||
                  f.path.endsWith(".md"))
            ) || results.find((f) => !f.is_dir) || results[0];

            if (fileToRead && !fileToRead.is_dir) {
              attachedFile = fileToRead.path;
              const filename = attachedFile.split(/[/\\]/).pop() ?? "file";

              discoveryMsg = {
                role: "assistant" as const,
                content: `🔍 Discovered matching system file: **${filename}**\nPath: \`${attachedFile}\`\nReading file content...`,
              };

              ctx.updateSession(sid, (prev) => ({
                messages: [...prev.messages, discoveryMsg!],
              }));

              // Extract text or headers
              if (attachedFile.endsWith(".csv") || attachedFile.endsWith(".tsv")) {
                try {
                  const fileContent = await Api.readFileText(attachedFile);
                  const parsed = parseCSV(fileContent);
                  if (parsed.headers.length > 0) {
                    ambientFileContext = `Metadata/Content for CSV file "${filename}" (Path: ${attachedFile}):\n` +
                      `Columns: [${parsed.headers.join(", ")}].\n` +
                      `First few rows of content:\n` +
                      parsed.rows.slice(0, 10).map(row => row.join(", ")).join("\n");
                  }
                } catch (err) {
                  console.warn("Failed to read CSV in standard chat:", err);
                }
              } else if (
                attachedFile.endsWith(".xlsx") ||
                attachedFile.endsWith(".xls") ||
                attachedFile.endsWith(".ods")
              ) {
                try {
                  const cached = await Api.getAmbientFileContent(attachedFile);
                  if (cached) {
                    ambientFileContext = `Metadata/Schema for Excel file "${filename}" (Path: ${attachedFile}):\n${cached}`;
                  }
                } catch (err) {
                  console.warn("Failed to query Excel metadata cache in standard chat:", err);
                }
              } else {
                // Plain text / markdown files
                try {
                  const fileContent = await Api.readFileText(attachedFile);
                  ambientFileContext = `Content of file "${filename}" (Path: ${attachedFile}, showing first 10KB):\n${fileContent.substring(0, 10240)}`;
                } catch (err) {
                  console.warn("Failed to read text file in standard chat:", err);
                }
              }
            }
          }
        } catch (err) {
          console.warn("Ambient search in standard chat failed:", err);
        }

        // If file search intent was detected but no file was found/read,
        // inject a system message to prevent the model from hallucinating.
        if (!ambientFileContext && !attachedFile) {
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
      ...(discoveryMsg ? [discoveryMsg] : []),
    ];
    let apiMessages = toContextMessages(fullSessionMessages);

    // Prepend ambient file search context as a system message so the model has the file contents
    if (ambientFileContext === "FILE_SEARCH_NO_RESULTS") {
      apiMessages = [
        { role: "system", content: "The user appears to be asking about a specific file on their system. A search of the local file index returned no matching files. Tell the user that you could not find the file they are looking for. Do NOT make up information or pretend to have read the file. Suggest they check the filename or attach the file directly." },
        ...apiMessages,
      ];
    } else if (ambientFileContext) {
      apiMessages = [
        { role: "system", content: `You have access to the following local file content retrieved from the user's system:\n\n${ambientFileContext}\n\nUse this information to answer the user's query.` },
        ...apiMessages,
      ];
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
  ctrl: AbortController
): Promise<void> {
  ctx.updateSession(sid, (prev) => ({
    loading: true,
    artifactVisible: false,
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
    let ambientFileContent = "";

    let attachedFile = ctx.directDocumentPaths.length > 0 ? ctx.directDocumentPaths[0] : null;

    // Proactive ambient FTS5 search if no file is attached but query requests finding files
    if (!attachedFile && hasSearchKeywords(text)) {
      updateArtifactMsg("SearchingDisk");
      const searchQuery = extractSearchQuery(text);
      try {
        const results = await Api.searchAmbientFiles(searchQuery);
        if (results && results.length > 0) {
          // Find first file that is not a directory, preferably spreadsheets
          const fileToRead = results.find(
            (f) =>
              !f.is_dir &&
              (f.path.endsWith(".csv") ||
                f.path.endsWith(".xlsx") ||
                f.path.endsWith(".xls") ||
                f.path.endsWith(".txt") ||
                f.path.endsWith(".md"))
          ) || results.find((f) => !f.is_dir) || results[0];

          if (fileToRead && !fileToRead.is_dir) {
            attachedFile = fileToRead.path;
            const filename = attachedFile.split(/[/\\]/).pop();
            ctx.updateSession(sid, (prev) => ({
              messages: [
                ...prev.messages,
                {
                  role: "assistant" as const,
                  content: `🔍 Discovered matching system file: **${filename}**\nPath: \`${attachedFile}\`\nReading schema and metadata...`,
                },
              ],
            }));
          }
        }
      } catch (err) {
        console.warn("Ambient search failed:", err);
      }
    }

    if (attachedFile) {
      updateArtifactMsg("SearchingDisk");
      if (attachedFile.endsWith(".csv") || attachedFile.endsWith(".tsv")) {
        try {
          const fileContent = await Api.readFileText(attachedFile);
          const parsed = parseCSV(fileContent);
          headers = parsed.headers;
          rows = parsed.rows;
        } catch (err) {
          console.warn("Failed to read/parse CSV file:", err);
        }
      } else if (
        attachedFile.endsWith(".xlsx") ||
        attachedFile.endsWith(".xls") ||
        attachedFile.endsWith(".ods")
      ) {
        try {
          // Query cached Excel sheet/column metadata from FTS5 index database
          const cached = await Api.getAmbientFileContent(attachedFile);
          if (cached) {
            ambientFileContent = cached;
          }
        } catch (err) {
          console.warn("Failed to query Excel metadata cache:", err);
        }
      } else {
        // Plain text files
        try {
          const fileContent = await Api.readFileText(attachedFile);
          ambientFileContent = fileContent.substring(0, 10240);
        } catch (err) {
          console.warn("Failed to read text file:", err);
        }
      }
    }

    updateArtifactMsg("CrunchingMetrics");

    let dataContext = "";
    if (headers && headers.length > 0) {
      dataContext = `Source data columns: [${headers.join(", ")}].\n` +
        `Number of rows: ${rows ? rows.length : 0}.\n\n`;
    } else if (ambientFileContent) {
      dataContext = `Source data details:\n${ambientFileContent}\n\n`;
    }

    const systemPrompt = `You are a professional assistant that generates precise structural JSON plans for creating artifacts.
You must return ONLY a JSON object conforming to the schema contract. Do NOT include markdown formatting, code fences (e.g. \`\`\`json), or thinking/explanations.

Schema Contract:
${schemaId === "spreadsheet_synthesis" 
  ? `{"ops": [{"op": "SUM_COLUMN" | "AVERAGE_BY_GROUP" | "PIVOT" | "SORT_DESC" | "SORT_ASC" | "FILTER_ROWS" | "COUNT_BY_GROUP" | "ADD_COLUMN" | "RENAME_SHEET" | "WRITE_DATA", ...}]}` 
  : schemaId === "presentation_synthesis"
  ? `{"slides": [{"title": "string", "layout": "TITLE" | "BULLET" | "TWO_COLUMN" | "IMAGE_LEFT" | "BLANK", "bullets": ["string"], "notes": "string"}]}`
  : `{"html": "string", "output_name": "string"}`
}

Allowed Operations/Fields:
${schemaId === "spreadsheet_synthesis"
  ? `- SUM_COLUMN: { "col": "col_name", "label": "optional_label" }
- AVERAGE_BY_GROUP: { "value_col": "col_name", "group_col": "col_name" }
- PIVOT: { "row_col": "col_name", "col_col": "col_name", "value_col": "col_name" }
- SORT_DESC: { "col": "col_name" }
- SORT_ASC: { "col": "col_name" }
- FILTER_ROWS: { "col": "col_name", "value": "value_to_match" }
- COUNT_BY_GROUP: { "group_col": "col_name" }
- ADD_COLUMN: { "name": "new_col_name", "formula": "simple_formula" }
- RENAME_SHEET: { "name": "new_sheet_name" }
- WRITE_DATA: { "headers": ["col1", "col2", ...], "rows": [["row1_val1", "row1_val2", ...], ["row2_val1", "row2_val2", ...]] }
  Use WRITE_DATA to write raw headers and rows of data into the spreadsheet. If there is no input data/file attached, you MUST use WRITE_DATA first to populate the sheet. You can also use WRITE_DATA to add/write data even when attached files/source data are present.`
  : schemaId === "presentation_synthesis"
  ? `- TITLE: title slide
- BULLET: title + bullet points
- TWO_COLUMN: title + bullet points for two columns
- IMAGE_LEFT: image on left, text on right
- BLANK: empty layout`
  : `- html: The complete raw HTML content to render. Make it visually stunning, responsive, using modern UI styling (rounded borders, harmonized HSL/RGB colors, clean typography, glassmorphism if appropriate) and functional script logic if needed. Do not use raw tailwind unless standard CSS is used inside <style>.
- output_name: Optional hint for the filename without extension.`
}
`;

    const userPrompt = `${dataContext}Generate a plan for the user request: "${text}"`;

    let planJson = "";
    const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

    await Api.streamChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      (chunk) => {
        planJson += chunk;
      },
      () => {},
      async () => {
        updateArtifactMsg("WritingCode");
        try {
          let planObj: any;
          try {
            const cleanedText = extractJsonObject(planJson);
            if (!cleanedText) {
              throw new Error("No valid JSON object found in model output.");
            }
            planObj = JSON.parse(cleanedText);
          } catch (jsonErr) {
            console.warn("Failed to parse JSON directly, cleaning up markdown fences:", jsonErr);
            const cleaned = planJson.replace(/```json|```/g, "").trim();
            const cleaned2 = extractJsonObject(cleaned) || cleaned;
            planObj = JSON.parse(cleaned2);
          }

          planObj = repairNestedKeys(planObj);

          if (headers && rows) {
            planObj.headers = headers;
            planObj.source_rows = rows;
          }

          let result: ArtifactResult;
          if (schemaId === "spreadsheet_synthesis") {
            result = await Api.generateSpreadsheet(planObj);
          } else if (schemaId === "presentation_synthesis") {
            result = await Api.generatePresentation(planObj);
          } else {
            result = await Api.generateHtml(planObj);
          }

          ctx.updateSession(sid, {
            loading: false,
            artifactVisible: false,
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
      ctrl.signal,
      true,
      {
        ...generationOptions,
        maxTokens: 500,
        temperature: 0.1,
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

async function handlePatchApplication(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController
): Promise<void> {
  if (!artifactPath) {
    // If no path was resolved, fall back to default artifact path in session
    const session = ctx.sessions.find((s) => s.id === sid);
    artifactPath = session?.artifactPath || "";
  }

  if (!artifactPath) {
    console.warn("No active artifact to patch.");
    return;
  }

  ctx.updateSession(sid, (prev) => ({
    loading: true,
    artifactVisible: false,
    artifactStage: "CrunchingMetrics",
    messages: [
      ...prev.messages,
      {
        role: "assistant",
        content: `Applying modifications: "${text}"`,
        artifactStage: "CrunchingMetrics",
        artifactPath,
      }
    ]
  }));

  const updatePatchMsg = (stage: PipelineStageKind, path: string | null = null, contentOverride?: string) => {
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
    const currentContent = await Api.readFileText(artifactPath);

    const systemPrompt = `You are a professional software assistant that modifies HTML and other code artifacts.
Generate a valid, minimal unified git-style diff (patch) to apply the user's modifications.
Do NOT output anything else — no markdown fences, no explanations, no chat text. Just the raw unified diff starting with "@@".

Original Code:
\`\`\`html
${currentContent}
\`\`\``;

    const userPrompt = `Generate a unified diff patch to: "${text}"`;

    let patchText = "";
    const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

    await Api.streamChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      (chunk) => {
        patchText += chunk;
      },
      () => {},
      async () => {
        updatePatchMsg("WritingCode");
        try {
          let cleanPatch = patchText.trim();
          if (cleanPatch.startsWith("```")) {
            const lines = cleanPatch.split("\n");
            if (lines[0].startsWith("```")) {
              lines.shift();
            }
            if (lines[lines.length - 1] === "```") {
              lines.pop();
            }
            cleanPatch = lines.join("\n").trim();
          }

          // Apply patch on disk
          await Api.applyDiffPatch(artifactPath, cleanPatch);

          // Trigger hot-reload in sandbox
          import("@tauri-apps/api/event").then(({ emit }) => {
            emit("artifact-patch", { patch: cleanPatch, path: artifactPath });
          });

          ctx.updateSession(sid, {
            loading: false,
            artifactVisible: false,
          });

          const filename = artifactPath.split(/[/\\]/).pop();
          updatePatchMsg("LivePreview", artifactPath, `Successfully applied modifications to: **${filename}** via targeted hot-reload.`);

        } catch (execErr: any) {
          console.error("Patch execution failed:", execErr);
          ctx.updateSession(sid, {
            loading: false,
          });
          updatePatchMsg("Error", null, `Failed to apply diff patch: ${execErr.message || execErr}`);
        }
      },
      (err) => {
        console.error("Patch generation failed:", err);
        ctx.updateSession(sid, {
          loading: false,
        });
        updatePatchMsg("Error", null, `Failed to generate patch: ${err}`);
      },
      undefined,
      ctrl.signal,
      true,
      {
        ...generationOptions,
        maxTokens: 1000,
        temperature: 0.1,
      }
    );

  } catch (err: any) {
    console.error("Patch setup failed:", err);
    ctx.updateSession(sid, {
      loading: false,
    });
    updatePatchMsg("Error", null, `Failed to initialize patch application: ${err.message || err}`);
  }
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

function extractSearchQuery(text: string): string {
  const lowerText = text.toLowerCase();
  let startIdx = 0;
  let endIdx = text.length;

  const prefixes = [
    "can you tell me about",
    "tell me about",
    "do you have any info on",
    "do you have",
    "what is in",
    "show me the contents of",
    "show me",
    "search for",
    "look for",
    "look up",
    "find",
    "locate",
    "where is"
  ];
  for (const prefix of prefixes) {
    if (lowerText.startsWith(prefix)) {
      startIdx = prefix.length;
      break;
    }
  }

  const remaining = text.substring(startIdx).trim();
  const lowerRemaining = remaining.toLowerCase();

  const suffixes = [
    "from my system files",
    "from my files",
    "on my system",
    "in my system",
    "in my files",
    "from system files",
    "system files",
    "my files",
    "on my computer"
  ];
  for (const suffix of suffixes) {
    if (lowerRemaining.endsWith(suffix)) {
      endIdx = startIdx + lowerRemaining.lastIndexOf(suffix);
      break;
    }
  }

  let cleaned = text.substring(startIdx, endIdx).trim();
  const lowerCleaned = cleaned.toLowerCase();

  const stopWords = [
    "and make",
    "and create",
    "and generate",
    "and build",
    "into a",
    "to generate",
    "to create",
    "as a",
  ];
  for (const sw of stopWords) {
    const swIdx = lowerCleaned.indexOf(sw);
    if (swIdx !== -1) {
      cleaned = cleaned.substring(0, swIdx).trim();
      break;
    }
  }

  // Clean up punctuation EXCEPT dots, underscores, and hyphens (important for filenames)
  cleaned = cleaned.replace(/[,\/#!$%\^&\*;:{}=`~()?]/g, "").trim();

  return cleaned || text;
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

function hasSearchKeywords(text: string): boolean {
  const searchKeywordsRegex = /\b(search\w*|find\w*|locat\w+|look\s*up|read\w*|where\s+(is|are)|get\s+(the|file|document)|open\s+file|retriev\w*)\b/i;
  return searchKeywordsRegex.test(text);
}


