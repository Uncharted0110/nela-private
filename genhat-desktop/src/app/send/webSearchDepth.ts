/**
 * Map LLM `web_search` depth → existing NELA web research behaviors.
 *
 * Depths mirror `webResearchRouter` / facet budgets:
 *   - snippet  → tools path, quick factual (simple profile)
 *   - full     → tools path, page content (research profile)
 *   - standard → facet gather (standard budget)
 *   - deep     → facet gather (deep budget)
 */

import { Api } from "../../api";
import type { ChatContextMessage, WebSearchResult } from "../../types";
import { gatherFacetResearchContext } from "./facetPlanner";
import { mergeWebSearchResults } from "./webSearchToolLoop";

export type WebToolDepth = "snippet" | "full" | "standard" | "deep";

export function normalizeWebToolDepth(raw: unknown): WebToolDepth {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "snippet" || s === "snippets" || s === "quick") return "snippet";
  if (s === "deep") return "deep";
  if (s === "standard" || s === "thorough") return "standard";
  if (s === "full") return "full";
  // Sensible default when the model omits depth.
  return "full";
}

export async function runWebSearchWithDepth(opts: {
  query: string;
  depth: WebToolDepth;
  messages: ChatContextMessage[];
  modelId?: string | null;
  signal?: AbortSignal;
  containsFileContext?: boolean;
  userConfirmedCloudContext?: boolean;
  contextSource?: string;
  onToolStatus?: (status: string | null) => void;
  site?: string;
  timeRange?: "day" | "week" | "month" | "year";
}): Promise<WebSearchResult> {
  const { query, depth } = opts;

  if (depth === "snippet") {
    opts.onToolStatus?.(`Searching (snippet) “${query}”`);
    return Api.webSearch(query, 5, {
      profile: "simple",
      site: opts.site,
      timeRange: opts.timeRange,
    });
  }

  if (depth === "full") {
    opts.onToolStatus?.(`Searching (full) “${query}”`);
    return Api.webSearch(query, 8, {
      profile: "research",
      site: opts.site,
      timeRange: opts.timeRange,
    });
  }

  // standard / deep → existing facet gather (multi-query), no synthesis.
  opts.onToolStatus?.(
    depth === "deep" ? `Researching (deep) “${query}”` : `Researching “${query}”`
  );
  const gathered = await gatherFacetResearchContext({
    messages: opts.messages,
    userText: query,
    budget: depth === "deep" ? "deep" : "standard",
    modelId: opts.modelId,
    signal: opts.signal,
    containsFileContext: opts.containsFileContext,
    userConfirmedCloudContext: opts.userConfirmedCloudContext,
    contextSource: opts.contextSource,
    onToolStatus: opts.onToolStatus,
  });

  if (gathered && (gathered.results.length > 0 || gathered.formatted_context?.trim())) {
    return gathered;
  }

  // Fallback single research search if facet gather returned nothing.
  const fallback = await Api.webSearch(query, depth === "deep" ? 10 : 6, {
    profile: "research",
    site: opts.site,
    timeRange: opts.timeRange,
  });
  return gathered ? mergeWebSearchResults(gathered, fallback) : fallback;
}
