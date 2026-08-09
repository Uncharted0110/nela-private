/**
 * OpenAI-style host-mediated web_search tool loop.
 *
 * When web is enabled the model may emit a JSON tool call; the host runs
 * Api.webSearch and continues until a final prose answer (up to 20 tool rounds).
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
import { groundWebSearchQuery, resolveFollowUpSearchQuery } from "./followUpSearchQuery";
import type { GenerationOptions } from "./types";
import { MAX_WEB_SEARCH_TOOL_ROUNDS } from "./webSearchLimits";

export const WEB_SEARCH_TOOL_SYSTEM = `You have web tools for current, factual, or external information.
When the user asks about news, prices, sports, docs, trips, flights, or anything that needs up-to-date facts, call a tool before answering.
You may call tools multiple times (different queries) until you have enough coverage — up to ${MAX_WEB_SEARCH_TOOL_ROUNDS} rounds.

Treat follow-ups as continuing the prior topic. If they planned a Spain trip and then ask about flights/hotels/food, include Spain (and any dates/constraints) in every search query. Never search a bare word like "flights" alone when the conversation already established a destination or product.

To search the web, reply with ONLY this JSON (no markdown, no other text):
{"tool":"web_search","query":"concise self-contained search query"}
Optional fields: "profile" ("simple" for quick lookups, "news" for current events, "research" for comparisons/summaries with full page content), "site" (restrict to one domain, e.g. "wikipedia.org"), "time_range" ("day"|"week"|"month"|"year").

To read specific pages in full after a search, reply with ONLY:
{"tool":"web_extract","urls":["https://..."],"query":"what you are looking for"}

To answer without searching, reply with normal prose (not JSON).
After you receive tool results, answer using those sources.
Cite with inline [n] markers matching the numbered web sources (e.g. "…in 1899.[1]"), placed AFTER the sentence period.
Do NOT paste raw URLs, 【url】 brackets, or a trailing Sources list — the UI shows link icons for citations.
Do not invent facts that are not in the results.`;

const MAX_TOOL_ROUNDS = MAX_WEB_SEARCH_TOOL_ROUNDS;

export interface WebSearchToolCall {
  tool: "web_search";
  query: string;
  profile?: "simple" | "news" | "research";
  site?: string;
  timeRange?: "day" | "week" | "month" | "year";
}

export interface WebExtractToolCall {
  tool: "web_extract";
  urls: string[];
  query?: string;
}

export type HostWebToolCall = WebSearchToolCall | WebExtractToolCall;

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

function asProfile(v: unknown): WebSearchToolCall["profile"] {
  return v === "simple" || v === "news" || v === "research" ? v : undefined;
}

function asTimeRange(v: unknown): WebSearchToolCall["timeRange"] {
  return v === "day" || v === "week" || v === "month" || v === "year"
    ? v
    : undefined;
}

/** Try to parse a web_search / web_extract tool call from model output. */
export function parseWebSearchToolCall(text: string): HostWebToolCall | null {
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
      // Some models nest fields under "arguments".
      const args: Record<string, unknown> =
        obj.arguments && typeof obj.arguments === "object"
          ? (obj.arguments as Record<string, unknown>)
          : obj;

      if (tool === "web_extract") {
        const urls = Array.isArray(args.urls)
          ? (args.urls as unknown[])
              .filter((u): u is string => typeof u === "string")
              .filter((u) => u.startsWith("http"))
              .slice(0, 5)
          : [];
        if (urls.length === 0) continue;
        return {
          tool: "web_extract",
          urls,
          query:
            typeof args.query === "string" && args.query.trim()
              ? args.query.trim().slice(0, 200)
              : undefined,
        };
      }

      if (tool !== "web_search") continue;

      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) continue;
      // Legacy depth mapping: "full" used to mean fetch page content.
      const profile =
        asProfile(args.profile) ??
        (args.depth === "full" ? "research" : undefined);
      return {
        tool: "web_search",
        query: query.slice(0, 200),
        profile,
        site:
          typeof args.site === "string" && args.site.trim()
            ? args.site.trim()
            : undefined,
        timeRange: asTimeRange(args.time_range ?? args.timeRange),
      };
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
  if (!a) {
    return {
      ...b,
      queries: b.queries?.length ? b.queries : b.query ? [b.query] : [],
    };
  }

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

  const images = Array.from(
    new Set([...(a.images ?? []), ...(b.images ?? [])])
  ).slice(0, 12);

  return {
    query: a.query === b.query ? a.query : `${a.query}; ${b.query}`,
    queries: Array.from(
      new Set(
        [...(a.queries ?? [a.query]), ...(b.queries ?? [b.query])].filter(
          (q) => Boolean(q?.trim())
        )
      )
    ),
    results: mergedHits,
    formatted_context: contexts.join("\n\n"),
    extracted_tables: tables.length > 0 ? tables : undefined,
    answer: a.answer ?? b.answer,
    images: images.length > 0 ? images : undefined,
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
      idSlot: opts.generationOptions?.idSlot,
      sessionId: opts.generationOptions?.sessionId,
      workspaceId: opts.generationOptions?.workspaceId,
    });

    if (decision.thinking) thinking += decision.thinking;

    const call = parseWebSearchToolCall(decision.content);
    // When web is on, don't let the model answer from memory on round 0 —
    // force a search using the user's last message.
    if (!call) {
      if (round === 0) {
        const lastUser = [...opts.messages]
          .reverse()
          .find((m) => m.role === "user" && m.content.trim());
        const rawQ = (lastUser?.content ?? "").trim().slice(0, 200);
        if (rawQ) {
          let q = rawQ;
          try {
            q = await resolveFollowUpSearchQuery({
              messages: opts.messages,
              userText: rawQ,
              modelId: opts.modelId,
              signal: opts.signal,
            });
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") throw e;
          }
          // Fall through into the search path with a synthetic call.
          const forced = {
            tool: "web_search" as const,
            query: q,
            profile:
              opts.webDepth === "full"
                ? ("research" as const)
                : ("news" as const),
          };
          const canSearchAgain = round + 1 < MAX_TOOL_ROUNDS;
          messages = [
            ...messages,
            {
              role: "assistant",
              content: JSON.stringify(forced),
              name: "web_search",
            },
          ];
          try {
            const maxResults = forced.profile === "research" ? 8 : 5;
            const result = await Api.webSearch(forced.query, maxResults, {
              profile: forced.profile,
            });
            if (result.results.length > 0 || result.formatted_context?.trim()) {
              webSearchResult = mergeWebSearchResults(webSearchResult, result);
            }
            const toolBody =
              result.formatted_context?.trim() ||
              (result.results.length === 0
                ? `No web results found for query: ${forced.query}`
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
                  ? `Using the tool results above, continue. You have ${MAX_TOOL_ROUNDS - (round + 1)} tool rounds left — ` +
                    "call web_search with a NEW focused query if needed; otherwise answer in prose with inline [n] citations (no raw URLs)."
                  : "Using the tool results above, answer the user's question in prose now with inline [n] citations only (no raw URLs, no Sources list). Do not call tools again.",
              },
            ];
            if (!canSearchAgain) break;
            continue;
          } catch (e) {
            console.warn("[web_search tool] Forced search failed:", e);
          }
        }
      }
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

    const canSearchAgain = round + 1 < MAX_TOOL_ROUNDS;
    const toolName = call.tool;

    messages = [
      ...messages,
      {
        role: "assistant",
        content: JSON.stringify(call),
        name: toolName,
      },
    ];

    try {
      let toolBody: string;

      if (call.tool === "web_extract") {
        const result = await Api.webExtract(call.urls, call.query, "basic");
        if (result.results.length > 0) {
          const asSearchResult: WebSearchResult = {
            query: call.query ?? call.urls[0]!,
            results: result.results.map((p) => ({
              title: p.url,
              snippet: p.content.slice(0, 600),
              url: p.url,
              image_url: p.images?.[0] ?? null,
            })),
            formatted_context: "",
            extracted_tables: result.extracted_tables,
            images: result.results.flatMap((p) => p.images ?? []).slice(0, 8),
          };
          webSearchResult = mergeWebSearchResults(
            webSearchResult,
            asSearchResult
          );
        }
        toolBody =
          result.formatted_context?.trim() ||
          "No content could be extracted from the provided URLs.";
      } else {
        let searchQuery = call.query;
        try {
          searchQuery = await groundWebSearchQuery(call.query, {
            messages: opts.messages,
            userText: call.query,
            modelId: opts.modelId,
            signal: opts.signal,
          });
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") throw e;
        }
        const profile =
          call.profile ?? (opts.webDepth === "full" ? "research" : "simple");
        const maxResults = profile === "research" ? 8 : 5;
        const result = await Api.webSearch(searchQuery, maxResults, {
          profile,
          site: call.site,
          timeRange: call.timeRange,
        });
        if (result.results.length > 0 || result.formatted_context?.trim()) {
          webSearchResult = mergeWebSearchResults(webSearchResult, result);
        }
        toolBody =
          result.formatted_context?.trim() ||
          (result.results.length === 0
            ? `No web results found for query: ${searchQuery}`
            : result.results
                .map((h, i) => `${i + 1}. ${h.title}\n${h.snippet}\n${h.url}`)
                .join("\n\n"));
      }

      messages = [
        ...messages,
        {
          role: "tool",
          name: toolName,
          tool_call_id: `${toolName}_${round}`,
          content: toolBody,
        },
        {
          role: "user",
          content: canSearchAgain
            ? `Using the tool results above, continue. You have ${MAX_TOOL_ROUNDS - (round + 1)} tool rounds left — ` +
              "call web_search with a NEW focused query (or web_extract on promising URLs) if more facets are needed; otherwise answer in prose with inline [n] citations (no raw URLs)."
            : "Using the tool results above, answer the user's question in prose now with inline [n] citations only (no raw URLs, no Sources list). Do not call tools again.",
        },
      ];

      if (!canSearchAgain) break;
    } catch (e) {
      console.warn(`[${toolName} tool] Failed:`, e);
      messages = [
        ...messages,
        {
          role: "tool",
          name: toolName,
          tool_call_id: `${toolName}_${round}`,
          content: `${toolName} failed: ${e}. Answer from your knowledge and note that live search was unavailable.`,
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
        "Queries must be short keyword searches about the USER'S TOPIC (places, brands, facts). " +
        "Never paste the full artifact request or conversational phrasing as a query. " +
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
