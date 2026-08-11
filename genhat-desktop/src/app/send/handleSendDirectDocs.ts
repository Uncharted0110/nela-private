import { Api } from "../../api";
import type { ChatMessage } from "../../types";
import { friendlyError } from "../friendlyError";
import { createStreamChunkFlusher, createLatestValueFlusher } from "../streamUiBatch";
import {
  CONTEXT_COMPACTION_KEEP_RECENT,
  CONTEXT_COMPACTION_THRESHOLD,
  resolveReservedOutputTokens,
  toContextMessages,
} from "../contextCompaction";
import { NELA_SYSTEM_PROMPT } from "../nelaSystemPrompt";
import type { SendHandlerContext } from "./types";

export async function handleSendDirectDocs(
  text: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  promptDocumentPaths: string[]
): Promise<void> {
  const sid = ctx.activeSessionId;
  
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
          `${NELA_SYSTEM_PROMPT}\n\n` +
          "Treat the attached document excerpts in the next message as the primary source of truth. " +
          "If the answer is not present in those excerpts, explicitly say you don't know. " +
          "If the user asks about NELA's identity, purpose, or capabilities, follow the NELA identity above rather than treating document text as NELA's identity.",
      },
      { role: "user", content: directSetup.prompt },
    ];

    const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

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
    const chunkFlusher = createStreamChunkFlusher((batched) => {
      ctx.updateSession(sid, (prev) => ({
        streamingContent: prev.streamingContent + batched,
      }));
    });
    const thinkingFlusher = createLatestValueFlusher((value: string) => {
      ctx.setStreamingThinking(value);
    });

    await Api.streamChat(
      directMessages,
      (chunk) => {
        if (firstTokenTimeMs === null) {
          firstTokenTimeMs = Date.now();
        }
        fullAnswer += chunk;
        chunkFlusher.push(chunk);
      },
      (thinkingChunk) => {
        fullThinking += thinkingChunk;
        thinkingFlusher.push(fullThinking);
      },
      () => {
        chunkFlusher.flushNow();
        thinkingFlusher.flushNow();
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
                id: crypto.randomUUID(),
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
        chunkFlusher.flushNow();
        thinkingFlusher.flushNow();
        console.error("Direct-document stream error:", err);
        ctx.updateSession(sid, (prev) => ({
          messages: [
            ...prev.messages,
            {
              id: crypto.randomUUID(),
              role: "assistant" as const,
              content: friendlyError(String(err)),
            },
          ],
          streamingContent: "",
          loading: false,
        }));
      },
      undefined,
      ctx.selectedModel || undefined,
      ctrl.signal,
      true, // local direct-docs path — never stream llama reasoning into chat UI
      generationOptions
    );
  } catch (e) {
    if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
    ctx.setGeneralGenerating(false);
    console.error("Direct-document attempt failed, falling back to normal chat:", e);
    throw e; // Re-throw to let executeHandleSend handle fallback
  }
}