/**
 * Host-side gmail_read: confirm in chat, then fetch recent messages.
 */

import { Api } from "../../api";
import {
  cancelGmailReadConfirm,
  openGmailReadConfirm,
} from "../../stores/gmailReadConfirmStore";
import type { GmailReadResult } from "../../types";

const MAX_RESULTS = 5;

export function parseGmailReadArgs(args: Record<string, unknown>): {
  maxResults: number;
  query: string | null;
  purpose: string;
} {
  const rawMax = args.max_results ?? args.maxResults;
  let maxResults = 1;
  if (typeof rawMax === "number" && Number.isFinite(rawMax)) {
    maxResults = Math.max(1, Math.min(MAX_RESULTS, Math.floor(rawMax)));
  } else if (typeof rawMax === "string" && rawMax.trim()) {
    const n = Number.parseInt(rawMax, 10);
    if (Number.isFinite(n)) maxResults = Math.max(1, Math.min(MAX_RESULTS, n));
  }

  const queryRaw = args.query;
  const query =
    typeof queryRaw === "string" && queryRaw.trim()
      ? queryRaw.trim()
      : null;

  const purposeRaw = args.purpose;
  const purpose =
    typeof purposeRaw === "string" && purposeRaw.trim()
      ? purposeRaw.trim()
      : maxResults === 1
        ? "Read your latest inbox email"
        : `Read your ${maxResults} most recent inbox emails`;

  return { maxResults, query, purpose };
}

export async function executeGmailRead(
  args: Record<string, unknown>,
  options?: {
    signal?: AbortSignal;
    onStatus?: (message: string | null) => void;
  }
): Promise<GmailReadResult> {
  const parsed = parseGmailReadArgs(args);

  if (options?.signal?.aborted) {
    return { ok: false, reason: "user_cancelled" };
  }

  options?.onStatus?.("Waiting for you to allow Gmail read…");
  const onAbort = () => {
    cancelGmailReadConfirm();
  };
  options?.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const decision = await openGmailReadConfirm({
      purpose: parsed.purpose,
      maxResults: parsed.maxResults,
      query: parsed.query,
    });
    if (!decision.confirmed) {
      options?.onStatus?.(null);
      return { ok: false, reason: "user_cancelled" };
    }

    options?.onStatus?.("Reading Gmail…");
    const result = await Api.gmailRead({
      maxResults: decision.request.maxResults,
      query: decision.request.query ?? undefined,
    });
    options?.onStatus?.(null);
    return result;
  } catch (err) {
    options?.onStatus?.(null);
    const message =
      typeof err === "string"
        ? err
        : err instanceof Error
          ? err.message
          : "Could not read Gmail.";
    return { ok: false, reason: message };
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
  }
}
