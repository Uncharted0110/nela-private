/**
 * Native OpenAI tools[] loop for NELA Cloud.
 * Executes web_search and MCP artifact tools on the desktop, then continues
 * the conversation with role:"tool" messages.
 */

import { Api } from "../../api";
import type {
  ChatContextMessage,
  CloudChatMessage,
  CloudToolCall,
  CloudToolDefinition,
  WebSearchResult,
  ArtifactResult,
} from "../../types";
import {
  formatCloudFallbackNotice,
  streamChatByMode,
  willRouteToCloud,
} from "./cloudOrLocalStream";
import { cloudToolsWebAndMcp, cloudToolsWebOnly } from "./cloudTools";
import { groundWebSearchQuery, resolveFollowUpSearchQuery } from "./followUpSearchQuery";
import { mergeWebSearchResults, runWebSearchToolLoop } from "./webSearchToolLoop";
import type { GenerationOptions } from "./types";
import { MAX_WEB_SEARCH_TOOL_ROUNDS } from "./webSearchLimits";

const MAX_TOOL_ROUNDS = MAX_WEB_SEARCH_TOOL_ROUNDS;

export interface CloudNativeToolLoopOptions {
  messages: ChatContextMessage[];
  webDepth: "snippets" | "full";
  /** Include MCP spreadsheet/presentation/html tools alongside web_search. */
  includeMcpTools?: boolean;
  containsFileContext?: boolean;
  userConfirmedCloudContext?: boolean;
  contextSource?: string;
  modelId?: string | null;
  signal?: AbortSignal;
  disableThinking?: boolean;
  generationOptions?: GenerationOptions;
  onChunk: (chunk: string) => void;
  onThinking: (thinking: string) => void;
  /** Fired when a desktop-hosted tool starts/finishes (e.g. web search UI). */
  onToolStatus?: (status: string | null) => void;
  onArtifact?: (artifact: ArtifactResult) => void;
}

export interface CloudNativeToolLoopResult {
  content: string;
  thinking: string;
  webSearchResult: WebSearchResult | null;
  artifacts: ArtifactResult[];
}

function toCloudMessages(messages: ChatContextMessage[]): CloudChatMessage[] {
  return messages.map((m) => ({
    role: m.role as CloudChatMessage["role"],
    content: m.content,
    name: (m as { name?: string }).name,
    tool_call_id: (m as { tool_call_id?: string }).tool_call_id,
    tool_calls: (m as { tool_calls?: CloudToolCall[] }).tool_calls,
  }));
}

function lastUserQuery(messages: CloudChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string" && m.content.trim()) {
      return m.content.trim().slice(0, 200);
    }
  }
  return "";
}

function streamCloudRound(
  messages: CloudChatMessage[],
  tools: CloudToolDefinition[],
  opts: CloudNativeToolLoopOptions,
  toolChoice: "auto" | "required" | { type: "function"; function: { name: string } } = "auto"
): Promise<{ content: string; tool_calls?: CloudToolCall[] }> {
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
      intent: "quick_chat",
      containsFileContext: opts.containsFileContext ?? false,
      userConfirmedCloudContext: opts.userConfirmedCloudContext,
      contextSource: opts.contextSource,
      modelId: opts.modelId,
      signal: opts.signal,
      disableThinking: opts.disableThinking,
      disableLocalFallback: true,
      tools,
      tool_choice: toolChoice,
      generationOptions: opts.generationOptions,
      onChunk: (chunk) => {
        content += chunk;
        opts.onChunk(chunk);
      },
      onThinking: opts.onThinking,
      onFinish: (meta) => {
        settle(() =>
          resolve({
            content,
            tool_calls: meta?.tool_calls,
          })
        );
      },
      onError: (err) => settle(() => reject(err)),
    });
  });
}

