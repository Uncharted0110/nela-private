/**
 * Facet planner — LLM-orchestrated research loop.
 *
 * Our own model (cloud or local) decides WHAT kinds of information a query
 * needs (facets), Tavily provides the information, and our model writes the
 * final answer structured by those facets. Used for:
 *   - composite queries ("itinerary for Spain for 1 week", "pick a laptop for ML")
 *   - the Deep Research web mode (bigger budget, same machinery)
 *
 * Tavily never authors user-facing text; it only retrieves.
 */

import { Api } from "../../api";
import type { ChatContextMessage, WebSearchResult } from "../../types";
import { streamChatByMode } from "./cloudOrLocalStream";
import {
  formatConversationForSearchContext,
  resolveFollowUpSearchQuery,
} from "./followUpSearchQuery";
import { mergeWebSearchResults } from "./webSearchToolLoop";
import type { GenerationOptions } from "./types";

export interface FacetPlan {
  facets: PlannedFacet[];
}

export interface PlannedFacet {
  name: string;
  query: string;
  profile: "simple" | "news" | "research";
}

export interface FacetResearchOptions {
  /** Full prepared conversation (system identity + history + user turn). */
  messages: ChatContextMessage[];
  /** The raw user message that triggered research. */
  userText: string;
  /** "standard" for composite chat queries, "deep" for Deep Research mode. */
  budget: "standard" | "deep";
  containsFileContext?: boolean;
  userConfirmedCloudContext?: boolean;
  contextSource?: string;
  modelId?: string | null;
  signal?: AbortSignal;
  disableThinking?: boolean;
  generationOptions?: GenerationOptions;
  onChunk: (chunk: string) => void;
  onThinking: (thinking: string) => void;
  onToolStatus?: (status: string | null) => void;
}

export interface FacetResearchResult {
  content: string;
  thinking: string;
  webSearchResult: WebSearchResult | null;
}

/** Max chars of merged web context fed into the synthesis turn. */
const SYNTHESIS_CONTEXT_CHAR_LIMIT = 24_000;

// ── Composite intent detection ────────────────────────────────────────────────

const COMPOSITE_PATTERNS: RegExp[] = [
  // Travel planning (typo-tolerant itinerary)
  /\b(itinerar\w*|iten[ae]r\w*|itinery)\b/i,
  /\b(plan|planning)\b.{0,30}\b(trip|travel|vacation|holiday|visit|weekend)\b/i,
  /\b(trip|travel|vacation|holiday)\b.{0,30}\b(plan|planning|guide)\b/i,
  // Decision / purchase support
  /\bhelp me (pick|choose|decide|select|find)\b/i,
  /\b(best|which|what)\b.{0,40}\b(should i|for me|to buy|to choose)\b/i,
  // Multi-facet research asks
  /\b(deep|comprehensive|detailed|complete|full)\b.{0,20}\b(research|report|analysis|overview|guide|breakdown)\b/i,
  /\bcompare\b.{0,60}\b(and|vs\.?|versus|or)\b/i,
  /\bpros and cons\b/i,
];

/**
 * Heuristic: does this query need multiple kinds of information?
 * The Deep Research toggle bypasses this and always plans facets.
 */
export function isCompositeQuery(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  return COMPOSITE_PATTERNS.some((re) => re.test(t));
}

// ── LLM plumbing ──────────────────────────────────────────────────────────────

function completeByMode(
  messages: ChatContextMessage[],
  opts: FacetResearchOptions,
  overrides?: { maxTokens?: number; temperature?: number; json?: boolean }
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
      ...(overrides?.json ? { response_format: { type: "json_object" as const } } : {}),
      generationOptions: {
        maxTokens: overrides?.maxTokens ?? 600,
        temperature: overrides?.temperature ?? 0.2,
      },
      onChunk: (chunk) => {
        content += chunk;
      },
      onThinking: () => {},
      onFinish: () => settle(() => resolve(content)),
      onError: (err) => settle(() => reject(err)),
    });
  });
}

// ── Step 1: plan facets ───────────────────────────────────────────────────────

