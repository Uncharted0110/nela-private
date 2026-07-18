import { listen } from "@tauri-apps/api/event";
import { Api } from "../../api";
import { withNelaIdentity } from "../nelaSystemPrompt";
import type { SendHandlerContext } from "./types";

export async function handleSendVision(
  text: string,
  ctx: SendHandlerContext,
  currentVisionImagePath: string | null
): Promise<void> {
  const sid = ctx.activeSessionId;
  
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
      withNelaIdentity(visionPrompt),
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
}