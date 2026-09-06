/**
 * Native OpenAI tools[] loop for NELA Cloud.
 * Executes web_search and MCP artifact tools on the desktop, then continues
 * the conversation with role:"tool" messages.
 */

import { Api } from "../../api";
import type {
  ChatContextMessage,
  CloudChatMessage,
  CloudFileParserPlugin,
  CloudToolCall,
  CloudToolDefinition,
  FileAnnotation,
  WebSearchResult,
  ArtifactResult,
} from "../../types";
import {
  formatCloudFallbackNotice,
  streamChatByMode,
  willRouteToCloud,
} from "./cloudOrLocalStream";
import { buildCloudChatTools } from "./cloudTools";
import { groundWebSearchQuery } from "./followUpSearchQuery";
import { mergeWebSearchResults, runWebSearchToolLoop } from "./webSearchToolLoop";
import { normalizeWebToolDepth, runWebSearchWithDepth } from "./webSearchDepth";
import { knowledgeBaseToSearchResult, fileUrlToPath, isLocalFileHitUrl } from "./fileSearchCitations";
import type { GenerationOptions } from "./types";
import {
  MAX_ARTIFACT_WEB_RESEARCH_ROUNDS,
  MAX_WEB_SEARCH_TOOL_ROUNDS,
} from "./webSearchLimits";
import { useModelStore } from "../../stores/modelStore";
import {
  ArtifactChartPool,
  embedPoolChartsInHtml,
  type ChartPoolEntry,
} from "../artifactChartPool";
import { normalizeSpreadsheetPlan } from "../spreadsheetPlan";
import { currentQuarter } from "../nelaSystemPrompt";
import type { AskFollowUpArgs } from "./askFollowUp";
import { beginAskFollowUpTurn } from "../../stores/followUpStore";
import { looksLikeEmailRequest } from "./gmailConnectIntent";
import { useGmailConnectPromptStore } from "../../stores/gmailConnectPromptStore";

const MAX_TOOL_ROUNDS = MAX_WEB_SEARCH_TOOL_ROUNDS;
const MAX_CHART_PREP_ROUNDS = 6;

export interface CloudNativeToolLoopOptions {
  messages: CloudChatMessage[] | ChatContextMessage[];
  webDepth: "snippets" | "full";
  /** When false, omit web_search / web_extract (file-search-only turns). Default true. */
  webEnabled?: boolean;
  /** Expose local Doc Graph `file_search` tool (Search my files / /files). */
  fileSearchEnabled?: boolean;
  plugins?: CloudFileParserPlugin[];
  /** Include MCP spreadsheet/presentation/html tools alongside web_search. */
  includeMcpTools?: boolean;
  /** Expose host render_chart tool (HTML/PPT dashboards). */
  chartEnabled?: boolean;
  /** Shared pool when chartEnabled — caller owns the instance. */
  chartPool?: ArtifactChartPool;
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
  /** Stable id so ask_followup is limited to once per user turn. */
  askFollowUpTurnId?: string;
};

export interface CloudNativeToolLoopResult {
  content: string;
  thinking: string;
  webSearchResult: WebSearchResult | null;
  artifacts: ArtifactResult[];
  /** OpenRouter / local model id from the last generation round. */
  model?: string;
  /** Post-request credit balance from the last cloud round. */
  creditsRemaining?: number;
  fileAnnotations?: FileAnnotation[];
}

function flattenMessageContent(content: CloudChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return content ?? "";
}

function toTextMessages(
  messages: Array<ChatContextMessage | CloudChatMessage>
): ChatContextMessage[] {
  return messages
    .filter(
      (m): m is ChatContextMessage | CloudChatMessage =>
        m.role === "system" || m.role === "user" || m.role === "assistant"
    )
    .map((m) => ({
      role: m.role as ChatContextMessage["role"],
      content: flattenMessageContent(m.content),
    }));
}

