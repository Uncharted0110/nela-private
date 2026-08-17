/**
 * Recent-chat grounding for artifact CREATE requests.
 *
 * Artifact generation is otherwise stateless — it only sees the latest user
 * prompt. Give the existing artifact planner a compact candidate source and let
 * that same model decide whether the new request depends on it. This avoids a
 * separate classifier call while handling implicit follow-ups that keyword
 * rules would miss.
 */

import type { ChatMessage } from "../../types";

/** Default character budget for the injected prior-answer block. */
export const MAX_CONVERSATION_CONTEXT_CHARS = 8000;

/** Assistant turns shorter than this are placeholders or filler, not sources. */
const MIN_SOURCE_CHARS = 120;

/** Drop artifact placeholders / empty streaming shells. */
function isUsableSourceMessage(msg: ChatMessage): boolean {
  if (msg.role !== "assistant") return false;
  const content = msg.content?.trim() ?? "";
  if (content.length < MIN_SOURCE_CHARS) return false;
  // Artifact turns carry prose about a generated file, not reusable content.
  if (msg.artifactPath) return false;
  return true;
}

function markdownTableBlocks(content: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of content.split("\n")) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      current.push(line);
      continue;
    }
    if (current.length >= 2) blocks.push(current.join("\n"));
    current = [];
  }
  if (current.length >= 2) blocks.push(current.join("\n"));
  return blocks;
}

/**
 * Trim an answer to a budget while protecting the parts that carry data.
 * Tables and fenced blocks hold the numbers a spreadsheet/deck needs, so they
 * survive truncation ahead of surrounding prose.
 */
function trimAnswerForBudget(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  const tables = markdownTableBlocks(content);
  const fenced = content.match(/```[\s\S]*?```/g) ?? [];
  const priority = [...tables, ...fenced].join("\n\n");

  if (priority && priority.length <= maxChars) {
    const remaining = maxChars - priority.length;
    const prose = content
      .replace(/```[\s\S]*?```/g, "")
      .replace(/^\s*\|.*\|\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const head = prose.slice(0, Math.max(0, remaining - 40)).trim();
    return head
      ? `${head}\n\n[…prose truncated; data preserved below…]\n\n${priority}`
      : priority;
  }

  return `${content.slice(0, maxChars).trim()}\n\n[…truncated to fit the model context window…]`;
}

export interface ConversationArtifactSource {
  /** Formatted block to prepend to the artifact plan prompt. */
  block: string;
  /** The assistant answer that was reused, untrimmed. */
  sourceAnswer: string;
  /** True when that answer contained at least one markdown table. */
  hasTable: boolean;
}

/**
 * Extract the most recent substantive assistant answer (plus the user request
 * that produced it) as candidate context for an artifact request.
 *
 * Returns null when there is nothing worth injecting.
 */
export function buildConversationArtifactSource(
  messages: ChatMessage[],
  opts?: { maxChars?: number }
): ConversationArtifactSource | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const maxChars = opts?.maxChars ?? MAX_CONVERSATION_CONTEXT_CHARS;

  let answerIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && isUsableSourceMessage(msg)) {
      answerIndex = i;
      break;
    }
  }
  if (answerIndex < 0) return null;

  const answer = messages[answerIndex]!.content.trim();

  let priorRequest = "";
  for (let i = answerIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user" && msg.content?.trim()) {
      priorRequest = msg.content.trim().slice(0, 500);
      break;
    }
  }

  const requestLine = priorRequest
    ? `The user previously asked: ${priorRequest}\n\n`
    : "";
  const overhead = 600 + requestLine.length;
  const trimmedAnswer = trimAnswerForBudget(
    answer,
    Math.max(500, maxChars - overhead)
  );

  const block =
    `=== RECENT CHAT CONTEXT (candidate source; decide relevance) ===\n` +
    `First decide whether the current artifact request depends on this prior ` +
    `exchange. If it does, use the relevant values, rows, labels, and figures ` +
    `exactly as written. If it does not, ignore this entire block and fulfill ` +
    `the current request independently.\n` +
    `When relevant, do NOT invent replacement data, substitute a different time ` +
    `period, or ask the user to supply data that is already present here.\n\n` +
    requestLine +
    `Your previous answer:\n${trimmedAnswer}\n` +
    `=== END RECENT CHAT CONTEXT ===\n\n`;

  return {
    block,
    sourceAnswer: answer,
    hasTable: markdownTableBlocks(answer).length > 0,
  };
}

/**
 * Give the artifact planner recent context whenever a substantive answer
 * exists. The planner itself decides relevance as part of its existing call,
 * so this adds input tokens but no extra inference round trip.
 */
export function resolveArtifactConversationSource(
  _text: string,
  messages: ChatMessage[] | undefined,
  opts?: { maxChars?: number }
): ConversationArtifactSource | null {
  if (!messages?.length) return null;
  return buildConversationArtifactSource(messages, opts);
}
