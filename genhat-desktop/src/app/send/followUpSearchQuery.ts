/**
 * Turn short / deictic follow-ups ("possible flights", "what about hotels")
 * into self-contained web search queries using recent chat context.
 */

import type { ChatContextMessage } from "../../types";
import { currentDateSystemLine } from "../nelaSystemPrompt";
import { extractWebSearchQuery } from "../webSearchQuery";
import { streamChatByMode } from "./cloudOrLocalStream";

const FOLLOW_UP_HINT =
  /^(what about|how about|and |also |ok[,.]?\s*|okay[,.]?\s*|then |so |for that|regarding|about the|the same|those|these|it|them)\b/i;

const TOPIC_CONTINUATION =
  /\b(flights?|hotels?|hostels?|airbnb|stay|staying|lodging|restaurants?|food|eat(?:ing)?|transport|trains?|buses?|car rental|visa|budget|cost|prices?|weather|packing|itinerary|days?\s*\d|day\s*\d|museums?|nightlife|safety)\b/i;

export interface ResolveFollowUpOptions {
  messages: ChatContextMessage[];
  userText: string;
  modelId?: string | null;
  signal?: AbortSignal;
  containsFileContext?: boolean;
  userConfirmedCloudContext?: boolean;
  contextSource?: string;
}

/** Prior user/assistant turns excluding the latest user message. */
export function priorConversationTurns(
  messages: ChatContextMessage[],
  maxTurns = 8
): ChatContextMessage[] {
  const turns = messages.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );
  if (turns.length === 0) return [];
  // Drop the trailing user turn (current request).
  const withoutCurrent =
    turns[turns.length - 1]?.role === "user" ? turns.slice(0, -1) : turns;
  return withoutCurrent.slice(-maxTurns);
}

export function formatConversationForSearchContext(
  messages: ChatContextMessage[],
  maxTurns = 6
): string {
  const prior = priorConversationTurns(messages, maxTurns);
  if (prior.length === 0) return "";
  return prior
    .map((m) => {
      const cap = m.role === "user" ? 500 : 700;
      return `${m.role}: ${(m.content ?? "").slice(0, cap)}`;
    })
    .join("\n");
}

/** Heuristic: current message likely depends on earlier turns. */
export function looksLikeWebFollowUp(
  userText: string,
  messages: ChatContextMessage[]
): boolean {
  const prior = priorConversationTurns(messages);
  if (prior.length === 0) return false;

  const q = userText.trim();
  if (q.length < 8) return true;
  if (FOLLOW_UP_HINT.test(q)) return true;
  if (q.length <= 80 && TOPIC_CONTINUATION.test(q)) return true;
  // Short question with almost no proper-noun mass → likely incomplete alone.
  const hasPlaceLike = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?\b/.test(q);
  if (q.length <= 60 && !hasPlaceLike && TOPIC_CONTINUATION.test(q)) return true;
  return false;
}

function completeOnce(
  messages: ChatContextMessage[],
  opts: ResolveFollowUpOptions,
  maxTokens: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      settle(() => reject(new DOMException("Aborted", "AbortError")));
    };
    opts.signal?.addEventListener("abort", onAbort);
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }

    streamChatByMode({
      messages,
      intent: "cheap_background",
      containsFileContext: opts.containsFileContext ?? false,
      userConfirmedCloudContext: opts.userConfirmedCloudContext,
      contextSource: opts.contextSource,
      modelId: opts.modelId,
      signal: opts.signal,
      disableThinking: true,
      generationOptions: { maxTokens, temperature: 0.1 },
      onChunk: (chunk) => {
        content += chunk;
      },
      onThinking: () => {},
      onFinish: () => settle(() => resolve(content)),
      onError: (err) => settle(() => reject(err)),
    });
  });
}

function cleanResolvedQuery(raw: string, fallback: string): string {
  let q = raw.trim();
  q = q.replace(/^```(?:json|text)?\s*/i, "").replace(/```$/i, "").trim();
  // Prefer {"query":"..."} if the model returned JSON.
  try {
    const obj = JSON.parse(q) as { query?: unknown };
    if (typeof obj.query === "string" && obj.query.trim()) {
      q = obj.query.trim();
    }
  } catch {
    // plain text
  }
  q = q
    .replace(/^["']|["']$/g, "")
    .replace(/^(query|search)\s*[:=]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (q.length < 3) return fallback;
  return q.slice(0, 200);
}

/**
 * Returns a self-contained web search query. When the latest user message is a
 * follow-up, folds in destination / topic / constraints from prior turns.
 */
export async function resolveFollowUpSearchQuery(
  opts: ResolveFollowUpOptions
): Promise<string> {
  const fallback = extractWebSearchQuery(opts.userText) || opts.userText.trim().slice(0, 200);
  const context = formatConversationForSearchContext(opts.messages);
  if (!context || !looksLikeWebFollowUp(opts.userText, opts.messages)) {
    return fallback;
  }

  const planMessages: ChatContextMessage[] = [
    {
      role: "system",
      content:
        "You rewrite follow-up chat messages into ONE self-contained web search query.\n" +
        "Include the place, product, trip, dates, or topic from the conversation so the query stands alone.\n" +
        `${currentDateSystemLine()}\n` +
        "If the request is time-sensitive, keep the explicit period (quarter, month, year) in the query and never downgrade it to an earlier year.\n" +
        'Example: prior talk about a 1-week Spain itinerary + user says "possible flights" → "flights to Spain for 1 week trip".\n' +
        "Reply with ONLY the search query text (or JSON {\"query\":\"...\"}). No explanations.",
    },
    {
      role: "user",
      content:
        `Conversation so far:\n${context}\n\n` +
        `Latest follow-up:\n${opts.userText.slice(0, 500)}\n\n` +
        `Self-contained search query:`,
    },
  ];

  try {
    const raw = await completeOnce(planMessages, opts, 80);
    return cleanResolvedQuery(raw, fallback);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    console.warn("[followUpSearch] resolve failed:", e);
    return fallback;
  }
}

/**
 * Expand an underspecified tool query using chat context (e.g. model searched
 * only "flights" after a Spain itinerary thread).
 */
export async function groundWebSearchQuery(
  query: string,
  opts: ResolveFollowUpOptions
): Promise<string> {
  const q = query.trim();
  if (!q) return resolveFollowUpSearchQuery(opts);

  const context = formatConversationForSearchContext(opts.messages);
  if (!context) return q;

  // Already looks grounded enough.
  if (q.length >= 24 && /\b[A-Z][a-z]{2,}\b/.test(q)) return q;
  if (!looksLikeWebFollowUp(q, opts.messages) && q.length > 50) return q;

  return resolveFollowUpSearchQuery({
    ...opts,
    userText: q,
  });
}
