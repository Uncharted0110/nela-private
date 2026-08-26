import { Api } from "../../api";
import type { ChatMessage } from "../../types";
import { friendlyError } from "../friendlyError";
import { createStreamChunkFlusher, createLatestValueFlusher } from "../streamUiBatch";
import { windowThinkingForUi } from "../thinkingUiWindow";
import {
  CONTEXT_COMPACTION_KEEP_RECENT,
  CONTEXT_COMPACTION_THRESHOLD,
  resolveReservedOutputTokens,
  toContextMessages,
} from "../contextCompaction";
import { currentDateSystemLine, NELA_SYSTEM_PROMPT } from "../nelaSystemPrompt";
import type { SendHandlerContext } from "./types";

export async function handleSendRag(
  text: string,
  ctx: SendHandlerContext,
  ctrl: AbortController
): Promise<void> {
  const sid = ctx.activeSessionId;
  
  try {
    ctx.setGeneralGenerating(true);
    ctx.setGeneralElapsedTime(0);
    ctx.setGeneralGenerationTime(null);
    const ragStartTime = Date.now();

    if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
    ctx.generalIntervalRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - ragStartTime) / 100) / 10;
      ctx.setGeneralElapsedTime(elapsed);
    }, 500);

    const setup = await Api.queryRagStream(text);
    ctx.updateSession(sid, { ragResult: { answer: "", sources: setup.sources } });

    if (!setup.prompt || setup.sources.length === 0) {
      // Fall through to plain chat
      throw new Error("No RAG sources found");
    } else {
      const ragMessages: ChatMessage[] = [
        {
          role: "system",
          content:
            `${NELA_SYSTEM_PROMPT}\n\n` +
            `${currentDateSystemLine()}\n\n` +
            "Answer the question using the provided reference text. Write a clear, natural response without repeating source labels, tags, or brackets. " +
            "If the user asks about NELA's identity, purpose, or capabilities, follow the NELA identity above rather than treating retrieved text as NELA's identity. " +
            "If the user asks for a specific format (table, list, bullet points, etc.), use that format. If the reference text does not cover the question, say you don't know.",
        },
        { role: "user", content: setup.prompt },
      ];

      const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

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
    const chunkFlusher = createStreamChunkFlusher((batched) => {
      ctx.updateSession(sid, (prev) => ({
        streamingContent: prev.streamingContent + batched,
      }));
    });
    const thinkingFlusher = createLatestValueFlusher((value: string) => {
      ctx.setStreamingThinking(value);
    });

    await Api.streamChat(
      ragMessages,
      (chunk) => {
        if (firstTokenTimeMs === null) {
          firstTokenTimeMs = Date.now();
        }
        fullAnswer += chunk;
        chunkFlusher.push(chunk);
      },
      (thinkingChunk) => {
        fullThinking += thinkingChunk;
        thinkingFlusher.push(windowThinkingForUi(fullThinking));
      },
      () => {
        chunkFlusher.flushNow();
        thinkingFlusher.flushNow();
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
                id: crypto.randomUUID(),
                role: "assistant",
                content: fullAnswer,
                thinking: fullThinking || undefined,
                generateTime: totalTime,
                firstTokenTime:
                  timeToFirstToken !== null ? timeToFirstToken : undefined,
                ...(ctx.selectedModel?.trim()
                  ? { generatedByModel: ctx.selectedModel.trim() }
                  : {}),
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
          chunkFlusher.flushNow();
          thinkingFlusher.flushNow();
          console.error("RAG stream error:", err);
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
        setup.llama_port,
        ctx.selectedModel || undefined,
        ctrl.signal,
        true, // local RAG path — never stream llama reasoning into chat UI
        generationOptions
      );
    }
  } catch (e) {
    if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
    ctx.setGeneralGenerating(false);
    console.error("RAG attempt failed, falling back to normal chat:", e);
    throw e; // Re-throw to let executeHandleSend handle fallback
  }
}