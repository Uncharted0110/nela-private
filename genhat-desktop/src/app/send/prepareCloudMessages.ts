/**
 * Shape chat messages for OpenRouter prompt caching.
 *
 * Stable prefixes (NELA identity, artifact JSON schemas) must stay as the
 * first system message and must not be merged with per-turn dynamic context.
 * Local llama.cpp templates require a single leading system message — that
 * collapse happens only on the local path via normalizeMessagesForLlm.
 */

import {
  NELA_CLOUD_SYSTEM_PROMPT,
  peelNelaIdentity,
} from "../nelaSystemPrompt";
import { isDiscoveryNotice } from "../contextCompaction";

import type {
  CloudChatContent,
  CloudChatMessage,
  CloudToolCall,
} from "../../types";

export type CloudCacheMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: CloudChatContent;
  tool_calls?: CloudToolCall[];
  tool_call_id?: string;
  name?: string;
  annotations?: CloudChatMessage["annotations"];
};

/**
 * Prepare messages before sending to NELA Cloud / OpenRouter:
 * 1. Drop UI-only discovery notices.
 * 2. Keep a stable first system message (cloud identity or artifact schema).
 * 3. Put other system instructions in a second system message (not merged).
 */
export function prepareMessagesForCloudCaching<T extends CloudCacheMessage>(
  messages: T[]
): T[] {
  const systems: string[] = [];
  const rest: T[] = [];

  for (const message of messages) {
    if (
      message.role === "assistant" &&
      typeof message.content === "string" &&
      isDiscoveryNotice(message.content)
    ) {
      continue;
    }
    if (message.role === "system") {
      const content =
        typeof message.content === "string" ? message.content.trim() : "";
      if (content) systems.push(content);
      continue;
    }
    rest.push(message);
  }

  if (systems.length === 0) return rest;

  const peeled = peelNelaIdentity(systems[0]!);
  const otherFromFirst = peeled.rest;
  const remaining = systems.slice(1);

  if (peeled.identity) {
    const others = [otherFromFirst, ...remaining].filter(Boolean);
    return [
      { role: "system", content: peeled.identity } as T,
      ...others.map((content) => ({ role: "system", content }) as T),
      ...rest,
    ];
  }

  // Artifact / edit prompts: keep the first system alone for cache hits;
  // do not merge subsequent system parts into it.
  return [
    { role: "system", content: systems[0] } as T,
    ...remaining.map((content) => ({ role: "system", content }) as T),
    ...rest,
  ];
}

/** Re-export for callers that need the cloud identity constant. */
export { NELA_CLOUD_SYSTEM_PROMPT };
