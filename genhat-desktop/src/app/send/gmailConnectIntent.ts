/** Detect a user turn that wants to send email (for the in-chat Connect card). */

const EMAIL_REQUEST =
  /(?:\b(?:e-?mail|gmail)\b|\bsend\b[\s\S]{0,48}\b(?:e-?mail|mail|message)\b|\bwrite\b[\s\S]{0,24}\b(?:e-?mail|mail)\b|\bmail\s+(?:to|this)\b)/i;

export function looksLikeEmailRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return EMAIL_REQUEST.test(trimmed);
}
