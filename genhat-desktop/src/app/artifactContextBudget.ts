/**
 * Keep artifact plan prompts within the local model's context window.
 */

/** Rough token estimate (~4 chars/token for English-heavy text). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function trimToChars(text: string, maxChars: number, suffix = ""): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - suffix.length);
  return text.slice(0, keep) + suffix;
}

/** Trim web/RAG/ambient blocks to fit a character budget (preserves plan request). */
export function trimArtifactDataContext(
  dataContext: string,
  maxChars: number
): string {
  if (dataContext.length <= maxChars) return dataContext;
  return trimToChars(
    dataContext,
    maxChars,
    "\n\n[...source context truncated to fit model context window]"
  );
}

export interface ArtifactPromptBudget {
  contextWindowTokens: number;
  systemPrompt: string;
  dataContext: string;
  planRequest: string;
  desiredMaxOutputTokens: number;
}

export interface FittedArtifactPrompt {
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
}

/**
 * Fit system + user prompts and output token budget into the model context window.
 */
export function fitArtifactPlanPrompt(
  budget: ArtifactPromptBudget
): FittedArtifactPrompt {
  const margin = 96;
  const { contextWindowTokens, systemPrompt, planRequest, desiredMaxOutputTokens } =
    budget;

  let dataContext = budget.dataContext;

  // Reserve at least 25% of context for output, capped by desired max.
  let maxOutput = Math.min(
    desiredMaxOutputTokens,
    Math.max(384, Math.floor(contextWindowTokens * 0.4))
  );

  let maxInputTokens = contextWindowTokens - maxOutput - margin;
  if (maxInputTokens < 512) {
    maxOutput = Math.max(256, contextWindowTokens - 512 - margin);
    maxInputTokens = contextWindowTokens - maxOutput - margin;
  }

  const systemTokens = estimateTokens(systemPrompt);
  const planRequestTokens = estimateTokens(planRequest);
  let dataBudgetTokens = maxInputTokens - systemTokens - planRequestTokens;

  if (dataBudgetTokens < 256) {
    // Shrink output further to preserve minimal grounding context.
    maxOutput = Math.max(
      256,
      contextWindowTokens - systemTokens - planRequestTokens - 256 - margin
    );
    maxInputTokens = contextWindowTokens - maxOutput - margin;
    dataBudgetTokens = Math.max(128, maxInputTokens - systemTokens - planRequestTokens);
  }

  const dataBudgetChars = dataBudgetTokens * 4;
  dataContext = trimArtifactDataContext(dataContext, dataBudgetChars);

  const userPrompt = `${dataContext}${planRequest}`;
  const totalInput = systemTokens + estimateTokens(userPrompt);

  if (totalInput + maxOutput + margin > contextWindowTokens) {
    maxOutput = Math.max(
      256,
      contextWindowTokens - totalInput - margin
    );
  }

  return {
    systemPrompt,
    userPrompt,
    maxOutputTokens: Math.max(256, maxOutput),
  };
}
