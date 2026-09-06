/**
 * Host-side gmail_send: parse tool args, confirm in chat, then call Gmail.
 */

import { Api } from "../../api";
import {
  cancelGmailSendConfirm,
  openGmailSendConfirm,
  type GmailDraft,
} from "../../stores/gmailSendConfirmStore";
import type { GmailSendResult } from "../../types";

const MAX_BODY_CHARS = 100_000;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const EMAIL_FIND = /[^\s@<>;,+"']+@[^\s@<>;,+"']+/g;

/** Pull addresses out of a To/Cc field: commas, semicolons, or “and”. */
export function extractEmails(raw: string): string[] {
  const found = raw.match(EMAIL_FIND);
  if (found?.length) return found.map((e) => e.trim()).filter(Boolean);
  const trimmed = raw.trim();
  return trimmed ? [trimmed] : [];
}

export function parseRecipientList(value: unknown): string[] {
  const parts: string[] = [];
  const push = (raw: string) => {
    parts.push(...extractEmails(raw));
  };
  if (typeof value === "string") {
    push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") push(item);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const email of parts) {
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

export function parseGmailSendArgs(args: Record<string, unknown>): GmailDraft | { error: string } {
  const to = parseRecipientList(args.to);
  const cc = parseRecipientList(args.cc);
  const bcc = parseRecipientList(args.bcc);
  const subject = typeof args.subject === "string" ? args.subject.trim() : "";
  const body = typeof args.body === "string" ? args.body : "";

  if (!to.length) return { error: "gmail_send requires at least one recipient in `to`." };
  for (const email of [...to, ...cc, ...bcc]) {
    if (!EMAIL_RE.test(email)) {
      return { error: `“${email}” is not a valid email address.` };
    }
  }
  if (!subject) return { error: "gmail_send requires a subject." };
  if (!body.trim()) return { error: "gmail_send requires a body." };
  if (body.length > MAX_BODY_CHARS) return { error: "The email body is too long." };

  return { to, cc, bcc, subject, body };
}

export async function executeGmailSend(
  args: Record<string, unknown>,
  options?: {
    signal?: AbortSignal;
    onStatus?: (message: string | null) => void;
  }
): Promise<GmailSendResult> {
  const parsed = parseGmailSendArgs(args);
  if ("error" in parsed) {
    return { sent: false, reason: parsed.error };
  }

  if (options?.signal?.aborted) {
    return { sent: false, reason: "user_cancelled" };
  }

  options?.onStatus?.("Waiting for you to confirm the email…");
  const onAbort = () => {
    cancelGmailSendConfirm();
  };
  options?.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const decision = await openGmailSendConfirm(parsed);
    if (!decision.confirmed) {
      options?.onStatus?.(null);
      return { sent: false, reason: "user_cancelled" };
    }

    options?.onStatus?.("Sending email…");
    const result = await Api.gmailSend({
      to: decision.draft.to,
      cc: decision.draft.cc.length ? decision.draft.cc : undefined,
      bcc: decision.draft.bcc.length ? decision.draft.bcc : undefined,
      subject: decision.draft.subject,
      body: decision.draft.body,
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
          : "Could not send the email.";
    return { sent: false, reason: message };
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
  }
}