function toCloudMessages(
  messages: Array<ChatContextMessage | CloudChatMessage>
): CloudChatMessage[] {
  return messages.map((m) => ({
    role: m.role as CloudChatMessage["role"],
    content: m.content,
    name: (m as CloudChatMessage).name,
    tool_call_id: (m as CloudChatMessage).tool_call_id,
    tool_calls: (m as CloudChatMessage).tool_calls,
    annotations: (m as CloudChatMessage).annotations,
  }));
}

function streamCloudRound(
  messages: CloudChatMessage[],
  tools: CloudToolDefinition[],
  opts: CloudNativeToolLoopOptions,
  toolChoice: "auto" | "required" | { type: "function"; function: { name: string } } = "auto"
): Promise<{
  content: string;
  tool_calls?: CloudToolCall[];
  model?: string;
  creditsRemaining?: number;
  annotations?: FileAnnotation[];
}> {
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
      plugins: opts.plugins,
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
            model: meta?.model,
            creditsRemaining: meta?.creditsRemaining,
            annotations: meta?.annotations,
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
        messages: toTextMessages(opts.messages),
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
    const depth = normalizeWebToolDepth(args.depth ?? args.web_depth);
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
    try {
      const result = await runWebSearchWithDepth({
        query,
        depth,
        messages: toTextMessages(opts.messages),
        modelId: opts.modelId,
        signal: opts.signal,
        containsFileContext: opts.containsFileContext,
        userConfirmedCloudContext: opts.userConfirmedCloudContext,
        contextSource: opts.contextSource,
        onToolStatus: opts.onToolStatus,
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

  if (name === "search_knowledge_base" || name === "file_search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return {
        content: "search_knowledge_base requires a query",
        webSearchResult,
      };
    }
    const topKRaw = args.top_k ?? args.topK;
    const topK =
      typeof topKRaw === "number" && Number.isFinite(topKRaw)
        ? Math.max(1, Math.min(50, Math.floor(topKRaw)))
        : 25;
    opts.onToolStatus?.(`Searching knowledge base for “${query}”`);
    try {
      const md = await Api.queryKnowledgeBase(query, topK);
      opts.onToolStatus?.(null);
      if (!md.trim() || md === "No relevant structural context found.") {
        return {
          content: `No local documents matched query: ${query}`,
          webSearchResult,
        };
      }
      const asSearchResult = knowledgeBaseToSearchResult(query, md);
      const merged = asSearchResult
        ? mergeWebSearchResults(webSearchResult, asSearchResult)
        : webSearchResult;
      const citeLines = (merged?.results ?? [])
        .map((h, i) =>
          isLocalFileHitUrl(h.url)
            ? `[${i + 1}] ${h.title} — ${fileUrlToPath(h.url)}`
            : null
        )
        .filter(Boolean)
        .join("\n");
      const citeHint = citeLines
        ? `Cite these local sources with inline [n] markers from this list only:\n${citeLines}\n` +
          `Place [n] after the sentence period. Do NOT paste raw file paths or add a Sources list — citations render as clickable icons in the UI.`
        : `Mention file names in prose.`;
      return {
        content:
          `Local knowledge-graph results for "${query}" (top_k=${topK}):\n\n${md}\n\n` +
          `Use these expanded sources as the primary source of truth for local-file questions. ` +
          `${citeHint} Do not claim you cannot access the user's files.`,
        webSearchResult: merged,
      };
    } catch (e) {
      opts.onToolStatus?.(null);
      return {
        content: `search_knowledge_base failed: ${e}`,
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
      const artifact = await Api.generateSpreadsheet(
        normalizeSpreadsheetPlan(args as Record<string, unknown>, {
          prompt: "spreadsheet",
          hasSourceData: false,
        })
      );
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
      const pool = opts.chartPool?.list() ?? [];
      let html =
        typeof args.html === "string" && args.html.trim().length > 0
          ? args.html
          : null;
      if (html && pool.length) {
        html = embedPoolChartsInHtml(html, pool);
      }
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
      const pool = opts.chartPool?.list() ?? [];
      const payload = { ...(args as Record<string, unknown>) };
      if (
        pool.length &&
        typeof payload.html === "string" &&
        payload.html.trim()
      ) {
        payload.html = embedPoolChartsInHtml(payload.html, pool);
      }
      const artifact = await Api.generateHtml(payload as never);
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

  if (name === "render_chart") {
    const pool = opts.chartPool;
    if (!pool) {
      return {
        content: JSON.stringify({
          ok: false,
          error: "render_chart is not available in this turn",
        }),
        webSearchResult,
      };
    }
    opts.onToolStatus?.("Rendering chart…");
    const result = pool.render({
      chart_type: typeof args.chart_type === "string" ? args.chart_type : undefined,
      title: typeof args.title === "string" ? args.title : undefined,
      labels: args.labels,
      values: args.values,
      series: Array.isArray(args.series) ? args.series : undefined,
      theme: typeof args.theme === "string" ? args.theme : undefined,
    });
    opts.onToolStatus?.(null);
    return {
      content: JSON.stringify(result),
      webSearchResult,
    };
  }

  if (name === "ask_followup") {
    const { executeAskFollowUp } = await import("./askFollowUp");
    const result = await executeAskFollowUp(
      {
        reason: typeof args.reason === "string" ? args.reason : undefined,
        questions: Array.isArray(args.questions)
          ? (args.questions as AskFollowUpArgs["questions"])
          : undefined,
        allow_attachments: Boolean(args.allow_attachments),
      },
      {
        turnId: opts.askFollowUpTurnId,
        signal: opts.signal,
        onStatus: opts.onToolStatus,
      }
    );
    return {
      content: JSON.stringify(result),
      webSearchResult,
    };
  }

  if (name === "gmail_send") {
    const { executeGmailSend } = await import("./gmailSend");
    const result = await executeGmailSend(args, {
      signal: opts.signal,
      onStatus: opts.onToolStatus,
    });
    return {
      content: JSON.stringify(result),
      webSearchResult,
    };
  }

  if (name === "gmail_read") {
    const { executeGmailRead } = await import("./gmailRead");
    const result = await executeGmailRead(args, {
      signal: opts.signal,
      onStatus: opts.onToolStatus,
    });
    return {
      content: JSON.stringify(result),
      webSearchResult,
    };
  }

  return {
    content: `Unknown tool: ${name}`,
    webSearchResult,
  };
}

type ExecutedToolCall = {
  content: string;
  webSearchResult: WebSearchResult | null;
  artifact?: ArtifactResult;
};

/** Run a round of tool_calls in parallel, then merge citations in call order. */
async function executeToolCallsParallel(
  toolCalls: CloudToolCall[],
  opts: CloudNativeToolLoopOptions,
  webSearchResult: WebSearchResult | null
): Promise<{
  results: ExecutedToolCall[];
  webSearchResult: WebSearchResult | null;
  artifacts: ArtifactResult[];
}> {
  const kbCount = toolCalls.filter(
    (c) =>
      c.function.name === "search_knowledge_base" ||
      c.function.name === "file_search"
  ).length;
  if (kbCount > 1) {
    opts.onToolStatus?.(
      `Searching knowledge base (${kbCount} queries)`
    );
  }

  const results = await Promise.all(
    toolCalls.map((call) => executeToolCall(call, opts, null))
  );

  let merged = webSearchResult;
  const artifacts: ArtifactResult[] = [];
  for (const executed of results) {
    if (executed.webSearchResult) {
      merged = mergeWebSearchResults(merged, executed.webSearchResult);
    }
    if (executed.artifact) artifacts.push(executed.artifact);
  }
  opts.onToolStatus?.(null);
  return { results, webSearchResult: merged, artifacts };
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
      messages: toTextMessages(opts.messages),
      webDepth: opts.webDepth,
      webEnabled: opts.webEnabled !== false,
      fileSearchEnabled: Boolean(opts.fileSearchEnabled),
      modelId: opts.modelId,
      signal: opts.signal,
      disableThinking: opts.disableThinking,
      generationOptions: opts.generationOptions,
      onChunk,
      onThinking: opts.onThinking,
      onToolStatus: opts.onToolStatus,
    });
    return {
      content: notice ? `${notice}${local.content}` : local.content,
      thinking: local.thinking,
      webSearchResult: local.webSearchResult,
      artifacts: [] as ArtifactResult[],
      model:
        local.model ||
        opts.modelId?.trim() ||
        useModelStore.getState().selectedModel?.trim() ||
        undefined,
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
  const turnId = opts.askFollowUpTurnId ?? `cloud-tools-${Date.now()}`;
  beginAskFollowUpTurn(turnId);
  const loopOpts: CloudNativeToolLoopOptions = {
    ...opts,
    askFollowUpTurnId: turnId,
  };

  const webEnabled = loopOpts.webEnabled !== false;
  const fileSearchEnabled = Boolean(loopOpts.fileSearchEnabled);
  let gmailEnabled = false;
  try {
    gmailEnabled = Boolean((await Api.gmailStatus()).connected);
  } catch {
    gmailEnabled = false;
  }
  const tools = buildCloudChatTools({
    webEnabled,
    fileSearchEnabled,
    mcpEnabled: loopOpts.includeMcpTools !== false,
    chartEnabled: Boolean(loopOpts.chartEnabled),
    askFollowUpEnabled: true,
    gmailEnabled,
  });

  let messages = toCloudMessages(loopOpts.messages);
  // Dynamic (non-cached) reminder so the model actually uses available tools.
  const hasWebSearch = tools.some((t) => t.function.name === "web_search");
  const hasFileSearch = tools.some(
    (t) => t.function.name === "search_knowledge_base"
  );
  const hasRenderChart = tools.some((t) => t.function.name === "render_chart");
  const hasAskFollowUp = tools.some((t) => t.function.name === "ask_followup");
  const hasGmail = tools.some(
    (t) => t.function.name === "gmail_send" || t.function.name === "gmail_read"
  );
  if (hasWebSearch || hasFileSearch || hasRenderChart || hasAskFollowUp || hasGmail) {
    const parts: string[] = [];
    if (hasWebSearch) {
      parts.push(
        "You have a web_search tool. Call it ONLY when you need live web facts — never automatically. " +
          "Every call MUST include query and depth (snippet | full | standard | deep). " +
          "snippet = quick facts; full = richer page content; standard = multi-facet research; deep = exhaustive multi-facet research. " +
          `For anything time-sensitive, put the requested period in the query (e.g. "Q${currentQuarter()} ${new Date().getFullYear()}") and set time_range to keep results recent; ` +
          "if the first results are from an older year than requested, search again with the explicit period before concluding the data does not exist. " +
          "Follow-ups inherit the prior topic. Cite web results with inline [n] markers only (no raw URLs)."
      );
    }
    if (hasFileSearch) {
      parts.push(
        "You have a search_knowledge_base tool for the user's local indexed document graph. " +
          "Call it ONLY when the user clearly needs their own files/notes/PDFs/slides — never for general web topics (travel, news, public facts). " +
          "Prefer higher top_k (25–40) so graph retrieval can surface related chunks; use 10–15 only for pinpoint lookups. " +
          "For multiple facets, emit several search_knowledge_base tool calls in the same turn — they run in parallel. " +
          "Cite local sources with inline [n] markers only (no raw file paths or Sources list)."
      );
    }
    if (hasRenderChart) {
      parts.push(
        "You have a render_chart tool for dashboards and plots. Call it with chart_type (bar|pie|line|timeline|dual_line|grouped_bar), title, labels[], and values[] — mix types, not all bars. For dual_line/grouped_bar also pass series[]. " +
          "never invent Chart.js or hand-written echarts.init. Embed the returned nela-chart:N token in HTML as " +
          '<div data-nela-chart="nela-chart:N"></div>.'
      );
    }
    if (hasAskFollowUp) {
      parts.push(
        "You have ask_followup for a sparse popup when required facts are missing (numbers, files, ambiguous target). " +
          "Use at most once per turn; never for chit-chat; never invent missing data."
      );
    }
    if (hasGmail) {
      parts.push(
        "You can send email with gmail_send (to, subject, body; optional cc/bcc). " +
          "Put every To address in `to` (array or comma-separated). Use cc/bcc when asked. " +
          "The user will confirm the draft in the app before anything is sent. " +
          "Never claim an email was sent until the tool result has sent=true. " +
          "If they cancel, say it was not sent. " +
          "Do not add a NELA logo or “sent using nela” line — NELA appends that footer. " +
          "You can read mail with gmail_read (optional max_results 1–5, query, purpose). " +
          "For “latest email / summarize my email”, call gmail_read with max_results=1. " +
          "The user must Allow once before any message is fetched. " +
          "Summarize only from the tool result; never invent inbox contents. " +
          "If needsReauth or ok=false, ask them to Disconnect and Connect Gmail again for read access."
      );
    } else {
      const lastUser = [...messages]
        .reverse()
        .find((m) => m.role === "user");
      const lastUserText = lastUser
        ? flattenMessageContent(lastUser.content)
        : "";
      if (looksLikeEmailRequest(lastUserText)) {
        useGmailConnectPromptStore.getState().show();
        parts.push(
          "Gmail is not connected. Tell the user to tap Connect Gmail on the card in chat " +
            "(or Settings → Connections). Never claim mail was sent or read."
        );
      }
    }
    const hint = parts.join(" ");
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
  let lastModel: string | undefined;
  let lastCreditsRemaining: number | undefined;
  let lastAnnotations: FileAnnotation[] | undefined;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Never force tools — only run when the model emits tool_calls.
      const toolChoice = "auto" as const;

      // Don't stream intermediate tool-decision tokens to the chat bubble.
      const decision = await streamCloudRound(
        messages,
        tools,
        {
          ...loopOpts,
          onThinking: (t) => {
            thinking += t;
            loopOpts.onThinking(t);
          },
          onChunk: () => {
            /* suppress until final prose or no-tool answer */
          },
        },
        toolChoice
      );

      lastContent = decision.content;
      if (decision.model?.trim()) lastModel = decision.model.trim();
      if (typeof decision.creditsRemaining === "number") {
        lastCreditsRemaining = decision.creditsRemaining;
      }
      if (decision.annotations?.length) {
        lastAnnotations = decision.annotations;
      }

      const toolCalls = decision.tool_calls ?? [];

      if (!toolCalls.length) {
        if (decision.content.trim()) {
          loopOpts.onChunk(decision.content);
        }
        return {
          content: decision.content,
          thinking,
          webSearchResult,
          artifacts,
          model: lastModel,
          creditsRemaining: lastCreditsRemaining,
          fileAnnotations: lastAnnotations,
        };
      }

      // Append assistant tool_calls message
      messages = [
        ...messages,
        {
          role: "assistant",
          content: decision.content || null,
          tool_calls: toolCalls,
          ...(decision.annotations?.length
            ? { annotations: decision.annotations }
            : {}),
        },
      ];

      {
        const batch = await executeToolCallsParallel(
          toolCalls,
          loopOpts,
          webSearchResult
        );
        webSearchResult = batch.webSearchResult;
        artifacts.push(...batch.artifacts);
        messages = [
          ...messages,
          ...toolCalls.map((call, i) => ({
            role: "tool" as const,
            tool_call_id: call.id,
            name: call.function.name,
            content: batch.results[i]!.content,
          })),
        ];
      }

      if (round + 1 < MAX_TOOL_ROUNDS) {
        const remaining = MAX_TOOL_ROUNDS - (round + 1);
        const nextHintParts: string[] = [
          `You have ~${remaining} tool rounds left.`,
        ];
        if (hasWebSearch) {
          nextHintParts.push(
            "If you still need more web facts, call web_search again with a NEW query and an explicit depth (snippet|full|standard|deep)."
          );
        }
        if (hasFileSearch) {
          nextHintParts.push(
            "Only if you still need local-file context the user asked about, call search_knowledge_base (multiple parallel calls OK) with refined queries."
          );
        }
        nextHintParts.push(
          "Otherwise answer in prose with inline [n] citations only (no raw URLs/paths or Sources list)."
        );
        messages = [
          ...messages,
          {
            role: "user",
            content: nextHintParts.join(" "),
          },
        ];
      }
    }

    // Final prose turn without tools
    const finale = await new Promise<{
      content: string;
      model?: string;
      creditsRemaining?: number;
      annotations?: FileAnnotation[];
    }>((resolve, reject) => {
        let content = "";
        streamChatByMode({
          messages,
          intent: "quick_chat",
          containsFileContext: loopOpts.containsFileContext ?? false,
          userConfirmedCloudContext: loopOpts.userConfirmedCloudContext,
          contextSource: loopOpts.contextSource,
          plugins: loopOpts.plugins,
          modelId: loopOpts.modelId,
          signal: loopOpts.signal,
          disableThinking: loopOpts.disableThinking,
          disableLocalFallback: true,
          generationOptions: loopOpts.generationOptions,
          onChunk: (chunk) => {
            content += chunk;
            loopOpts.onChunk(chunk);
          },
          onThinking: (t) => {
            thinking += t;
            loopOpts.onThinking(t);
          },
          onFinish: (meta) =>
            resolve({
              content,
              model: meta?.model,
              creditsRemaining: meta?.creditsRemaining,
              annotations: meta?.annotations,
            }),
          onError: reject,
        });
      }
    );
    if (finale.model?.trim()) lastModel = finale.model.trim();
    if (typeof finale.creditsRemaining === "number") {
      lastCreditsRemaining = finale.creditsRemaining;
    }
    if (finale.annotations?.length) {
      lastAnnotations = finale.annotations;
    }

    return {
      content: finale.content || lastContent,
      thinking,
      webSearchResult,
      artifacts,
      model: lastModel,
      creditsRemaining: lastCreditsRemaining,
      fileAnnotations: lastAnnotations,
    };
  } finally {
    loopOpts.onToolStatus?.(null);
  }
}

/**
 * Cloud Smart/Deep artifact prelude: let the OpenRouter model call web_search
 * (and optionally search_knowledge_base) with its own concise queries.
 * Returns merged search results for grounding; does not write the artifact.
 */
export async function runCloudArtifactWebResearch(opts: {
  artifactRequest: string;
  schemaId: string;
  webDepth?: "snippets" | "full";
  /** When true, expose local Doc Graph search alongside web_search. */
  fileSearchEnabled?: boolean;
  /** Filenames already on this turn — do not search the local library for them. */
  attachedFileNames?: string[];
  /** Recent chat content the model should assess for relevance. */
  priorContent?: string;
  signal?: AbortSignal;
  onStatus?: (status: string | null) => void;
}): Promise<WebSearchResult | null> {
  const webDepth = opts.webDepth ?? "snippets";
  const priorContent = opts.priorContent?.trim() ?? "";
  const attachedNames = (opts.attachedFileNames ?? []).filter(Boolean);
  const fileSearchEnabled =
    Boolean(opts.fileSearchEnabled) && attachedNames.length === 0;
  const kind =
    opts.schemaId === "presentation_synthesis"
      ? "presentation"
      : opts.schemaId === "spreadsheet_synthesis"
        ? "spreadsheet"
        : opts.schemaId === "html_synthesis"
          ? "webpage"
          : "artifact";

  const localHint = fileSearchEnabled
    ? " You may optionally call search_knowledge_base with SHORT keyword queries if (and only if) the request clearly needs the user's indexed local files. Do not search local files for general travel / web topics. "
    : attachedNames.length > 0
      ? ` The user already attached: ${attachedNames.join(", ")}. Those files will be loaded for the artifact. Do not call search_knowledge_base. Only web-search for public facts missing from the attachments. `
      : " ";

  const researchOpts: CloudNativeToolLoopOptions = {
    messages: [
      {
        role: "system",
        content:
          `You are researching facts to ground a ${kind} the user will generate next. ` +
          "Call web_search repeatedly with SHORT keyword queries covering DIFFERENT facets " +
          "(e.g. flights, destinations, day activities, seasons, transport)." +
          localHint +
          "Never paste the full user prompt as the query. Prefer depth=snippet (fast). " +
          "Call web_extract only for 1–3 URLs that need full page text. " +
          `You may search up to ${MAX_ARTIFACT_WEB_RESEARCH_ROUNDS} times. After enough research, reply with a one-line acknowledgement — do not write the artifact.`,
      },
      {
        role: "user",
        content:
          (priorContent
            ? `Candidate context from the recent chat:\n${priorContent.slice(0, 4000)}\n\n` +
              `Decide whether the current artifact request depends on that context. If relevant and complete, do not search for the same facts again. If unrelated or additional live facts are needed, ignore/use it as appropriate and search normally.\n\n`
            : "") +
          `Research for this ${kind} request:\n${opts.artifactRequest.slice(0, 1500)}`,
      },
    ],
    webDepth,
    webEnabled: true,
    fileSearchEnabled,
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

  // No ask_followup here: this is a background grounding pass, and a popup
  // mid-generation is exactly the interruption the tool is meant to avoid.
  const tools = buildCloudChatTools({
    webEnabled: true,
    fileSearchEnabled,
    mcpEnabled: false,
    askFollowUpEnabled: false,
  });
  let messages = toCloudMessages(researchOpts.messages);
  const mustCallHint =
    "Call the web_search tool with concise keyword queries and depth (snippet|full|standard|deep) when you need live web facts. " +
    (fileSearchEnabled
      ? "Call search_knowledge_base only when the user clearly needs their local indexed files — never for general travel/web research. "
      : "") +
    "Do not invent tool results.";
  messages = [
    messages[0]!,
    {
      role: "system",
      content: mustCallHint,
    },
    ...messages.slice(1),
  ];

  let webSearchResult: WebSearchResult | null = null;

  try {
    for (let round = 0; round < MAX_ARTIFACT_WEB_RESEARCH_ROUNDS; round++) {
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
          // Auto only — never force web_search or search_knowledge_base.
          tool_choice: "auto",
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

      {
        const batch = await executeToolCallsParallel(
          decision.tool_calls,
          researchOpts,
          webSearchResult
        );
        webSearchResult = batch.webSearchResult;
        messages = [
          ...messages,
          ...decision.tool_calls.map((call, i) => ({
            role: "tool" as const,
            tool_call_id: call.id,
            name: call.function.name,
            content: batch.results[i]!.content,
          })),
        ];
      }

      // Encourage multi-facet research until the model stops or hits the round cap.
      if (webSearchResult && round + 1 < MAX_ARTIFACT_WEB_RESEARCH_ROUNDS) {
        const remaining = MAX_ARTIFACT_WEB_RESEARCH_ROUNDS - (round + 1);
        const localRoundHint = fileSearchEnabled
          ? " Call search_knowledge_base (parallel calls OK) only if a local-file facet is clearly needed."
          : "";
        messages = [
          ...messages,
          {
            role: "user",
            content:
              `You have ~${remaining} search rounds left. ` +
              "If important facets are still missing (flights, dates, places, hours, prices, nature spots, transfers), " +
              "call web_search again with a NEW focused query (depth=snippet)." +
              localRoundHint +
              " Otherwise reply briefly that research is done.",
          },
        ];
      }
    }
  } finally {
    opts.onStatus?.(null);
  }

  return webSearchResult;
}

/**
 * Pre-stream prep: model calls render_chart with data; host builds fragments.
 * Returns the pool for catalog injection + post-save embedding.
 */
export async function runCloudArtifactChartPrep(opts: {
  artifactRequest: string;
  schemaId: string;
  /** Optional spreadsheet / research context the model may chart. */
  dataContext?: string;
  signal?: AbortSignal;
  onStatus?: (status: string | null) => void;
}): Promise<ChartPoolEntry[]> {
  const pool = new ArtifactChartPool(4);
  const kind =
    opts.schemaId === "presentation_synthesis"
      ? "presentation"
      : opts.schemaId === "html_synthesis"
        ? "webpage"
        : "artifact";

  const dataBlock = opts.dataContext?.trim()
    ? `\n\nData you may chart (use real numbers only):\n${opts.dataContext.trim().slice(0, 6000)}`
    : "";

  const prepOpts: CloudNativeToolLoopOptions = {
    messages: [
      {
        role: "system",
        content:
          `You prepare charts for a ${kind} the user will generate next. ` +
          "Call render_chart once per plot (max 4) with mixed chart_type (bar, pie, line, timeline, dual_line, grouped_bar), title, labels[], and values[]. " +
          "Do not make every chart a bar. For dual_line or grouped_bar pass series: [{name, values}, ...]. " +
          "Use only numbers from the user request or the supplied data context — do not invent live APIs. " +
          "After charts are registered, reply with a one-line acknowledgement — do not write the artifact HTML.",
      },
      {
        role: "system",
        content:
          "You MUST call render_chart at least once when the request needs a chart, dashboard, plot, or stats visualization. " +
          "Each call needs chart_type, title, labels (string array), and values (number array).",
      },
      {
        role: "user",
        content:
          `Prepare charts for this ${kind} request:\n${opts.artifactRequest.slice(0, 1500)}` +
          dataBlock,
      },
    ],
    webDepth: "snippets",
    webEnabled: false,
    fileSearchEnabled: false,
    includeMcpTools: false,
    chartEnabled: true,
    chartPool: pool,
    signal: opts.signal,
    disableThinking: true,
    generationOptions: {
      // Tool-call args include labels[]/values[] — 256 truncates and yields an empty pool.
      maxTokens: 4096,
      temperature: 0.2,
    },
    onChunk: () => {},
    onThinking: () => {},
    onToolStatus: opts.onStatus,
  };

  const tools = buildCloudChatTools({
    webEnabled: false,
    fileSearchEnabled: false,
    mcpEnabled: false,
    chartEnabled: true,
  });

  let messages = toCloudMessages(prepOpts.messages);

  try {
    for (let round = 0; round < MAX_CHART_PREP_ROUNDS; round++) {
      if (pool.length >= pool.maxCharts) break;

      const decision = await streamCloudRound(
        messages,
        tools,
        prepOpts,
        round === 0 && pool.length === 0
          ? { type: "function", function: { name: "render_chart" } }
          : "auto"
      );

      if (!decision.tool_calls?.length) break;

      messages = [
        ...messages,
        {
          role: "assistant",
          content: decision.content || null,
          tool_calls: decision.tool_calls,
        },
      ];

      {
        const batch = await executeToolCallsParallel(
          decision.tool_calls,
          prepOpts,
          null
        );
        messages = [
          ...messages,
          ...decision.tool_calls.map((call, i) => ({
            role: "tool" as const,
            tool_call_id: call.id,
            name: call.function.name,
            content: batch.results[i]!.content,
          })),
        ];
      }

      if (pool.length > 0 && round + 1 < MAX_CHART_PREP_ROUNDS) {
        const remaining = pool.maxCharts - pool.length;
        if (remaining <= 0) break;
        messages = [
          ...messages,
          {
            role: "user",
            content:
              `You can register ${remaining} more chart(s). ` +
              "If another distinct plot would help, call render_chart again with different data. " +
              "Otherwise reply briefly that charts are ready.",
          },
        ];
      }
    }
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      throw err;
    }
    console.warn("Chart prep loop failed:", err);
  } finally {
    opts.onStatus?.(null);
  }

  return pool.list();
}
