import { Api } from "../../api";
import { friendlyError } from "../friendlyError";
import type { SendHandlerContext } from "./types";

export async function handleSendTts(
  text: string,
  ctx: SendHandlerContext
): Promise<void> {
  const sid = ctx.activeSessionId;
  
  try {
    ctx.setTtsGenerating(true);
    ctx.setTtsElapsedTime(0);
    ctx.setTtsGenerationTime(null);
    const startTime = Date.now();

    if (ctx.ttsIntervalRef.current) clearInterval(ctx.ttsIntervalRef.current);
    ctx.ttsIntervalRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 100) / 10;
      ctx.setTtsElapsedTime(elapsed);
    }, 500);

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
        { role: "assistant" as const, content: friendlyError(String(e)) },
      ],
    }));
  }
  
  ctx.updateSession(sid, { loading: false });
}