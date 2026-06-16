import type {
  ChatContextCompactionResult,
  ChatContextMessage,
  ChatMessage,
  MediaAsset,
} from "../types";

export const CONTEXT_COMPACTION_THRESHOLD = 0.9;
export const CONTEXT_COMPACTION_KEEP_RECENT = 8;

/**
 * Marker prefix for the transient "discovered local file" assistant notice.
 * These notices are shown in the chat UI only and must NOT be sent to the LLM
 * (they break turn ordering and add noise). Kept here so the producer and the
 * LLM-normalisation filter agree on the exact string.
 */
export const DISCOVERY_NOTICE_PREFIX = "🔍 Discovered matching system file:";
/** Transient UI-only notice when ambient search finds file(s) in standard chat. */
export const AMBIENT_FOUND_PREFIX = "🔍 Found";

export function isDiscoveryNotice(content: string): boolean {
  return (
    content.startsWith(DISCOVERY_NOTICE_PREFIX) ||
    content.startsWith(AMBIENT_FOUND_PREFIX)
  );
}

export function toContextMessages(messages: ChatMessage[]): ChatContextMessage[] {
  return messages.map(({ role, content }) => ({ role, content }));
}

/**
 * Normalise a message list before sending it to the local LLM.
 *
 * Strict chat templates (e.g. Qwen) reject payloads where a `system` message is
 * not the single first message ("System message must be at the beginning").
 * Several independent features can each prepend a `system` message (web search
 * context, ambient file context, auto-compaction summary), which produced
 * multiple `system` messages and a 500 from llama-server.
 *
 * This collapses every `system` message into one leading `system` message
 * (joined in order) and drops transient UI-only discovery notices.
 */
export function normalizeMessagesForLlm(
  messages: ChatContextMessage[]
): ChatContextMessage[] {
  const systemParts: string[] = [];
  const rest: ChatContextMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const content = message.content.trim();
      if (content) systemParts.push(content);
      continue;
    }
    // Discovery notices are UI-only; never feed them to the model.
    if (message.role === "assistant" && isDiscoveryNotice(message.content)) {
      continue;
    }
    rest.push(message);
  }

  if (systemParts.length === 0) return rest;

  return [
    { role: "system", content: systemParts.join("\n\n---\n\n") },
    ...rest,
  ];
}

export function resolveReservedOutputTokens(maxTokens: number | undefined): number {
  const fallback = 2048;
  const safe = Number.isFinite(maxTokens) ? Math.round(maxTokens as number) : fallback;
  return Math.max(128, Math.min(8192, safe));
}

export function applyCompactionResultToSession(
  originalMessages: ChatMessage[],
  originalMediaAssets: Record<number, MediaAsset[]>,
  result: ChatContextCompactionResult
): { messages: ChatMessage[]; mediaAssets: Record<number, MediaAsset[]> } {
  const keptIndices = result.keptIndices
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < originalMessages.length)
    .sort((a, b) => a - b);

  const rebuiltMessages = keptIndices.map((idx) => originalMessages[idx]);
  const rebuiltMediaAssets: Record<number, MediaAsset[]> = {};

  keptIndices.forEach((originalIdx, nextIdx) => {
    if (originalMediaAssets[originalIdx]) {
      rebuiltMediaAssets[nextIdx] = originalMediaAssets[originalIdx];
    }
  });

  if (typeof result.summaryInsertIndex === "number") {
    const insertAt = Math.max(0, Math.min(result.summaryInsertIndex, rebuiltMessages.length));
    const summaryPayload = result.messages[insertAt] ?? {
      role: "system" as const,
      content: "Conversation summary (auto-compacted):\nPrevious context was compacted.",
    };

    rebuiltMessages.splice(insertAt, 0, {
      role: summaryPayload.role,
      content: summaryPayload.content,
    });

    const shifted: Record<number, MediaAsset[]> = {};
    Object.entries(rebuiltMediaAssets).forEach(([idxStr, assets]) => {
      const idx = Number(idxStr);
      shifted[idx >= insertAt ? idx + 1 : idx] = assets;
    });

    return {
      messages: rebuiltMessages,
      mediaAssets: shifted,
    };
  }

  return {
    messages: rebuiltMessages,
    mediaAssets: rebuiltMediaAssets,
  };
}
