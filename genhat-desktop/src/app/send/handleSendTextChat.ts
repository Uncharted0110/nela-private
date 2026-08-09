import { Api } from "../../api";
import type { ChatMessage, WebSearchResult } from "../../types";
import { friendlyErrorFromUnknown } from "../friendlyError";
import { createStreamChunkFlusher } from "../streamUiBatch";
import {
  CONTEXT_COMPACTION_KEEP_RECENT,
  CONTEXT_COMPACTION_THRESHOLD,
  normalizeMessagesForLlm,
  resolveReservedOutputTokens,
  toContextMessages,
} from "../contextCompaction";
import {
  extractAmbientSearchQuery,
  hasDocumentFileIntent,
  hasSearchKeywords,
} from "../ambientSearch";
import { hasLocalFilePathReference } from "../ambientFileContent";
import { NELA_CLOUD_SYSTEM_PROMPT, NELA_SYSTEM_PROMPT } from "../nelaSystemPrompt";
import { NELA_AUTO_ARTIFACT_CRITERIA } from "../autoArtifactPrompt";
import { canAutoStreamArtifacts } from "../cloudPresentationMode";
import {
  defaultArtifactFollowup,
  defaultArtifactIntro,
} from "../artifactChatCopy";
import { StreamArtifactParser, scrubChatArtifactProtocol, stripPartialArtifactTags } from "../streamArtifactParser";
import { saveStreamedArtifact } from "../streamArtifactSave";
import { sanitizeCsvArtifactBody } from "../sanitizeCsvArtifact";
import { useDocGraphStore } from "../../stores/docGraphStore";
import { useCloudStore } from "../../stores/cloudStore";
import { streamChatByMode } from "./cloudOrLocalStream";
import type { SendHandlerContext } from "./types";
import { runCloudAwareToolLoop } from "./cloudNativeToolLoop";
import { useChatModeStore } from "../../stores/chatModeStore";

