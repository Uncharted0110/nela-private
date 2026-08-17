import { create } from "zustand";

export type FollowUpQuestion = {
  id: string;
  prompt: string;
  input_type: "text" | "textarea" | "choice";
  choices?: string[];
};

export type FollowUpRequest = {
  requestId: string;
  reason: string;
  questions: FollowUpQuestion[];
  allowAttachments: boolean;
  status: "waiting" | "resolved";
};

export type FollowUpResult = {
  status: "answered" | "cancelled";
  answers: Record<string, string>;
  attachedPaths: string[];
  freeformNote?: string;
};

interface FollowUpState {
  pending: FollowUpRequest | null;
}

let followUpResolve: ((value: FollowUpResult) => void) | null = null;
let requestCounter = 0;

/** How many ask_followup calls happened in the current user turn. */
let turnCallCount = 0;
let turnId: string | null = null;

export function beginAskFollowUpTurn(id?: string): void {
  const next = id ?? `turn-${Date.now()}`;
  if (turnId !== next) {
    turnId = next;
    turnCallCount = 0;
  }
}

export function getAskFollowUpTurnCount(): number {
  return turnCallCount;
}

export function bumpAskFollowUpTurnCount(): number {
  turnCallCount += 1;
  return turnCallCount;
}

export const resolveFollowUp = (value: FollowUpResult) => {
  const resolver = followUpResolve;
  followUpResolve = null;
  const pending = useFollowUpStore.getState().pending;
  useFollowUpStore.setState({
    pending: pending ? { ...pending, status: "resolved" } : null,
  });
  queueMicrotask(() => {
    useFollowUpStore.setState({ pending: null });
  });
  resolver?.(value);
};

/** Cancel any open follow-up (abort, panel close). */
export const cancelFollowUp = () => {
  if (!followUpResolve && !useFollowUpStore.getState().pending) return;
  resolveFollowUp({
    status: "cancelled",
    answers: {},
    attachedPaths: [],
  });
};

/**
 * Open the follow-up modal and wait for answers (or cancel).
 * Only one follow-up may be open at a time — a new open cancels the previous.
 */
export const openFollowUp = (opts: {
  reason: string;
  questions: FollowUpQuestion[];
  allowAttachments?: boolean;
}): Promise<FollowUpResult> => {
  if (followUpResolve) {
    const prev = followUpResolve;
    followUpResolve = null;
    prev({ status: "cancelled", answers: {}, attachedPaths: [] });
  }

  requestCounter += 1;
  const requestId = `follow-up-${requestCounter}`;
  const questions = opts.questions.slice(0, 3).map((q, i) => ({
    ...q,
    id: q.id?.trim() || `q${i + 1}`,
  }));

  return new Promise<FollowUpResult>((resolve) => {
    followUpResolve = resolve;
    useFollowUpStore.setState({
      pending: {
        requestId,
        reason: opts.reason.trim() || "Need a bit more detail",
        questions,
        allowAttachments: Boolean(opts.allowAttachments),
        status: "waiting",
      },
    });
  });
};

export const useFollowUpStore = create<FollowUpState>(() => ({
  pending: null,
}));