const PLANNER_SYSTEM = `You are a research planner. Decompose the user's request into the distinct kinds of information (facets) a complete answer must cover.

Reply with ONLY JSON (no markdown fences, no other text):
{"facets":[{"name":"short facet label","query":"focused web search query","profile":"simple"}]}

Rules:
- 2 to 6 facets. Each facet has ONE short keyword query (not a sentence, not the full request).
- "profile" per facet: "news" for time-sensitive info (events, prices right now); "research" for facets needing depth (guides, itineraries, comparisons, reviews); "simple" for quick facts.
- Facets must match what the user actually needs. Examples:
  - travel itinerary -> flights, where to stay, places to visit, food, local transport
  - product decision -> requirements, top candidates, comparisons/benchmarks, prices
  - market/company research -> overview, recent news, competitors, financials
- Treat short follow-ups as continuing the prior topic (e.g. after a Spain itinerary, "possible flights" → facets/queries about flights for that Spain trip).
- Use the conversation for context (destination, dates, constraints already mentioned).
- Queries must be self-contained (include the place/product/topic name from prior turns when the latest message omits them).`;

function recentConversationSnippet(
  messages: ChatContextMessage[],
  maxTurns = 6
): string {
  return formatConversationForSearchContext(messages, maxTurns);
}

function parseFacetPlan(text: string, maxFacets: number): FacetPlan | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace?.[0]) candidates.push(brace[0]);

  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const list = obj.facets;
      if (!Array.isArray(list)) continue;
      const facets: PlannedFacet[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const f = item as Record<string, unknown>;
        const name = typeof f.name === "string" ? f.name.trim() : "";
        const query = typeof f.query === "string" ? f.query.trim() : "";
        if (!name || !query) continue;
        const profile =
          f.profile === "news" || f.profile === "simple"
            ? f.profile
            : "research";
        facets.push({
          name: name.slice(0, 60),
          query: query.slice(0, 200),
          profile,
        });
        if (facets.length >= maxFacets) break;
      }
      if (facets.length >= 1) return { facets };
    } catch {
      // next candidate
    }
  }
  return null;
}

async function planFacets(opts: FacetResearchOptions): Promise<FacetPlan> {
  const maxFacets = opts.budget === "deep" ? 6 : 4;
  opts.onToolStatus?.("Planning research…");

  const researchRequest = await resolveFollowUpSearchQuery({
    messages: opts.messages,
    userText: opts.userText,
    modelId: opts.modelId,
    signal: opts.signal,
    containsFileContext: opts.containsFileContext,
    userConfirmedCloudContext: opts.userConfirmedCloudContext,
    contextSource: opts.contextSource,
  });

  const planMessages: ChatContextMessage[] = [
    { role: "system", content: PLANNER_SYSTEM },
    {
      role: "user",
      content:
        `Conversation so far:\n${recentConversationSnippet(opts.messages)}\n\n` +
        `Latest user message:\n${opts.userText.slice(0, 1000)}\n\n` +
        `Resolved research request (use this — it includes follow-up context):\n${researchRequest}`,
    },
  ];

  try {
    const raw = await completeByMode(planMessages, opts, {
      maxTokens: 500,
      temperature: 0.2,
      json: true,
    });
    const plan = parseFacetPlan(raw, maxFacets);
    if (plan) return plan;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    console.warn("[facetPlanner] Planning turn failed, using fallback:", e);
  }

  // Fallback: single research facet over the context-resolved request.
  return {
    facets: [
      {
        name: "overview",
        query: researchRequest.slice(0, 200),
        profile: "research",
      },
    ],
  };
}

// ── Step 2: gather (parallel, bounded, soft-fail) ─────────────────────────────

const GATHER_CONCURRENCY = 3;

async function gatherFacets(
  plan: FacetPlan,
  opts: FacetResearchOptions
): Promise<{ webSearchResult: WebSearchResult | null; covered: Set<string> }> {
  let webSearchResult: WebSearchResult | null = null;
  const covered = new Set<string>();
  const maxResults = opts.budget === "deep" ? 8 : 5;

  const queue = [...plan.facets];
  const runOne = async (facet: PlannedFacet): Promise<void> => {
    if (opts.signal?.aborted) return;
    opts.onToolStatus?.(`Researching ${facet.name}: “${facet.query}”`);
    try {
      const result = await Api.webSearch(facet.query, maxResults, {
        profile: facet.profile,
      });
      if (result.results.length > 0 || result.formatted_context?.trim()) {
        webSearchResult = mergeWebSearchResults(webSearchResult, result);
        covered.add(facet.name);
      }
    } catch (e) {
      // Soft-fail: one facet failing never sinks the answer.
      console.warn(`[facetPlanner] Facet "${facet.name}" search failed:`, e);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(GATHER_CONCURRENCY, queue.length); i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const facet = queue.shift();
          if (!facet) break;
          await runOne(facet);
        }
      })()
    );
  }
  await Promise.all(workers);

  return { webSearchResult, covered };
}

