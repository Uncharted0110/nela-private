/** Detect a user turn that wants to send or read email (for the in-chat Connect card). */

const EMAIL_SEND_REQUEST =
  /(?:\b(?:e-?mail|gmail)\b|\bsend\b[\s\S]{0,48}\b(?:e-?mail|mail|message)\b|\bwrite\b[\s\S]{0,24}\b(?:e-?mail|mail)\b|\bmail\s+(?:to|this)\b)/i;

const EMAIL_READ_REQUEST =
  /(?:\b(?:latest|recent|last|unread)\b[\s\S]{0,40}\b(?:e-?mail|mail|inbox|message)s?\b|\b(?:summarize|read|check|fetch|show|open)\b[\s\S]{0,40}\b(?:e-?mail|mail|inbox|message)s?\b|\binbox\b)/i;

export function looksLikeEmailRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return EMAIL_SEND_REQUEST.test(trimmed) || EMAIL_READ_REQUEST.test(trimmed);
}

export function looksLikeEmailReadRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return EMAIL_READ_REQUEST.test(trimmed);
}
