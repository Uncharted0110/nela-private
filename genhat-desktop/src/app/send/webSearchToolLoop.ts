/**
 * OpenAI-style host-mediated tool loop for local models.
 *
 * When web and/or file search are enabled the model may emit a JSON tool call;
 * the host runs Api.webSearch / Api.queryKnowledgeBase and continues until a
 * final prose answer (up to 20 tool rounds).
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
import { groundWebSearchQuery } from "./followUpSearchQuery";
import { normalizeWebToolDepth, runWebSearchWithDepth } from "./webSearchDepth";
import type { WebToolDepth } from "./webSearchDepth";
import type { GenerationOptions } from "./types";
import { MAX_WEB_SEARCH_TOOL_ROUNDS } from "./webSearchLimits";
import { useDocGraphStore } from "../../stores/docGraphStore";
import {
  knowledgeBaseToSearchResult,
  fileUrlToPath,
  isLocalFileHitUrl,
} from "./fileSearchCitations";

export const WEB_SEARCH_TOOL_SYSTEM = `You have a web_search tool for live public-web facts.
Call it ONLY when you need current/external information — never by default.
Reply with ONLY this JSON (no markdown):
{"tool":"web_search","query":"concise keyword query","depth":"snippet|full|standard|deep"}
depth meanings: snippet = quick facts; full = richer page content; standard = multi-facet research; deep = exhaustive multi-facet research.
Optional after web_search: {"tool":"web_extract","urls":["https://..."],"query":"what you need"}
Cite web results with inline [n] markers only (no raw URLs).`;

export const FILE_SEARCH_TOOL_SYSTEM = `You have a search_knowledge_base tool for the user's local indexed document graph (hybrid BM25 + dense vector embeddings + structural expansion).
Call it for their files, resumes, notes, PDFs, slides, or on-device documents.
Reply with ONLY this JSON (no markdown):
{"tool":"search_knowledge_base","query":"keyphrase","top_k":25}
Prefer higher top_k (25–40) so graph/vector retrieval can surface related chunks; use 10–15 only for pinpoint lookups (max 50).
After tool results, answer from those sources with inline [n] citations only (no raw file paths or Sources list).`;

const MAX_TOOL_ROUNDS = MAX_WEB_SEARCH_TOOL_ROUNDS;

export interface WebSearchToolCall {
  tool: "web_search";
  query: string;
  depth: WebToolDepth;
}

export interface WebExtractToolCall {
  tool: "web_extract";
  urls: string[];
  query?: string;
}

export interface FileSearchToolCall {
  tool: "search_knowledge_base";
  query: string;
  topK?: number;
}

export type HostWebToolCall =
  | WebSearchToolCall
  | WebExtractToolCall
  | FileSearchToolCall;

export interface WebSearchToolLoopOptions {
  messages: ChatContextMessage[];
  webDepth: "snippets" | "full";
  /** Default true for backward compatibility. */
  webEnabled?: boolean;
  fileSearchEnabled?: boolean;
  modelId?: string | null;
  signal?: AbortSignal;
  disableThinking?: boolean;
  generationOptions?: GenerationOptions;
  onChunk: (chunk: string) => void;
  onThinking: (thinking: string) => void;
  onToolStatus?: (status: string | null) => void;
}

export interface WebSearchToolLoopResult {
  content: string;
  thinking: string;
  webSearchResult: WebSearchResult | null;
}

function buildHostToolSystem(opts: {
  webEnabled: boolean;
  fileSearchEnabled: boolean;
}): string {
  const parts: string[] = [];
  if (opts.webEnabled) parts.push(WEB_SEARCH_TOOL_SYSTEM);
  if (opts.fileSearchEnabled) parts.push(FILE_SEARCH_TOOL_SYSTEM);
  return parts.join("\n\n");
}

