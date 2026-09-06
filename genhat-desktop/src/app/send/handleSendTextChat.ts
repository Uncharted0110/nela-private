import { Api } from "../../api";
import type { ChatMessage, WebSearchResult } from "../../types";
import { createStreamChunkFlusher, createLatestValueFlusher, createThrottledFlusher } from "../streamUiBatch";
import { windowThinkingForUi } from "../thinkingUiWindow";
import {
  CONTEXT_COMPACTION_KEEP_RECENT,
  CONTEXT_COMPACTION_THRESHOLD,
  normalizeMessagesForLlm,
  resolveReservedOutputTokens,
  toContextMessages,
} from "../contextCompaction";
import {
  currentDateSystemLine,
  NELA_CLOUD_SYSTEM_PROMPT,
  NELA_SYSTEM_PROMPT,
} from "../nelaSystemPrompt";
import { CHART_SYSTEM_INSTRUCTION } from "../../prompts/chartPrompt";
import { NELA_AUTO_ARTIFACT_CRITERIA } from "../autoArtifactPrompt";
import { canAutoStreamArtifacts } from "../cloudPresentationMode";
import {
  defaultArtifactFollowup,
  defaultArtifactIntro,
  failedArtifactSaveFollowup,
  previewReadySoftFollowup,
} from "../artifactChatCopy";
import { COPY } from "../copy";
import {
  classifyArtifactFailure,
  friendlyErrorFromUnknown,
} from "../friendlyError";
import { isPreviewableHtmlDocument } from "../artifactHtmlOutput";
import { StreamArtifactParser, scrubChatArtifactProtocol, stripPartialArtifactTags } from "../streamArtifactParser";
import { saveStreamedArtifact } from "../streamArtifactSave";
import {
  materializeHtmlAsDocxArtifact,
  wantsWordDocument,
} from "../artifactDownload";
import { ArtifactChartPool } from "../artifactChartPool";
import { useCloudStore } from "../../stores/cloudStore";
import { streamChatByMode, willRouteToCloud } from "./cloudOrLocalStream";
import type { SendHandlerContext } from "./types";
import { runCloudAwareToolLoop } from "./cloudNativeToolLoop";
import { looksLikeEmailRequest } from "./gmailConnectIntent";
import { useGmailStore } from "../../stores/gmailStore";
import { useGmailConnectPromptStore } from "../../stores/gmailConnectPromptStore";
import { useChatModeStore } from "../../stores/chatModeStore";
import { useArtifactStreamStore } from "../../stores/artifactStreamStore";
import {
  DIRECT_ATTACHMENT_SYSTEM,
  fileSearchEnabledForTurn,
  hasExplicitAttachments,
  overlayCloudAttachments,
  pluginForPrepared,
  prepareMessageAttachments,
} from "./directAttachments";
import type { CloudChatMessage, CloudFileParserPlugin, FileAnnotation } from "../../types";