export async function handleSendTextChat(
  text: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  session: import("../../types").ChatSession,
  newMsg: ChatMessage,
  effectiveWebEnabled: boolean,
  resolvedIntentKind: string,
  slashFileSearch: boolean
): Promise<void> {
  const sid = ctx.activeSessionId;

  // ── Local file search via structural knowledge graph ────────────────────
  let ambientFileContext = "";
  let attachedFile = ctx.directDocumentPaths.length > 0 ? ctx.directDocumentPaths[0] : null;

  const explicitFileSearch =
    resolvedIntentKind === "FileSearch" ||
    slashFileSearch ||
    hasSearchKeywords(text) ||
    hasDocumentFileIntent(text) ||
    hasLocalFilePathReference(text);
  const fileSearchEnabled = ctx.fileIndexerEnabled || slashFileSearch;

  if (fileSearchEnabled && !attachedFile && text.trim()) {
    const searchQuery = extractAmbientSearchQuery(text).trim() || text.trim();
    try {
      // Same Markdown the LLM receives — also shown in the query dialog.
      useDocGraphStore.getState().openQuery(searchQuery);
      const md = await Api.queryKnowledgeBase(searchQuery);
      useDocGraphStore.setState({ queryResult: md, queryText: searchQuery });

      if (md.trim() && md !== "No relevant structural context found.") {
        ambientFileContext =
          `The following local structural knowledge-graph context was retrieved for the user's query.\n` +
          `Use these expanded sources as the primary source of truth when answering.\n\n` +
          md;
        const pathMatch = md.match(/\(File:\s*([^)]+)\)/);
        if (pathMatch?.[1]) {
          attachedFile = pathMatch[1].trim();
        }
      } else if (explicitFileSearch) {
        ambientFileContext = "FILE_SEARCH_NO_RESULTS";
      }
    } catch (err) {
      console.warn("Doc-graph file search in standard chat failed:", err);
      if (explicitFileSearch) {
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
  let webSearchResult: WebSearchResult | null = null;

  const sessionMessages = session.messages;
  const fullSessionMessages: ChatMessage[] = [
    ...sessionMessages,
    newMsg,
  ];
  const preferredMode = useCloudStore.getState().preferredMode;
  const identityPrompt =
    preferredMode === "cloud" || preferredMode === "auto"
      ? NELA_CLOUD_SYSTEM_PROMPT
      : NELA_SYSTEM_PROMPT;
  const autoArtifacts = canAutoStreamArtifacts();
  let apiMessages = [
    {
      role: "system" as const,
      content: autoArtifacts
        ? `${identityPrompt}\n\n${NELA_AUTO_ARTIFACT_CRITERIA}`
        : identityPrompt,
    },
    ...toContextMessages(fullSessionMessages),
  ];

  // Ambient file instructions AFTER the stable NELA identity so OpenRouter
  // can cache the identity prefix. Document text still goes in the user turn.
  if (ambientFileContext === "FILE_SEARCH_NO_RESULTS") {
    apiMessages = [
      ...apiMessages.slice(0, 1),
      {
        role: "system",
        content:
          "The user asked about a specific local file, but it could not be located in Documents, Desktop, Downloads, or indexed workspaces. " +
          "Tell them you could not find that file on their system. Do NOT claim you lack the ability to access local files — this app can search them, but this particular file was not found. " +
          "Suggest they verify the path, wait for indexing to finish after restart, or attach the file directly.",
      },
      ...apiMessages.slice(1),
    ];
  } else if (ambientFileContext) {
    apiMessages = [
      ...apiMessages.slice(0, 1),
      {
        role: "system",
        content:
          "The user's message includes text retrieved from their computer. " +
          "You ALREADY have the file contents below — answer directly from that text. " +
          "NEVER say you cannot access local files, paths, or the user's system. " +
          "Summarize or explain the document in clear prose. If the excerpt is incomplete, say what you can from the provided text.",
      },
      ...apiMessages.slice(1),
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

  const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

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

    // Do NOT rewrite session.messages from compaction.keptIndices here.
    // Those indices refer to `apiMessages` (NELA system prompt + optional ambient
    // file instructions + turns). Mapping them onto the UI transcript deleted or
    // scrambled real chat responses — especially when "Search my files" injects
    // extra system context and pushes usage over the compaction threshold.
  } catch (err) {
    console.warn("Context compaction failed; continuing with original context:", err);
  }

  // Collapse every injected `system` message (ambient file context,
  // auto-compaction summary) into a single leading system message and strip the
  // UI-only discovery notice. This prevents llama-server's strict chat template
  // from rejecting the request with "System message must be at the beginning".
  apiMessages = normalizeMessagesForLlm(apiMessages);

  const chunkFlusher = createStreamChunkFlusher((batched) => {
    ctx.updateSession(sid, (prev) => ({
      streamingContent: scrubChatArtifactProtocol(prev.streamingContent + batched),
    }));
  });

  const streamParser = autoArtifacts ? new StreamArtifactParser() : null;
  let streamedArtifactBody = "";
  let streamedArtifactType: "text/html" | "text/csv" = "text/html";
  let streamedArtifactTitle = "";
  let chatProse = "";
  let chatFollowup = "";
  let artifactClosed = false;

  const artifactUiFlusher = createStreamChunkFlusher(() => {
    const displayBody =
      streamedArtifactType === "text/csv"
        ? sanitizeCsvArtifactBody(streamedArtifactBody)
        : streamedArtifactBody;
    ctx.updateSession(sid, {
      artifactStreamActive: true,
      artifactPanelOpen: true,
      streamingArtifactType: streamedArtifactType,
      streamingArtifactTitle: streamedArtifactTitle || undefined,
      ...(streamedArtifactType === "text/csv"
        ? { streamingArtifactCsv: displayBody }
        : { streamingArtifactHtml: displayBody }),
    });
  });

  const applyAutoArtifactEmit = (emit: {
    chatDelta: string;
    artifactDelta: string;
    meta?: { type: "text/html" | "text/csv"; title: string };
    closed?: boolean;
  }) => {
    if (emit.chatDelta) {
      if (artifactClosed || emit.closed) {
        chatFollowup += emit.chatDelta;
        // Follow-up is not shown in the streaming bubble above the chip yet;
        // keep streamingContent as intro-only until finish.
      } else {
        chatProse += emit.chatDelta;
        fullResponse += emit.chatDelta;
        chunkFlusher.push(emit.chatDelta);
      }
    }
    if (emit.closed) artifactClosed = true;
    if (emit.meta) {
      streamedArtifactType = emit.meta.type;
      streamedArtifactTitle = emit.meta.title;
    }
    if (emit.artifactDelta) {
      streamedArtifactBody += emit.artifactDelta;
      artifactUiFlusher.push("1");
    }
  };
  const finishOk = async (
    response: string,
    thinking: string,
    web: WebSearchResult | null
  ) => {
    chunkFlusher.flushNow();
    if (streamParser) {
      applyAutoArtifactEmit(streamParser.finalize());
      artifactUiFlusher.flushNow();
    }
    useChatModeStore.getState().setLiveToolStatus(null);
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

    let artifactPath: string | null = null;
    let artifactStage: string | null = null;
    const body =
      streamedArtifactType === "text/csv"
        ? sanitizeCsvArtifactBody(streamedArtifactBody.trim())
        : streamedArtifactBody.trim();
    const asPresentation =
      /slide|deck|presentation/i.test(streamedArtifactTitle) ||
      (Boolean(body) && /class=["']slide/i.test(body));
    if (autoArtifacts && body) {
      try {
        const saved = await saveStreamedArtifact({
          type: streamedArtifactType,
          rawBody: body,
          topic: text,
          title: streamedArtifactTitle || undefined,
          asPresentation,
        });
        artifactPath = saved.path;
        artifactStage = "LivePreview";
      } catch (saveErr) {
        console.warn("Auto artifact save failed:", saveErr);
      }
    }

    const title =
      streamedArtifactTitle ||
      (artifactPath
        ? artifactPath.split(/[/\\]/).pop()?.replace(/\.(html?|xlsx|csv)$/i, "")
        : undefined) ||
      "Artifact";

    const introFromModel = scrubChatArtifactProtocol(
      (streamParser?.chatBeforeArtifact || chatProse).trim() ||
        stripPartialArtifactTags(response).trim() ||
        ""
    );
    const followupFromModel = scrubChatArtifactProtocol(
      (streamParser?.chatAfterArtifact || chatFollowup).trim()
    );

    ctx.updateSession(sid, (prev) => {
      const streamed = scrubChatArtifactProtocol(
        (prev.streamingContent || "").trim()
      );
      let intro =
        introFromModel ||
        (streamed &&
        !/<!DOCTYPE\s+html|<html[\s>]/i.test(streamed) &&
        !/\bnela-artifact\b/i.test(streamed)
          ? streamed
          : "");
      intro = scrubChatArtifactProtocol(intro);

      // Prefer real model prose; never leave an artifact with an empty bubble.
      if (body && !intro) {
        intro = defaultArtifactIntro({
          title,
          type: streamedArtifactType,
          asPresentation,
        });
      }
      let followup = followupFromModel;
      if (body && !followup) {
        followup = defaultArtifactFollowup({
          type: streamedArtifactType,
          asPresentation,
        });
      }

      if (!intro && !followup && !artifactPath && !body) {
        return {
          streamingContent: "",
          loading: false,
          artifactStreamActive: Boolean(body),
        };
      }

      const filename = artifactPath
        ? artifactPath.split(/[/\\]/).pop()?.replace(/\.(html?|xlsx|csv)$/i, "")
        : undefined;
      return {
        messages: [
          ...prev.messages,
          {
            role: "assistant" as const,
            content: intro,
            ...(followup ? { artifactFollowup: followup } : {}),
            thinking: thinking || undefined,
            webSearchResult: web ?? undefined,
            generateTime: totalTime,
            firstTokenTime:
              timeToFirstToken !== null ? timeToFirstToken : undefined,
            ...(artifactPath || body
              ? {
                  artifactPath: artifactPath ?? undefined,
                  artifactStage: (artifactStage ??
                    (body ? "Error" : undefined)) as
                    | "LivePreview"
                    | "Error"
                    | undefined,
                  artifactUseSidePanel: true,
                  artifactTitle: title || filename || "Artifact",
                  streamingArtifactType: streamedArtifactType,
                }
              : {}),
          },
        ],
        streamingContent: "",
        loading: false,
        artifactPath: artifactPath ?? prev.artifactPath,
        artifactStage: artifactStage ?? prev.artifactStage,
        artifactPanelOpen: Boolean(body) ? true : prev.artifactPanelOpen,
        artifactStreamActive: Boolean(body),
        ...(body && streamedArtifactType === "text/csv"
          ? { streamingArtifactCsv: streamedArtifactBody }
          : body
            ? { streamingArtifactHtml: streamedArtifactBody }
            : {
                streamingArtifactHtml: undefined,
                streamingArtifactCsv: undefined,
              }),
        streamingArtifactType: body ? streamedArtifactType : undefined,
        streamingArtifactTitle: title || filename || undefined,
      };
    });
  };

  const finishErr = (err: unknown) => {
    chunkFlusher.flushNow();
    useChatModeStore.getState().setLiveToolStatus(null);
    if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
    ctx.setGeneralGenerating(false);
    ctx.setStreamingThinking("");
    console.error("Stream error", err);
    ctx.updateSession(sid, (prev) => ({
      messages: [
        ...prev.messages,
        { role: "assistant" as const, content: friendlyErrorFromUnknown(err) },
      ],
      streamingContent: "",
      loading: false,
      artifactStreamActive: false,
    }));
  };

  const onChunk = (chunk: string) => {
    if (textFirstTokenTimeMs === null) {
      textFirstTokenTimeMs = Date.now();
    }
    if (streamParser) {
      applyAutoArtifactEmit(streamParser.push(chunk));
    } else {
      fullResponse += chunk;
      chunkFlusher.push(chunk);
    }
  };

  const onThinking = (thinkingChunk: string) => {
    fullThinking += thinkingChunk;
    ctx.setStreamingThinking(fullThinking);
  };

  if (effectiveWebEnabled) {
    runCloudAwareToolLoop({
      messages: apiMessages,
      webDepth: ctx.webDepth,
      includeMcpTools: !autoArtifacts,
      containsFileContext: Boolean(
        ambientFileContext && ambientFileContext !== "FILE_SEARCH_NO_RESULTS"
      ),
      // Tools → "Search my files" (or /files) is explicit consent to ground on local
      // hits — do not force the local-model path when the user is in Cloud mode.
      userConfirmedCloudContext: Boolean(ctx.fileIndexerEnabled || slashFileSearch),
      contextSource:
        ambientFileContext && ambientFileContext !== "FILE_SEARCH_NO_RESULTS"
          ? "ambient_file"
          : undefined,
      modelId: ctx.selectedModel || undefined,
      signal: ctrl.signal,
      disableThinking: !ctx.thinkingEnabled,
      generationOptions,
      onChunk,
      onThinking,
      onToolStatus: (status) => {
        useChatModeStore.getState().setLiveToolStatus(status);
      },
      onArtifact: (artifact) => {
        ctx.updateSession(sid, () => ({
          artifactPath: artifact.path,
          artifactStage: "LivePreview",
        }));
      },
    })
      .then((result) => {
        webSearchResult = result.webSearchResult;
        if (result.thinking && !fullThinking) {
          fullThinking = result.thinking;
        }
        if (result.artifacts[0]) {
          ctx.updateSession(sid, () => ({
            artifactPath: result.artifacts[0]!.path,
            artifactStage: "LivePreview",
          }));
        }
        void finishOk(
          fullResponse || result.content,
          fullThinking || result.thinking,
          webSearchResult
        );
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        finishErr(err);
      });
    return;
  }

  const containsFileContext = Boolean(
    ambientFileContext && ambientFileContext !== "FILE_SEARCH_NO_RESULTS"
  );

  streamChatByMode({
    messages: apiMessages,
    intent: "quick_chat",
    containsFileContext,
    userConfirmedCloudContext: Boolean(ctx.fileIndexerEnabled || slashFileSearch),
    contextSource: containsFileContext ? "ambient_file" : undefined,
    modelId: ctx.selectedModel || undefined,
    signal: ctrl.signal,
    disableThinking: !ctx.thinkingEnabled,
    generationOptions,
    onChunk,
    onThinking,
    onFinish: () => {
      void finishOk(fullResponse, fullThinking, null);
    },
    onError: finishErr,
  });
}
