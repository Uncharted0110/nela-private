/** Max chars pushed into React for live thinking (keeps DOM/re-renders bounded). */
export const THINKING_UI_MAX_CHARS = 32_000;

/**
 * Keep only the tail of a thinking string for UI. Full text can stay in a
 * local accumulator for persistence truncation elsewhere.
 */
export function windowThinkingForUi(text: string, max = THINKING_UI_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `…\n${text.slice(-max)}`;
}
