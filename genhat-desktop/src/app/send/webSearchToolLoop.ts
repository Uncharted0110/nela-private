/**
 * OpenAI-style host-mediated web_search tool loop.
 *
 * When web is enabled the model may emit a JSON tool call; the host runs
 * Api.webSearch and continues until a final prose answer (max 2 tool rounds).
 */

import { Api } from "../../api";
import type {
  ChatContextMessage,
  LlmMessage,
  SearchHit,
  WebSearchResult,
  ExtractedWebTable,
} from "../../types";
import { extractWebSearchQuery } from "../webSearchQuery";
import type { GenerationOptions } from "./types";

export const WEB_SEARCH_TOOL_SYSTEM = `You have a web_search tool for current, factual, or external information.

To search the web, reply with ONLY this JSON (no markdown, no other text):
{"tool":"web_search","query":"concise search query"}

To answer without searching, reply with normal prose (not JSON).
After you receive tool results, answer using those sources. Do not invent facts that are not in the results.`;

const MAX_TOOL_ROUNDS = 2;

export interface WebSearchToolCall {
  tool: "web_search";
  query: string;
  depth?: "snippets" | "full";
}

export interface WebSearchToolLoopOptions {
  messages: ChatContextMessage[];
  webDepth: "snippets" | "full";
  modelId?: string | null;
  signal?: AbortSignal;
  disableThinking?: boolean;
  generationOptions?: GenerationOptions;
  onChunk: (chunk: string) => void;
  onThinking: (thinking: string) => void;
}

export interface WebSearchToolLoopResult {
  content: string;
  thinking: string;
  webSearchResult: WebSearchResult | null;
}

/** Try to parse a web_search tool call from model output. */
export function parseWebSearchToolCall(text: string): WebSearchToolCall | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());

  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace?.[0] && brace[0] !== trimmed) candidates.push(brace[0]);

  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const tool =
        (typeof obj.tool === "string" && obj.tool) ||
        (typeof obj.name === "string" && obj.name) ||
        "";
      if (tool !== "web_search") continue;

      let query = "";
      let depth: "snippets" | "full" | undefined;
      if (typeof obj.query === "string") {
        query = obj.query.trim();
        if (obj.depth === "snippets" || obj.depth === "full") depth = obj.depth;
      } else if (obj.arguments && typeof obj.arguments === "object") {
        const args = obj.arguments as Record<string, unknown>;
        if (typeof args.query === "string") query = args.query.trim();
        if (args.depth === "snippets" || args.depth === "full") depth = args.depth;
      }
      if (!query) continue;
      return { tool: "web_search", query: query.slice(0, 200), depth };
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function mergeWebSearchResults(
  a: WebSearchResult | null,
  b: WebSearchResult
): WebSearchResult {
  if (!a) return b;

  const seen = new Set(a.results.map((r) => r.url));
  const mergedHits: SearchHit[] = [...a.results];
  for (const hit of b.results) {
    if (!seen.has(hit.url)) {
      seen.add(hit.url);
      mergedHits.push(hit);
    }
  }

  const tables: ExtractedWebTable[] = [
    ...(a.extracted_tables ?? []),
    ...(b.extracted_tables ?? []),
  ];

  const contexts = [a.formatted_context, b.formatted_context].filter((c) =>
    c?.trim()
  );

  return {
    query: a.query === b.query ? a.query : `${a.query}; ${b.query}`,
    results: mergedHits,
    formatted_context: contexts.join("\n\n"),
    extracted_tables: tables.length > 0 ? tables : undefined,
  };
}