async function executeToolCall(
  call: CloudToolCall,
  opts: CloudNativeToolLoopOptions,
  webSearchResult: WebSearchResult | null
): Promise<{
  content: string;
  webSearchResult: WebSearchResult | null;
  artifact?: ArtifactResult;
}> {
  const name = call.function.name;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return {
      content: `Invalid JSON arguments for ${name}`,
      webSearchResult,
    };
  }

  if (name === "web_search") {
    let query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { content: "web_search requires a query", webSearchResult };
    }
    try {
      query = await groundWebSearchQuery(query, {
        messages: opts.messages,
        userText: query,
        modelId: opts.modelId,
        signal: opts.signal,
        containsFileContext: opts.containsFileContext,
        userConfirmedCloudContext: opts.userConfirmedCloudContext,
        contextSource: opts.contextSource,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
    }
    const profile =
      args.profile === "news" || args.profile === "research"
        ? args.profile
        : args.depth === "full" || opts.webDepth === "full"
          ? "research"
          : "simple";
    const site =
      typeof args.site === "string" && args.site.trim()
        ? args.site.trim()
        : undefined;
    const timeRange =
      args.time_range === "day" ||
      args.time_range === "week" ||
      args.time_range === "month" ||
      args.time_range === "year"
        ? args.time_range
        : undefined;
    const maxResults = profile === "research" ? 8 : 5;
    opts.onToolStatus?.(`Searching “${query}”`);
    try {
      const result = await Api.webSearch(query, maxResults, {
        profile,
        site,
        timeRange,
      });
      const merged =
        result.results.length > 0 || result.formatted_context?.trim()
          ? mergeWebSearchResults(webSearchResult, result)
          : webSearchResult;
      const toolBody =
        result.formatted_context?.trim() ||
        (result.results.length === 0
          ? `No web results found for query: ${query}`
          : result.results
              .map((h, i) => `${i + 1}. ${h.title}\n${h.snippet}\n${h.url}`)
              .join("\n\n"));
      opts.onToolStatus?.(null);
      return { content: toolBody, webSearchResult: merged };
    } catch (e) {
      opts.onToolStatus?.(null);
      return {
        content: `web_search failed: ${e}`,
        webSearchResult,
      };
    }
  }

  if (name === "web_extract") {
    const urls = Array.isArray(args.urls)
      ? (args.urls as unknown[])
          .filter((u): u is string => typeof u === "string")
          .filter((u) => u.startsWith("http"))
          .slice(0, 5)
      : [];
    if (urls.length === 0) {
      return { content: "web_extract requires at least one URL", webSearchResult };
    }
    const extractQuery =
      typeof args.query === "string" && args.query.trim()
        ? args.query.trim()
        : undefined;
    const depth = args.depth === "advanced" ? "advanced" : "basic";
    opts.onToolStatus?.(`Reading ${urls.length} page${urls.length > 1 ? "s" : ""}`);
    try {
      const result = await Api.webExtract(urls, extractQuery, depth);
      // Fold extracted tables/sources into the running web result so the
      // spreadsheet flow and disclosure UI see them.
      const asSearchResult: WebSearchResult = {
        query: extractQuery ?? urls[0]!,
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
      const merged =
        result.results.length > 0
          ? mergeWebSearchResults(webSearchResult, asSearchResult)
          : webSearchResult;
      const toolBody =
        result.formatted_context?.trim() ||
        `No content could be extracted from the provided URLs.`;
      opts.onToolStatus?.(null);
      return { content: toolBody, webSearchResult: merged };
    } catch (e) {
      opts.onToolStatus?.(null);
      return {
        content: `web_extract failed: ${e}`,
        webSearchResult,
      };
    }
  }

  if (name === "generate_spreadsheet") {
    try {
      const artifact = await Api.generateSpreadsheet(args);
      opts.onArtifact?.(artifact);
      return {
        content: JSON.stringify({
          ok: true,
          path: artifact.path,
          kind: artifact.kind ?? "xlsx",
        }),
        webSearchResult,
        artifact,
      };
    } catch (e) {
      return {
        content: `generate_spreadsheet failed: ${e}`,
        webSearchResult,
      };
    }
  }

  if (name === "generate_presentation") {
    try {
      const html =
        typeof args.html === "string" && args.html.trim().length > 0
          ? args.html
          : null;
      const artifact = html
        ? await Api.generateHtml({
            title:
              (typeof args.title === "string" && args.title.trim()) ||
              "Presentation",
            archetype: "landing",
            sections: [],
            html,
            output_name:
              typeof args.output_name === "string"
                ? args.output_name
                : typeof args.title === "string"
                  ? args.title
                  : undefined,
          })
        : await Api.generatePresentation(args);
      opts.onArtifact?.(artifact);
      return {
        content: JSON.stringify({
          ok: true,
          path: artifact.path,
          kind: artifact.kind ?? "html",
        }),
        webSearchResult,
        artifact,
      };
    } catch (e) {
      return {
        content: `generate_presentation failed: ${e}`,
        webSearchResult,
      };
    }
  }

  if (name === "generate_html") {
    try {
      const artifact = await Api.generateHtml(args as never);
      opts.onArtifact?.(artifact);
      return {
        content: JSON.stringify({
          ok: true,
          path: artifact.path,
          kind: artifact.kind ?? "html",
        }),
        webSearchResult,
        artifact,
      };
    } catch (e) {
      return {
        content: `generate_html failed: ${e}`,
        webSearchResult,
      };
    }
  }

  return {
    content: `Unknown tool: ${name}`,
    webSearchResult,
  };
}

/**
 * Prefer native cloud tools[] when routing to cloud; otherwise fall back to
 * the local JSON host-mediated web_search loop. Cloud failures fall back to
 * local with a short notice (same policy as streamChatByMode).
 */
export async function runCloudAwareToolLoop(
  opts: CloudNativeToolLoopOptions
): Promise<CloudNativeToolLoopResult> {
  const useCloud = willRouteToCloud({
    containsFileContext: opts.containsFileContext,
    userConfirmedCloudContext: opts.userConfirmedCloudContext,
  });

  const runLocal = async (notice?: string) => {
    let noticeSent = false;
    const onChunk = (chunk: string) => {
      if (notice && !noticeSent) {
        noticeSent = true;
        opts.onChunk(notice);
      }
      opts.onChunk(chunk);
    };
    const local = await runWebSearchToolLoop({
      messages: opts.messages,
      webDepth: opts.webDepth,
      modelId: opts.modelId,
      signal: opts.signal,
      disableThinking: opts.disableThinking,
      generationOptions: opts.generationOptions,
      onChunk,
      onThinking: opts.onThinking,
    });
    return {
      content: notice ? `${notice}${local.content}` : local.content,
      thinking: local.thinking,
      webSearchResult: local.webSearchResult,
      artifacts: [] as ArtifactResult[],
    };
  };

  if (!useCloud) {
    return runLocal();
  }

  try {
    return await runCloudNativeToolLoop(opts);
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      throw err;
    }
    console.warn("Cloud tool loop failed; falling back to local:", err);
    return runLocal(formatCloudFallbackNotice(err));
  }
}