export async function handleSendTextChat(
  text: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  session: import("../../types").ChatSession,
  newMsg: ChatMessage,
  effectiveWebEnabled: boolean,
  _resolvedIntentKind: string,
  slashFileSearch: boolean
): Promise<void> {
  const sid = ctx.activeSessionId;

  // ── Local file search (Doc Graph) as an LLM tool, like web_search ────────
  // When "Search my files" / /files is on, the model calls `file_search`
  // inside the tool loop — do not pre-inject ambient KB context here.
  const explicitAttachments =
    hasExplicitAttachments(newMsg) ||
    session.messages.some((m) => hasExplicitAttachments(m));
  const fileSearchEnabled = fileSearchEnabledForTurn({
    fileIndexerEnabled: ctx.fileIndexerEnabled,
    slashFileSearch,
    explicitAttachments,
  });

  if (looksLikeEmailRequest(text)) {
    void useGmailStore
      .getState()
      .refresh()
      .then((status) => {
        if (!status.connected) useGmailConnectPromptStore.getState().show();
      })
      .catch(() => {
        useGmailConnectPromptStore.getState().show();
      });
  }

  ctx.setGeneralGenerating(true);
  ctx.setGeneralElapsedTime(0);
  ctx.setGeneralGenerationTime(null);
  const chatStartTime = Date.now();

  if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
  ctx.generalIntervalRef.current = setInterval(() => {
    const elapsed = Math.floor((Date.now() - chatStartTime) / 100) / 10;
    ctx.setGeneralElapsedTime(elapsed);
  }, 500);

  let fullResponse = "";
  let fullThinking = "";
  let textFirstTokenTimeMs: number | null = null;
  let webSearchResult: WebSearchResult | null = null;
  /** Shared across tool rounds so streamed / generate_html artifacts can embed charts. */
  const chartPool = new ArtifactChartPool(4);

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
  // Date line lives after the identity block so the cached cloud prefix stays byte-stable.
  const dateLine = currentDateSystemLine();
  let apiMessages = [
    {
      role: "system" as const,
      content: autoArtifacts
        ? `${identityPrompt}\n\n${dateLine}\n\n${NELA_AUTO_ARTIFACT_CRITERIA}\n\n${CHART_SYSTEM_INSTRUCTION}`
        : `${identityPrompt}\n\n${dateLine}\n\n${CHART_SYSTEM_INSTRUCTION}`,
    },
    ...(explicitAttachments
      ? [{ role: "system" as const, content: DIRECT_ATTACHMENT_SYSTEM }]
      : []),
    ...toContextMessages(fullSessionMessages),
  ];

  const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);
  // Cloud turns must not wait on local llama (compaction summarize / warm-up).
  // Local GGUF ctx_size often defaults to 4k and falsely trips auto-compact.
  const cloudOnly = preferredMode === "cloud";
  const contextWindowTokens = cloudOnly
    ? Math.max(128_000, ctx.getContextWindowTokens(ctx.selectedModel) || 0)
    : ctx.getContextWindowTokens(ctx.selectedModel);

  try {
    const compaction = await Api.compactChatContext({
      messages: apiMessages,
      contextWindowTokens,
      reservedOutputTokens: resolveReservedOutputTokens(generationOptions.maxTokens),
      thresholdPercent: CONTEXT_COMPACTION_THRESHOLD,
      // Analysis / usage only in Cloud — never spin a local summarize model.
      allowAutoCompaction: !cloudOnly,
      forceCompaction: false,
      preserveRecentMessages: CONTEXT_COMPACTION_KEEP_RECENT,
      modelOverride: cloudOnly ? null : ctx.selectedModel || null,
    });

    ctx.setContextUsageForSession(sid, compaction.usage);
    if (!cloudOnly) {
      apiMessages = compaction.messages;
    }

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

  let sendMessages: CloudChatMessage[] = apiMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  let cloudPlugins: CloudFileParserPlugin[] | undefined;
  const cloudConfirmed =
    preferredMode === "cloud" || Boolean(fileSearchEnabled);
  if (
    explicitAttachments &&
    willRouteToCloud({
      containsFileContext: true,
      userConfirmedCloudContext: cloudConfirmed,
    })
  ) {
    const { preparedByPath, warningsByPath } = await prepareMessageAttachments(
      fullSessionMessages
    );
    sendMessages = overlayCloudAttachments({
      apiMessages,
      sessionMessages: fullSessionMessages,
      preparedByPath,
      warningsByPath,
    });
    const plugin = pluginForPrepared([...preparedByPath.values()]);
    const sendingPdf = sendMessages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "file")
    );
    if (plugin && sendingPdf) cloudPlugins = [plugin];
  }

  const chunkFlusher = createStreamChunkFlusher((batched) => {
    ctx.updateSession(sid, (prev) => ({
      streamingContent: scrubChatArtifactProtocol(prev.streamingContent + batched),
    }));
  });

  const thinkingFlusher = createLatestValueFlusher((value: string) => {
    ctx.setStreamingThinking(value);
  });

  const streamParser = autoArtifacts ? new StreamArtifactParser() : null;
  let streamedArtifactBody = "";
  /** Full model text — needed so multi-sheet CSV tags survive save. */
  let rawModelOutput = "";
  let streamedArtifactType: "text/html" | "text/csv" = "text/html";
  let streamedArtifactTitle = "";
  let streamedArtifactFilename = "";
  let chatProse = "";
  let chatFollowup = "";
  let artifactClosed = false;

  let csvPanelOpened = false;
  let htmlPanelOpened = false;
  const pushArtifactSession = () => {
    const store = useArtifactStreamStore.getState();
    if (streamedArtifactType === "text/csv") {
      if (!csvPanelOpened) {
        store.begin({
          sessionId: sid,
          type: "text/csv",
          title: streamedArtifactTitle,
        });
      }
      store.setCsv(streamedArtifactBody, streamedArtifactTitle);
      if (csvPanelOpened) return;
      csvPanelOpened = true;
      ctx.updateSession(sid, {
        artifactStreamActive: true,
        artifactPanelOpen: true,
        streamingArtifactType: streamedArtifactType,
        streamingArtifactTitle: streamedArtifactTitle || undefined,
      });
      return;
    }
    // HTML: keep the live body in the side store so token updates do not
    // rebuild the whole chat tree / iframe every animation frame.
    if (!htmlPanelOpened) {
      store.begin({
        sessionId: sid,
        type: "text/html",
        title: streamedArtifactTitle,
      });
    }
    store.setHtml(streamedArtifactBody, streamedArtifactTitle);
    if (htmlPanelOpened) return;
    htmlPanelOpened = true;
    ctx.updateSession(sid, {
      artifactStreamActive: true,
      artifactPanelOpen: true,
      streamingArtifactType: streamedArtifactType,
      streamingArtifactTitle: streamedArtifactTitle || undefined,
    });
  };
  const csvUiFlusher = createThrottledFlusher(pushArtifactSession, 280);
  const htmlUiFlusher = createThrottledFlusher(pushArtifactSession, 450);
  const artifactUiFlusher = {
    push: () => {
      if (streamedArtifactType === "text/csv") csvUiFlusher.push();
      else htmlUiFlusher.push();
    },
    flushNow: () => {
      csvUiFlusher.flushNow();
      htmlUiFlusher.flushNow();
    },
  };

  const applyAutoArtifactEmit = (emit: {
    chatDelta: string;
    artifactDelta: string;
    meta?: { type: "text/html" | "text/csv"; title: string; filename?: string };
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
      if (emit.meta.filename) streamedArtifactFilename = emit.meta.filename;
    }
    if (emit.artifactDelta) {
      streamedArtifactBody += emit.artifactDelta;
      artifactUiFlusher.push();
    }
  };
  const finishOk = async (
    response: string,
    thinking: string,
    web: WebSearchResult | null,
    generatedByModel?: string | null,
    creditsRemainingAfter?: number | null,
    fileAnnotations?: FileAnnotation[] | null
  ) => {
    chunkFlusher.flushNow();
    thinkingFlusher.flushNow();
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
    let artifactSaveFailure: string | null = null;
    /** Preview works; disk save skipped or soft — keep success UX (intro + chip). */
    let previewSoftSuccess = false;
    const body =
      streamedArtifactType === "text/csv"
        ? rawModelOutput.trim() || streamedArtifactBody.trim()
        : streamedArtifactBody.trim();
    const asPresentation =
      /slide|deck|presentation/i.test(streamedArtifactTitle) ||
      (Boolean(body) && /class=["']slide/i.test(body));
    if (autoArtifacts && body) {
      try {
        await new Promise((r) => setTimeout(r, 0));
        const saved = await saveStreamedArtifact({
          type: streamedArtifactType,
          rawBody: body,
          topic: text,
          title: streamedArtifactTitle || undefined,
          filename: streamedArtifactFilename || undefined,
          asPresentation,
          chartPool:
            streamedArtifactType === "text/html" ? chartPool.list() : undefined,
        });
        artifactPath = saved.path;
        artifactStage = "LivePreview";
        if (
          wantsWordDocument(text) &&
          streamedArtifactType === "text/html" &&
          !asPresentation &&
          artifactPath
        ) {
          try {
            artifactPath = await materializeHtmlAsDocxArtifact(artifactPath);
          } catch (docxErr) {
            console.warn("Word (.docx) materialize failed; keeping HTML:", docxErr);
          }
        }
        useArtifactStreamStore.getState().clear();
      } catch (saveErr) {
        console.warn("Auto artifact save failed:", saveErr);
        const previewableHtml =
          streamedArtifactType === "text/html" &&
          !asPresentation &&
          isPreviewableHtmlDocument(body);

        if (previewableHtml) {
          // Retry with relaxed validation — common for script-heavy interactive pages.
          try {
            const saved = await saveStreamedArtifact({
              type: streamedArtifactType,
              rawBody: body,
              topic: text,
              title: streamedArtifactTitle || undefined,
              filename: streamedArtifactFilename || undefined,
              asPresentation,
              relaxValidation: true,
              chartPool: chartPool.list(),
            });
            artifactPath = saved.path;
            artifactStage = "LivePreview";
            useArtifactStreamStore.getState().clear();
          } catch (retryErr) {
            console.warn("Relaxed artifact save failed; keeping preview:", retryErr);
            // Soft success: panel already has a working preview — do not Error the bubble.
            artifactStage = "LivePreview";
            previewSoftSuccess = true;
          }
        } else {
          const raw =
            saveErr instanceof Error ? saveErr.message : String(saveErr);
          artifactSaveFailure =
            classifyArtifactFailure(raw) ||
            classifyArtifactFailure(`Preview is ready but saving failed: ${raw}`) ||
            COPY.errorArtifactSave;
          artifactStage = "Error";
        }
      }
    }

    const title =
      streamedArtifactTitle ||
      (artifactPath
        ? artifactPath.split(/[/\\]/).pop()?.replace(/\.(html?|xlsx|csv|docx?)$/i, "")
        : undefined) ||
      "Artifact";

    const wordDeliverable =
      Boolean(artifactPath) && /\.docx?$/i.test(artifactPath || "");

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
      // On hard save failure, replace optimistic intros with classified error.
      // Soft preview success keeps the model intro and shows a recovery follow-up.
      if (artifactSaveFailure) {
        intro = artifactSaveFailure;
      } else if (body && !intro) {
        intro = defaultArtifactIntro({
          title,
          type: wordDeliverable ? "docx" : streamedArtifactType,
          asPresentation,
        });
      }
      let followup = followupFromModel;
      if (artifactSaveFailure) {
        followup = failedArtifactSaveFollowup({
          type: streamedArtifactType,
          asPresentation,
        });
      } else if (previewSoftSuccess) {
        followup = previewReadySoftFollowup({
          type: streamedArtifactType,
          asPresentation,
          saved: false,
        });
      } else if (body && !followup) {
        followup = defaultArtifactFollowup({
          type: wordDeliverable ? "docx" : streamedArtifactType,
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
      const resolvedStage = (artifactStage ??
        (body && !artifactPath ? "Error" : undefined)) as
        | "LivePreview"
        | "Error"
        | undefined;
      return {
        messages: [
          ...prev.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            content: intro,
            ...(followup ? { artifactFollowup: followup } : {}),
            thinking: thinking || undefined,
            webSearchResult: web ?? undefined,
            ...(generatedByModel?.trim()
              ? { generatedByModel: generatedByModel.trim() }
              : {}),
            ...(typeof creditsRemainingAfter === "number"
              ? { creditsRemainingAfter }
              : {}),
            ...(fileAnnotations && fileAnnotations.length > 0
              ? { fileAnnotations }
              : {}),
            generateTime: totalTime,
            firstTokenTime:
              timeToFirstToken !== null ? timeToFirstToken : undefined,
            ...(artifactPath || body
              ? {
                  artifactPath: artifactPath ?? undefined,
                  artifactStage: resolvedStage,
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
        artifactStage: resolvedStage ?? prev.artifactStage,
        artifactPanelOpen: body ? true : prev.artifactPanelOpen,
        artifactStreamActive: Boolean(body),
        streamingArtifactCsv: undefined,
        ...(body && streamedArtifactType === "text/html"
          ? { streamingArtifactHtml: streamedArtifactBody }
          : { streamingArtifactHtml: undefined }),
        ...(body && streamedArtifactType === "text/csv"
          ? { streamingArtifactCsv: streamedArtifactBody }
          : {}),
        streamingArtifactType: body ? streamedArtifactType : undefined,
        streamingArtifactTitle: title || filename || undefined,
      };
    });
  };

  const finishErr = (err: unknown) => {
    chunkFlusher.flushNow();
    thinkingFlusher.flushNow();
    useChatModeStore.getState().setLiveToolStatus(null);
    if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
    ctx.setGeneralGenerating(false);
    ctx.setStreamingThinking("");
    console.error("Stream error", err);
    ctx.updateSession(sid, (prev) => ({
      messages: [
        ...prev.messages,
        {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          content: friendlyErrorFromUnknown(err),
        },
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
      rawModelOutput += chunk;
      applyAutoArtifactEmit(streamParser.push(chunk));
    } else {
      fullResponse += chunk;
      chunkFlusher.push(chunk);
    }
  };

  const onThinking = (thinkingChunk: string) => {
    fullThinking += thinkingChunk;
    thinkingFlusher.push(windowThinkingForUi(fullThinking));
  };

  // Tool loop when web, knowledge-base, and/or auto-artifact chart prep is needed.
  // Do NOT auto-route to facet research — web search runs only when the model
  // calls web_search(query, depth).
  const useToolLoop = effectiveWebEnabled || fileSearchEnabled || autoArtifacts;
  if (useToolLoop) {
    if (fileSearchEnabled && !effectiveWebEnabled) {
      useChatModeStore.getState().setLiveToolStatus("Ready to search your files…");
    }
    runCloudAwareToolLoop({
      messages: sendMessages,
      webDepth: "full",
      webEnabled: effectiveWebEnabled,
      fileSearchEnabled,
      includeMcpTools: !autoArtifacts,
      chartEnabled: true,
      chartPool,
      containsFileContext: explicitAttachments,
      userConfirmedCloudContext: cloudConfirmed,
      contextSource: explicitAttachments ? "direct_attachment" : undefined,
      plugins: cloudPlugins,
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
          webSearchResult,
          result.model,
          result.creditsRemaining,
          result.fileAnnotations
        );
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        finishErr(err);
      });
    return;
  }

  streamChatByMode({
    messages: sendMessages,
    intent: explicitAttachments && sendMessages.some((m) =>
      Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
    )
      ? "vision"
      : "quick_chat",
    containsFileContext: explicitAttachments,
    userConfirmedCloudContext: cloudConfirmed,
    contextSource: explicitAttachments ? "direct_attachment" : undefined,
    plugins: cloudPlugins,
    modelId: ctx.selectedModel || undefined,
    signal: ctrl.signal,
    disableThinking: !ctx.thinkingEnabled,
    generationOptions,
    onChunk,
    onThinking,
    onFinish: (meta) => {
      void finishOk(
        fullResponse,
        fullThinking,
        null,
        meta?.model,
        meta?.creditsRemaining,
        meta?.annotations
      );
    },
    onError: finishErr,
  });
}