function withWebToolSystem(messages: ChatContextMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [{ role: "system", content: WEB_SEARCH_TOOL_SYSTEM }];
  for (const m of messages) {
    if (m.role === "system") {
      // Fold extra system into the tool system message (llama templates want one system).
      out[0] = {
        role: "system",
        content: `${WEB_SEARCH_TOOL_SYSTEM}\n\n---\n\n${m.content}`,
      };
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function streamChatPromise(
  messages: LlmMessage[],
  opts: WebSearchToolLoopOptions
): Promise<{ content: string; thinking: string }> {
  return new Promise((resolve, reject) => {
    let content = "";
    let thinking = "";
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

    Api.streamChat(
      messages,
      (chunk) => {
        content += chunk;
        opts.onChunk(chunk);
      },
      (t) => {
        thinking += t;
        opts.onThinking(t);
      },
      () => {
        settle(() => resolve({ content, thinking }));
      },
      (err) => {
        settle(() => reject(err));
      },
      undefined,
      opts.modelId,
      opts.signal,
      opts.disableThinking,
      opts.generationOptions
    );
  });
}

/**
 * Run the agentic web_search loop, then stream the final answer via onChunk.
 */
export async function runWebSearchToolLoop(
  opts: WebSearchToolLoopOptions
): Promise<WebSearchToolLoopResult> {
  let messages = withWebToolSystem(opts.messages);
  let webSearchResult: WebSearchResult | null = null;
  let thinking = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const decision = await Api.completeChat(messages, {
      modelId: opts.modelId,
      signal: opts.signal,
      disableThinking: opts.disableThinking,
      maxTokens: Math.min(opts.generationOptions?.maxTokens ?? 512, 512),
      temperature: 0.2,
      topP: opts.generationOptions?.topP,
      topK: opts.generationOptions?.topK,
      repeatPenalty: opts.generationOptions?.repeatPenalty,
    });

    if (decision.thinking) thinking += decision.thinking;

    const call = parseWebSearchToolCall(decision.content);
    if (!call) {
      // Model answered without a tool call — deliver prose to the UI.
      if (decision.content.trim()) {
        opts.onChunk(decision.content);
        return {
          content: decision.content,
          thinking,
          webSearchResult,
        };
      }
      break;
    }

    const fetchContent =
      call.depth === "full" ||
      (call.depth !== "snippets" && opts.webDepth === "full");
    const maxResults = fetchContent ? 4 : 5;
    const canSearchAgain = round + 1 < MAX_TOOL_ROUNDS;

    messages = [
      ...messages,
      {
        role: "assistant",
        content: JSON.stringify({
          tool: "web_search",
          query: call.query,
          ...(call.depth ? { depth: call.depth } : {}),
        }),
        name: "web_search",
      },
    ];

    try {
      const result = await Api.webSearch(call.query, maxResults, fetchContent);
      if (result.results.length > 0 || result.formatted_context?.trim()) {
        webSearchResult = mergeWebSearchResults(webSearchResult, result);
      }
      const toolBody =
        result.formatted_context?.trim() ||
        (result.results.length === 0
          ? `No web results found for query: ${call.query}`
          : result.results
              .map((h, i) => `${i + 1}. ${h.title}\n${h.snippet}\n${h.url}`)
              .join("\n\n"));

      messages = [
        ...messages,
        {
          role: "tool",
          name: "web_search",
          tool_call_id: `web_search_${round}`,
          content: toolBody,
        },
        {
          role: "user",
          content: canSearchAgain
            ? "Using the tool results above, answer the user's question. " +
              "If you still need different information, you may call web_search once more with a better query; otherwise answer in prose."
            : "Using the tool results above, answer the user's question in prose now. Do not call tools again.",
        },
      ];

      if (!canSearchAgain) break;
    } catch (e) {
      console.warn("[web_search tool] Failed:", e);
      messages = [
        ...messages,
        {
          role: "tool",
          name: "web_search",
          tool_call_id: `web_search_${round}`,
          content: `web_search failed: ${e}. Answer from your knowledge and note that live search was unavailable.`,
        },
        {
          role: "user",
          content:
            "Web search failed. Answer the user's question as best you can without live results.",
        },
      ];
      break;
    }
  }

  // Final streamed answer after tool rounds (or empty decision).
  const streamed = await streamChatPromise(messages, opts);
  return {
    content: streamed.content,
    thinking: thinking + (streamed.thinking || ""),
    webSearchResult,
  };
}

/**
 * Ask the model for 1–3 web search queries for artifact grounding.
 */
export async function formulateArtifactWebQueries(
  artifactRequest: string,
  options?: {
    modelId?: string | null;
    signal?: AbortSignal;
    maxQueries?: number;
  }
): Promise<string[]> {
  const maxQueries = options?.maxQueries ?? 3;
  const messages: LlmMessage[] = [
    {
      role: "system",
      content:
        "You choose web search queries for grounding an artifact. " +
        `Reply with ONLY JSON: {"queries":["query1",...]} with 1 to ${maxQueries} concise search queries. ` +
        "No markdown, no other text.",
    },
    {
      role: "user",
      content: `Artifact request:\n${artifactRequest.slice(0, 1500)}`,
    },
  ];

  try {
    const { content } = await Api.completeChat(messages, {
      modelId: options?.modelId,
      signal: options?.signal,
      disableThinking: true,
      maxTokens: 256,
      temperature: 0.2,
    });

    const parsed = parseArtifactQueriesJson(content, maxQueries);
    if (parsed.length > 0) return parsed;
  } catch (e) {
    console.warn("[artifact web queries] formulation failed:", e);
  }

  // Fallback: strip slash commands from the request (legacy behavior).
  const fallback = extractWebSearchQuery(artifactRequest);
  return fallback ? [fallback] : [];
}

function parseArtifactQueriesJson(text: string, maxQueries: number): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace?.[0]) candidates.push(brace[0]);

  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const list = obj.queries;
      if (!Array.isArray(list)) continue;
      const queries = list
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.trim())
        .filter(Boolean)
        .slice(0, maxQueries);
      if (queries.length > 0) return queries;
    } catch {
      // next
    }
  }
  return [];
}
