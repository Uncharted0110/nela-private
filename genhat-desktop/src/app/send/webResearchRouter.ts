/**
 * Auto-route web research depth from the user message + chat history.
 * Replaces the manual Quick / Thorough / Deep picker.
 */

import type { ChatContextMessage } from "../../types";
import { isCompositeQuery } from "./facetPlanner";
import { looksLikeWebFollowUp } from "./followUpSearchQuery";

export type WebResearchRoute =
  | { mode: "facets"; budget: "standard" | "deep" }
  | { mode: "tools"; depth: "snippets" | "full" };

const DEEP_RESEARCH_PATTERNS: RegExp[] = [
  /\b(deep|comprehensive|detailed|complete|full|exhaustive)\b.{0,24}\b(research|report|analysis|overview|guide|breakdown|dive)\b/i,
  /\b(deep\s*dive|white\s*paper|literature\s*review)\b/i,
  /\b(in[- ]depth|thorough)\b.{0,20}\b(research|analysis|report|study)\b/i,
];

const SNIPPET_FACTUAL =
  /^(who|what|when|where|which|how much|how many|is|are|was|were|did|does|do)\b/i;

const SNIPPET_TOPIC =
  /\b(score|price|weather|stock|ticker|ceo|capital|population|date|born|founded|won|winner|result|headline)\b/i;

const PLANNING_VERBS =
  /\b(plan|planning|itinerary|compare|research|analyze|analyse|breakdown|recommend|decide|choose|pick)\b/i;

const SUBSTANCE_HINTS =
  /\b(how|why|explain|guide|tutorial|best|vs\.?|versus|compare|difference|works?|implement|setup|configure)\b/i;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function priorWasComposite(messages: ChatContextMessage[]): boolean {
  return messages.some(
    (m) => m.role === "user" && isCompositeQuery(m.content ?? "")
  );
}

function isDeepResearchAsk(text: string): boolean {
  const t = text.trim();
  if (DEEP_RESEARCH_PATTERNS.some((re) => re.test(t))) return true;
  // Long multi-constraint planning: many clauses / requirements.
  if (t.length >= 220 && PLANNING_VERBS.test(t) && (t.match(/,/g)?.length ?? 0) >= 3) {
    return true;
  }
  if (t.length >= 280 && isCompositeQuery(t)) return true;
  return false;
}

function isSnippetLookup(text: string): boolean {
  const t = text.trim();
  const words = wordCount(t);
  if (words > 12) return false;
  if (PLANNING_VERBS.test(t) || isCompositeQuery(t)) return false;
  if (SNIPPET_FACTUAL.test(t) || SNIPPET_TOPIC.test(t)) return true;
  // Very short non-planning asks ("bitcoin price", "madrid weather")
  if (words <= 6 && !SUBSTANCE_HINTS.test(t)) return true;
  return false;
}

/** Human-readable status line for the live tool indicator. */
export function webResearchRouteStatus(route: WebResearchRoute): string {
  if (route.mode === "facets") {
    return route.budget === "deep"
      ? "Researching (deep)…"
      : "Researching…";
  }
  return route.depth === "snippets" ? "Searching (quick)…" : "Searching…";
}

/**
 * Decide facets vs tool-loop and depth/budget for a web-enabled turn.
 */
export function resolveWebResearchRoute(
  userText: string,
  messages: ChatContextMessage[]
): WebResearchRoute {
  const text = userText.trim();

  if (isDeepResearchAsk(text)) {
    return { mode: "facets", budget: "deep" };
  }

  if (isCompositeQuery(text)) {
    return { mode: "facets", budget: "standard" };
  }

  if (priorWasComposite(messages) && looksLikeWebFollowUp(text, messages)) {
    return { mode: "facets", budget: "standard" };
  }

  if (isSnippetLookup(text)) {
    return { mode: "tools", depth: "snippets" };
  }

  return { mode: "tools", depth: "full" };
}
