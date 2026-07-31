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
import { mergeWebSearchResults, runWebSearchToolLoop } from "./webSearchToolLoop";
import type { GenerationOptions } from "./types";

const MAX_TOOL_ROUNDS = 2;

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

function streamCloudRound(
  messages: CloudChatMessage[],
  tools: CloudToolDefinition[],
  opts: CloudNativeToolLoopOptions
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
      tool_choice: "auto",
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
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { content: "web_search requires a query", webSearchResult };
    }
    const depth =
      args.depth === "full" || args.depth === "snippets"
        ? args.depth
        : opts.webDepth;
    const fetchContent = depth === "full";
    const maxResults = fetchContent ? 4 : 5;
    opts.onToolStatus?.(`Searching “${query}”`);
    try {
      const result = await Api.webSearch(query, maxResults, fetchContent);
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
      "You have a web_search tool for this turn. Use it for current events, news, prices, sports, documentation, or any factual question that needs up-to-date information before answering.";
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

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Don't stream intermediate tool-decision tokens to the chat bubble.
      const decision = await streamCloudRound(messages, tools, {
        ...opts,
        onThinking: (t) => {
          thinking += t;
          opts.onThinking(t);
        },
        onChunk: () => {
          /* suppress until final prose or no-tool answer */
        },
      });

      lastContent = decision.content;

      if (!decision.tool_calls?.length) {
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
          tool_calls: decision.tool_calls,
        },
      ];

      for (const call of decision.tool_calls) {
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
