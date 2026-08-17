/**
 * Sparse ask_followup host — at most one popup per user turn.
 * Used by the cloud tool loop and artifact-edit missing-data guards.
 */

import {
  beginAskFollowUpTurn,
  bumpAskFollowUpTurnCount,
  cancelFollowUp,
  getAskFollowUpTurnCount,
  openFollowUp,
  type FollowUpQuestion,
  type FollowUpResult,
} from "../../stores/followUpStore";
import {
  isDataCorrectionWithoutValues,
  isImageEditWithoutSource,
} from "../artifactEdit";

export type AskFollowUpArgs = {
  reason?: string;
  questions?: Array<{
    id?: string;
    prompt?: string;
    input_type?: string;
    choices?: string[];
  }>;
  allow_attachments?: boolean;
};

export type AskFollowUpToolResult = {
  status: "answered" | "cancelled" | "skipped";
  answers: Record<string, string>;
  attachedPaths: string[];
  freeformNote?: string;
  reason?: string;
};

const MAX_QUESTIONS = 3;

export function normalizeAskFollowUpQuestions(
  raw: AskFollowUpArgs["questions"]
): FollowUpQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: FollowUpQuestion[] = [];
  for (let i = 0; i < raw.length && out.length < MAX_QUESTIONS; i++) {
    const q = raw[i];
    const prompt = typeof q?.prompt === "string" ? q.prompt.trim() : "";
    if (!prompt) continue;
    const inputRaw = typeof q?.input_type === "string" ? q.input_type : "text";
    const input_type =
      inputRaw === "textarea" || inputRaw === "choice" ? inputRaw : "text";
    const choices = Array.isArray(q?.choices)
      ? q.choices.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      : undefined;
    out.push({
      id: typeof q?.id === "string" && q.id.trim() ? q.id.trim() : `q${out.length + 1}`,
      prompt,
      input_type,
      ...(input_type === "choice" && choices?.length ? { choices } : {}),
    });
  }
  return out;
}

/**
 * Execute ask_followup with hard sparsity limits.
 * Second+ call in the same turn returns skipped without opening UI.
 */
export async function executeAskFollowUp(
  args: AskFollowUpArgs,
  options?: {
    turnId?: string;
    signal?: AbortSignal;
    onStatus?: (message: string | null) => void;
  }
): Promise<AskFollowUpToolResult> {
  beginAskFollowUpTurn(options?.turnId);
  const count = bumpAskFollowUpTurnCount();
  if (count > 1) {
    return {
      status: "skipped",
      answers: {},
      attachedPaths: [],
      reason: "ask_followup already used once this turn — continue with best effort or ask in chat prose.",
    };
  }

  let questions = normalizeAskFollowUpQuestions(args.questions);
  if (questions.length === 0) {
    questions = [
      {
        id: "q1",
        prompt:
          typeof args.reason === "string" && args.reason.trim()
            ? args.reason.trim()
            : "What else should I know to finish this?",
        input_type: "textarea",
      },
    ];
  }

  if (options?.signal?.aborted) {
    return { status: "cancelled", answers: {}, attachedPaths: [] };
  }

  options?.onStatus?.("Waiting for your answers…");

  const onAbort = () => {
    cancelFollowUp();
  };
  options?.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const result: FollowUpResult = await openFollowUp({
      reason:
        typeof args.reason === "string" && args.reason.trim()
          ? args.reason.trim()
          : "Need a bit more detail",
      questions,
      allowAttachments: Boolean(args.allow_attachments),
    });
    options?.onStatus?.(null);
    if (result.status === "cancelled") {
      return { status: "cancelled", answers: {}, attachedPaths: [] };
    }
    return {
      status: "answered",
      answers: result.answers,
      attachedPaths: result.attachedPaths,
      freeformNote: result.freeformNote,
    };
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
  }
}

export function formatFollowUpIntoPrompt(
  originalPrompt: string,
  result: AskFollowUpToolResult
): string {
  if (result.status !== "answered") return originalPrompt;
  const parts: string[] = [originalPrompt.trim()];
  const answerLines = Object.entries(result.answers)
    .filter(([, v]) => v.trim())
    .map(([k, v]) => `- ${k}: ${v.trim()}`);
  if (answerLines.length) {
    parts.push(`Follow-up answers:\n${answerLines.join("\n")}`);
  }
  if (result.freeformNote?.trim()) {
    parts.push(`Additional context:\n${result.freeformNote.trim()}`);
  }
  if (result.attachedPaths.length) {
    parts.push(
      `Attached files:\n${result.attachedPaths.map((p) => `- ${p}`).join("\n")}`
    );
  }
  return parts.join("\n\n");
}

export type ArtifactEditFollowUpOutcome = {
  status: "answered" | "cancelled" | "skipped" | "not_needed";
  augmentedPrompt?: string;
  attachedPaths: string[];
};

/**
 * Deterministic missing-data gate for artifact edits (no LLM tool hop).
 */
export async function maybeAskFollowUpForArtifactEdit(opts: {
  prompt: string;
  attachedPaths: string[];
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
  turnId?: string;
}): Promise<ArtifactEditFollowUpOutcome> {
  const turnId = opts.turnId ?? `edit-${Date.now()}`;
  beginAskFollowUpTurn(turnId);

  const needsData = isDataCorrectionWithoutValues(opts.prompt);
  const needsImage = isImageEditWithoutSource(opts.prompt, opts.attachedPaths);
  if (!needsData && !needsImage) {
    return { status: "not_needed", attachedPaths: opts.attachedPaths };
  }

  if (getAskFollowUpTurnCount() >= 1) {
    return { status: "skipped", attachedPaths: opts.attachedPaths };
  }

  const questions: AskFollowUpArgs["questions"] = [];
  if (needsData) {
    questions.push({
      id: "corrected_values",
      prompt:
        "Please paste the corrected numbers or values to use (I won’t invent replacements).",
      input_type: "textarea",
    });
  }
  if (needsImage) {
    questions.push({
      id: "image_note",
      prompt:
        "Describe the image to use, or attach/paste an image file below.",
      input_type: "textarea",
    });
  }

  const result = await executeAskFollowUp(
    {
      reason: needsData
        ? "Need the corrected data before editing"
        : "Need an image for this edit",
      questions,
      allow_attachments: needsImage || needsData,
    },
    {
      turnId,
      signal: opts.signal,
      onStatus: (msg) => {
        if (msg) opts.onStatus?.(msg);
      },
    }
  );

  if (result.status === "cancelled") {
    return { status: "cancelled", attachedPaths: opts.attachedPaths };
  }
  if (result.status === "skipped") {
    return { status: "skipped", attachedPaths: opts.attachedPaths };
  }

  const mergedPaths = [
    ...opts.attachedPaths,
    ...result.attachedPaths.filter((p) => !opts.attachedPaths.includes(p)),
  ];
  return {
    status: "answered",
    augmentedPrompt: formatFollowUpIntoPrompt(opts.prompt, result),
    attachedPaths: mergedPaths,
  };
}

/** Exported for unit tests. */
export function __testResetAskFollowUpTurn(): void {
  beginAskFollowUpTurn(`test-${Date.now()}-${Math.random()}`);
  // begin resets count when turn id changes
}