export async function runCloudNativeToolLoop(
  opts: CloudNativeToolLoopOptions
): Promise<CloudNativeToolLoopResult> {
  const tools =
    opts.includeMcpTools === false
      ? cloudToolsWebOnly()
      : cloudToolsWebAndMcp();

  let messages = toCloudMessages(opts.messages);
  // Dynamic (non-cached) reminder so the model actually uses web_search when available.
  if (tools.some((t) => t.function.name === "web_search")) {
    const hint =
      "You have a web_search tool for this turn. Use it for current events, news, prices, sports, documentation, travel, flights, or any factual question that needs up-to-date information before answering. " +
      "Follow-ups inherit the prior topic: if the user previously planned a Spain trip and now asks about flights, search for flights related to that Spain trip — never a bare query like \"flights\" alone. " +
      "Every web_search query must be self-contained (include place, product, dates, or other entities from the conversation).";
    const firstSystem = messages.findIndex((m) => m.role === "system");
    if (firstSystem >= 0) {
      messages = [
        ...messages.slice(0, firstSystem + 1),
        { role: "system", content: hint },
        ...messages.slice(firstSystem + 1),
      ];
    } else {
      messages = [{ role: "system", content: hint }, ...messages];
    }
  }

  let webSearchResult: WebSearchResult | null = null;
  const artifacts: ArtifactResult[] = [];
  let thinking = "";
  let lastContent = "";

  const hasWebSearch = tools.some((t) => t.function.name === "web_search");

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // When web search is enabled, force the first round to call web_search.
      // Models often answer from memory with tool_choice=auto and never hit /v1/search.
      const toolChoice =
        hasWebSearch && round === 0
          ? ({
              type: "function" as const,
              function: { name: "web_search" },
            })
          : ("auto" as const);

      // Don't stream intermediate tool-decision tokens to the chat bubble.
      const decision = await streamCloudRound(
        messages,
        tools,
        {
          ...opts,
          onThinking: (t) => {
            thinking += t;
            opts.onThinking(t);
          },
          onChunk: () => {
            /* suppress until final prose or no-tool answer */
          },
        },
        toolChoice
      );

      lastContent = decision.content;

      let toolCalls = decision.tool_calls ?? [];

      // Host-side guarantee: if the model still skipped tools on round 0, inject
      // a web_search grounded in conversation context (follow-ups included).
      if (hasWebSearch && round === 0 && toolCalls.length === 0) {
        const rawQ = lastUserQuery(messages);
        if (rawQ) {
          let q = rawQ;
          try {
            q = await resolveFollowUpSearchQuery({
              messages: opts.messages,
              userText: rawQ,
              modelId: opts.modelId,
              signal: opts.signal,
              containsFileContext: opts.containsFileContext,
              userConfirmedCloudContext: opts.userConfirmedCloudContext,
              contextSource: opts.contextSource,
            });
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") throw e;
          }
          toolCalls = [
            {
              id: `forced_web_search_${Date.now()}`,
              type: "function",
              function: {
                name: "web_search",
                arguments: JSON.stringify({
                  query: q,
                  profile:
                    opts.webDepth === "full" ? "research" : "news",
                }),
              },
            },
          ];
        } else if (decision.content.trim()) {
          opts.onChunk(decision.content);
          return {
            content: decision.content,
            thinking,
            webSearchResult,
            artifacts,
          };
        } else {
          break;
        }
      } else if (!toolCalls.length) {
        if (decision.content.trim()) {
          opts.onChunk(decision.content);
        }
        return {
          content: decision.content,
          thinking,
          webSearchResult,
          artifacts,
        };
      }

      // Append assistant tool_calls message
      messages = [
        ...messages,
        {
          role: "assistant",
          content: decision.content || null,
          tool_calls: toolCalls,
        },
      ];

      for (const call of toolCalls) {
        const executed = await executeToolCall(call, opts, webSearchResult);
        webSearchResult = executed.webSearchResult;
        if (executed.artifact) artifacts.push(executed.artifact);
        messages = [
          ...messages,
          {
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: executed.content,
          },
        ];
      }

      if (round + 1 < MAX_TOOL_ROUNDS) {
        const remaining = MAX_TOOL_ROUNDS - (round + 1);
        messages = [
          ...messages,
          {
            role: "user",
            content:
              `You have ~${remaining} tool rounds left. ` +
              "If you still need more web facts, call web_search again with a NEW query; otherwise answer in prose now.",
          },
        ];
      }
    }

    // Final prose turn without tools
    const finale = await new Promise<{ content: string }>((resolve, reject) => {
      let content = "";
      streamChatByMode({
        messages,
        intent: "quick_chat",
        containsFileContext: opts.containsFileContext ?? false,
        userConfirmedCloudContext: opts.userConfirmedCloudContext,
        contextSource: opts.contextSource,
        modelId: opts.modelId,
        signal: opts.signal,
        disableThinking: opts.disableThinking,
        disableLocalFallback: true,
        generationOptions: opts.generationOptions,
        onChunk: (chunk) => {
          content += chunk;
          opts.onChunk(chunk);
        },
        onThinking: (t) => {
          thinking += t;
          opts.onThinking(t);
        },
        onFinish: () => resolve({ content }),
        onError: reject,
      });
    });

    return {
      content: finale.content || lastContent,
      thinking,
      webSearchResult,
      artifacts,
    };
  } finally {
    opts.onToolStatus?.(null);
  }
}