/**
 * Plan + gather only (no synthesis). Used when the LLM calls `web_search`
 * with depth=standard|deep so tool results can continue in the tool loop.
 */
export async function gatherFacetResearchContext(
  opts: Omit<FacetResearchOptions, "onChunk" | "onThinking" | "generationOptions" | "disableThinking">
): Promise<WebSearchResult | null> {
  const plan = await planFacets({
    ...opts,
    onChunk: () => {},
    onThinking: () => {},
    disableThinking: true,
  });
  const { webSearchResult } = await gatherFacets(
    plan,
    {
      ...opts,
      onChunk: () => {},
      onThinking: () => {},
      disableThinking: true,
    }
  );
  return webSearchResult;
}

// ── Step 3: synthesize (our LLM writes the answer) ────────────────────────────

function buildSynthesisBrief(
  plan: FacetPlan,
  webSearchResult: WebSearchResult | null
): string {
  const facetList = plan.facets.map((f) => `- ${f.name}`).join("\n");

  let context = webSearchResult?.formatted_context?.trim() ?? "";
  if (context.length > SYNTHESIS_CONTEXT_CHAR_LIMIT) {
    context =
      context.slice(0, SYNTHESIS_CONTEXT_CHAR_LIMIT) +
      "\n\n[...web excerpts truncated for context limit]\n--- End of web sources ---\n";
  }

  return (
    `RESEARCH BRIEF — the answer MUST cover these facets, organized as clear sections:\n${facetList}\n\n` +
    `Rules for the answer:\n` +
    `- Structure the response by the facets above (natural headings, adapt wording).\n` +
    `- Embed helpful images with markdown ![description](url) — use ONLY image URLs that appear in the web sources below.\n` +
    `- Cite sources inline as [n] matching the numbered web sources, placed AFTER the sentence period (e.g. "…in Madrid.[1]" not "…in Madrid[1]."). Do NOT add a Sources list or bibliography at the end — citations are shown as icons in the UI.\n` +
    `- If a facet has little or no data in the sources, cover it briefly from general knowledge WITHOUT mentioning missing data, failed searches, or tools.\n` +
    `- Never mention this brief, tools, or the research process. Write directly to the user.\n` +
    `- If this is a follow-up, answer that follow-up in continuity with the prior conversation (same trip, product, or topic) — do not restart as a brand-new unrelated report.\n\n` +
    (context ? `${context}` : "No web sources were retrieved. Answer from general knowledge.")
  );
}

/**
 * Run the full facet research loop and stream the final answer via onChunk.
 */
export async function runFacetResearchLoop(
  opts: FacetResearchOptions
): Promise<FacetResearchResult> {
  const plan = await planFacets(opts);

  const facetNames = plan.facets.map((f) => f.name).join(", ");
  opts.onToolStatus?.(`Researching: ${facetNames}`);

  const { webSearchResult } = await gatherFacets(plan, opts);

  opts.onToolStatus?.("Writing your answer…");

  // Insert the research brief right before the final user turn so the model
  // reads it as part of the current request.
  const brief = buildSynthesisBrief(plan, webSearchResult);
  const synthesisMessages: ChatContextMessage[] = [...opts.messages];
  let inserted = false;
  for (let i = synthesisMessages.length - 1; i >= 0; i--) {
    if (synthesisMessages[i]!.role === "user") {
      synthesisMessages.splice(i, 0, { role: "system", content: brief });
      inserted = true;
      break;
    }
  }
  if (!inserted) synthesisMessages.push({ role: "system", content: brief });

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

    streamChatByMode({
      messages: synthesisMessages,
      intent: "quick_chat",
      containsFileContext: opts.containsFileContext ?? false,
      userConfirmedCloudContext: opts.userConfirmedCloudContext,
      contextSource: opts.contextSource,
      modelId: opts.modelId,
      signal: opts.signal,
      disableThinking: opts.disableThinking,
      generationOptions: opts.generationOptions,
      onChunk: (chunk) => {
        content += chunk;
        opts.onChunk(chunk);
      },
      onThinking: (t) => {
        thinking += t;
        opts.onThinking(t);
      },
      onFinish: () => {
        opts.onToolStatus?.(null);
        settle(() => resolve({ content, thinking, webSearchResult }));
      },
      onError: (err) => settle(() => reject(err)),
    });
  });
}