/** Try to parse a web_search / web_extract / search_knowledge_base tool call. */
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

      if (
        tool === "search_knowledge_base" ||
        tool === "file_search" ||
        tool === "search_files"
      ) {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) continue;
        const topKRaw = args.top_k ?? args.topK;
        const topK =
          typeof topKRaw === "number" && Number.isFinite(topKRaw)
            ? Math.max(1, Math.min(50, Math.floor(topKRaw)))
            : 25;
        return {
          tool: "search_knowledge_base",
          query: query.slice(0, 200),
          topK,
        };
      }

      if (tool !== "web_search") continue;

      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) continue;
      return {
        tool: "web_search",
        query: query.slice(0, 200),
        depth: normalizeWebToolDepth(args.depth ?? args.web_depth),
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
  const hitKey = (url: string) =>
    isLocalFileHitUrl(url)
      ? fileUrlToPath(url).replace(/\\/g, "/").toLowerCase()
      : url;

  if (!a) {
    return {
      ...b,
      queries: b.queries?.length ? b.queries : b.query ? [b.query] : [],
    };
  }

  const seen = new Set(a.results.map((r) => hitKey(r.url)));
  const mergedHits: SearchHit[] = [...a.results];
  for (const hit of b.results) {
    const key = hitKey(hit.url);
    if (!seen.has(key)) {
      seen.add(key);
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

function withWebToolSystem(
  messages: ChatContextMessage[],
  opts: { webEnabled: boolean; fileSearchEnabled: boolean }
): LlmMessage[] {
  const toolSystem = buildHostToolSystem(opts);
  const out: LlmMessage[] = [{ role: "system", content: toolSystem }];
  for (const m of messages) {
    if (m.role === "system") {
      // Fold extra system into the tool system message (llama templates want one system).
      out[0] = {
        role: "system",
        content: `${toolSystem}\n\n---\n\n${m.content}`,
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
 * Run the agentic host tool loop (web and/or file search), then stream the final answer.
 */
export async function runWebSearchToolLoop(
  opts: WebSearchToolLoopOptions
): Promise<WebSearchToolLoopResult> {
  const webEnabled = opts.webEnabled !== false;
  const fileSearchEnabled = Boolean(opts.fileSearchEnabled);
  let messages = withWebToolSystem(opts.messages, {
    webEnabled,
    fileSearchEnabled,
  });
  let webSearchResult: WebSearchResult | null = null;
  let thinking = "";

  try {
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

      let call = parseWebSearchToolCall(decision.content);

      // Disable tools the host didn't enable for this turn.
      if (call?.tool === "web_search" || call?.tool === "web_extract") {
        if (!webEnabled) call = null;
      }
      if (call?.tool === "search_knowledge_base" && !fileSearchEnabled) {
        call = null;
      }

      // Never auto-force web_search. File-only turns may inject KB search once.
      if (!call && round === 0 && fileSearchEnabled && !webEnabled) {
        const lastUser = [...opts.messages]
          .reverse()
          .find((m) => m.role === "user" && m.content.trim());
        const rawQ = (lastUser?.content ?? "").trim().slice(0, 200);
        if (rawQ) {
          call = { tool: "search_knowledge_base", query: rawQ, topK: 25 };
        }
      }

      if (!call) {
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

        if (call.tool === "search_knowledge_base") {
          opts.onToolStatus?.(`Searching knowledge base for “${call.query}”`);
          useDocGraphStore.getState().openQuery(call.query);
          const md = await Api.queryKnowledgeBase(call.query, call.topK ?? 25);
          useDocGraphStore.setState({
            queryResult: md,
            queryText: call.query,
          });
          opts.onToolStatus?.(null);
          if (!md.trim() || md === "No relevant structural context found.") {
            toolBody = `No local documents matched query: ${call.query}`;
          } else {
            const asSearchResult = knowledgeBaseToSearchResult(call.query, md);
            if (asSearchResult) {
              webSearchResult = mergeWebSearchResults(
                webSearchResult,
                asSearchResult
              );
            }
            const citeLines = (webSearchResult?.results ?? [])
              .map((h, i) =>
                isLocalFileHitUrl(h.url)
                  ? `[${i + 1}] ${h.title} — ${fileUrlToPath(h.url)}`
                  : null
              )
              .filter(Boolean)
              .join("\n");
            toolBody =
              `Local knowledge-graph results for "${call.query}":\n\n${md}\n\n` +
              (citeLines
                ? `Cite these local sources with inline [n] markers from this list only:\n${citeLines}\n` +
                  `Do not paste raw paths or add a Sources list.`
                : `Cite file names in prose.`);
          }
        } else if (call.tool === "web_extract") {
          opts.onToolStatus?.(
            `Reading ${call.urls.length} page${call.urls.length > 1 ? "s" : ""}`
          );
          const result = await Api.webExtract(call.urls, call.query, "basic");
          opts.onToolStatus?.(null);
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
          const result = await runWebSearchWithDepth({
            query: searchQuery,
            depth: call.depth,
            messages: opts.messages,
            modelId: opts.modelId,
            signal: opts.signal,
            onToolStatus: opts.onToolStatus,
          });
          opts.onToolStatus?.(null);
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

        const continueHint = canSearchAgain
          ? `Using the tool results above, continue. You have ${MAX_TOOL_ROUNDS - (round + 1)} tool rounds left — ` +
            [
              webEnabled
                ? "call web_search (with depth) / web_extract if more web facts are needed"
                : null,
              fileSearchEnabled
                ? "call search_knowledge_base with a refined query (prefer higher top_k) if more local context is needed"
                : null,
              "otherwise answer in prose with inline [n] citations only (no raw URLs/paths or Sources list)",
            ]
              .filter(Boolean)
              .join("; ") +
            "."
          : "Using the tool results above, answer the user's question in prose now with inline [n] citations only (no raw URLs/paths, no Sources list). Do not call tools again.";

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
            content: continueHint,
          },
        ];

        if (!canSearchAgain) break;
      } catch (e) {
        opts.onToolStatus?.(null);
        console.warn(`[${toolName} tool] Failed:`, e);
        messages = [
          ...messages,
          {
            role: "tool",
            name: toolName,
            tool_call_id: `${toolName}_${round}`,
            content: `${toolName} failed: ${e}. Answer from your knowledge and note that the tool was unavailable.`,
          },
          {
            role: "user",
            content:
              "A tool call failed. Answer the user's question as best you can without those results.",
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
  } finally {
    opts.onToolStatus?.(null);
  }
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