/**
 * Cloud Smart/Deep artifact prelude: let the OpenRouter model call web_search
 * with its own concise queries (not the raw user prompt).
 * Returns merged search results for grounding; does not write the artifact.
 */
export async function runCloudArtifactWebResearch(opts: {
  artifactRequest: string;
  schemaId: string;
  webDepth?: "snippets" | "full";
  signal?: AbortSignal;
  onStatus?: (status: string | null) => void;
}): Promise<WebSearchResult | null> {
  const webDepth = opts.webDepth ?? "full";
  const kind =
    opts.schemaId === "presentation_synthesis"
      ? "presentation"
      : opts.schemaId === "spreadsheet_synthesis"
        ? "spreadsheet"
        : opts.schemaId === "html_synthesis"
          ? "webpage"
          : "artifact";

  const researchOpts: CloudNativeToolLoopOptions = {
    messages: [
      {
        role: "system",
        content:
          `You are researching facts to ground a ${kind} the user will generate next. ` +
          "Call web_search repeatedly with SHORT keyword queries covering DIFFERENT facets " +
          "(e.g. flights, destinations, day activities, seasons, transport). " +
          "Never paste the full user prompt as the query. Prefer depth=full when you need page text. " +
          `You may search up to ${MAX_TOOL_ROUNDS} times. After enough research, reply with a one-line acknowledgement — do not write the artifact.`,
      },
      {
        role: "user",
        content: `Research for this ${kind} request:\n${opts.artifactRequest.slice(0, 1500)}`,
      },
    ],
    webDepth,
    includeMcpTools: false,
    signal: opts.signal,
    disableThinking: true,
    generationOptions: {
      maxTokens: 256,
      temperature: 0.2,
    },
    onChunk: () => {
      /* research-only; discard acknowledgement */
    },
    onThinking: () => {},
    onToolStatus: opts.onStatus,
  };

  const tools = cloudToolsWebOnly();
  let messages = toCloudMessages(researchOpts.messages);
  messages = [
    messages[0]!,
    {
      role: "system",
      content:
        "You MUST call the web_search tool at least once with a concise keyword query before finishing.",
    },
    ...messages.slice(1),
  ];

  let webSearchResult: WebSearchResult | null = null;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const decision = await new Promise<{
        content: string;
        tool_calls?: CloudToolCall[];
      }>((resolve, reject) => {
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
          intent: "quick_chat",
          containsFileContext: false,
          signal: opts.signal,
          disableThinking: true,
          disableLocalFallback: true,
          tools,
          // Force a tool call on the first round so the OR model picks the query.
          tool_choice:
            round === 0
              ? { type: "function", function: { name: "web_search" } }
              : "auto",
          generationOptions: researchOpts.generationOptions,
          onChunk: (chunk) => {
            content += chunk;
          },
          onThinking: () => {},
          onFinish: (meta) => {
            settle(() =>
              resolve({ content, tool_calls: meta?.tool_calls })
            );
          },
          onError: (err) => settle(() => reject(err)),
        });
      });

      if (!decision.tool_calls?.length) {
        break;
      }

      messages = [
        ...messages,
        {
          role: "assistant",
          content: decision.content || null,
          tool_calls: decision.tool_calls,
        },
      ];

      for (const call of decision.tool_calls) {
        const executed = await executeToolCall(
          call,
          researchOpts,
          webSearchResult
        );
        webSearchResult = executed.webSearchResult;
        messages = [
          ...messages,
          {
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: executed.content,
          },
        ];
      }

      // Encourage multi-facet research until the model stops or hits the round cap.
      if (webSearchResult && round + 1 < MAX_TOOL_ROUNDS) {
        const remaining = MAX_TOOL_ROUNDS - (round + 1);
        messages = [
          ...messages,
          {
            role: "user",
            content:
              `You have ~${remaining} search rounds left. ` +
              "If important facets are still missing (flights, dates, places, hours, prices, nature spots, transfers), " +
              "call web_search again with a NEW focused query. " +
              "Otherwise reply briefly that research is done.",
          },
        ];
      }
    }
  } finally {
    opts.onStatus?.(null);
  }

  return webSearchResult;
}
