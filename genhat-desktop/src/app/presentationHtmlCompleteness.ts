const MAX_CONTINUES = 2;
const CUTOFF_CHARS = 2800;

function countSlideMarkers(html: string): number {
  const patterns = [
    /class\s*=\s*["'][^"']*\bslide\b/gi,
    /data-slide\s*=/gi,
    /class\s*=\s*["'][^"']*\bdeck-slide\b/gi,
    /class\s*=\s*["'][^"']*\bppt-slide\b/gi,
    /id\s*=\s*["']slide[-_]?\d+/gi,
  ];
  let max = 0;
  for (const re of patterns) {
    const n = (html.match(re) || []).length;
    if (n > max) max = n;
  }
  if (max < 2) {
    const sections = (html.match(/<section[\s>]/gi) || []).length;
    if (sections > max) max = sections;
  }
  return max;
}

export function trimIncompleteTrailingMarkup(html: string): string {
  const trimmed = html.replace(/\s*<\/nela-artifact>\s*$/i, "");
  const lastLt = trimmed.lastIndexOf("<");
  const lastGt = trimmed.lastIndexOf(">");
  if (lastLt > lastGt) return trimmed.slice(0, lastLt);
  return trimmed;
}

export function stripContinuationFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:html|HTML)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/<\/?nela-artifact\b[^>]*>/gi, "")
    .trim();
}

export function isIncompletePresentationHtml(
  html: string,
  options?: { requestedSlides?: number }
): boolean {
  const trimmed = html.trim();
  if (!trimmed) return true;
  if (/<style[\s>]/i.test(trimmed) && !/<\/style>/i.test(trimmed)) return true;
  if (/<html[\s>]/i.test(trimmed) && !/<\/html>/i.test(trimmed)) return true;
  if (/<body[\s>]/i.test(trimmed) && !/<\/body>/i.test(trimmed)) return true;
  if (/<[^>]*$/.test(trimmed)) return true;

  const requested = options?.requestedSlides ?? 0;
  const slides = countSlideMarkers(trimmed);
  const target = Math.max(requested, 0);
  if (target >= 4 && slides > 0 && slides < Math.max(3, Math.ceil(target * 0.6))) {
    return true;
  }
  return false;
}

export function stitchPresentationHtml(head: string, tail: string): string {
  const extra = stripContinuationFences(tail);
  if (!extra) return trimIncompleteTrailingMarkup(head);

  const extraSlides = countSlideMarkers(extra);
  const headSlides = countSlideMarkers(head);
  if (
    /<!DOCTYPE\s+html|<html[\s>]/i.test(extra) &&
    extraSlides > headSlides
  ) {
    return extra;
  }

  const trimmedHead = trimIncompleteTrailingMarkup(head);
  const closedDoc = /<\/html>/i.test(trimmedHead);
  if (closedDoc && extraSlides > 0) {
    const fragment = extra
      .replace(/<!DOCTYPE\s+html[^>]*>/i, "")
      .replace(/<\/body>\s*<\/html>/i, "")
      .trim();
    if (/<\/body>/i.test(trimmedHead)) {
      return trimmedHead.replace(
        /<\/body>\s*<\/html>/i,
        `${fragment}\n</body></html>`
      );
    }
    return trimmedHead.replace(/<\/html>/i, `${fragment}\n</html>`);
  }

  const base = trimmedHead
    .replace(/\s*<\/body>\s*<\/html>\s*$/i, "")
    .replace(/\s*<\/html>\s*$/i, "");
  return `${base}\n${extra}`;
}

export function buildPresentationContinuePrompt(input: {
  html: string;
  userRequest: string;
  requestedSlides: number;
}): string {
  const slides = countSlideMarkers(input.html);
  const request = input.userRequest.trim().slice(0, 1500);
  const cutoff = input.html.slice(-CUTOFF_CHARS);
  const remaining =
    input.requestedSlides > slides
      ? `About ${input.requestedSlides} slides were requested; ${slides || 0} are present so far.`
      : `Finish any remaining slides and close the document.`;
  return (
    `The HTML presentation was cut off before it finished.\n\n` +
    `USER REQUEST:\n${request}\n\n` +
    `${remaining} Continue EXACTLY from the cutoff. Do not restart <!DOCTYPE> or <html> unless the cutoff has no document yet. ` +
    `Do not repeat finished slides. Output ONLY remaining HTML (no markdown, no chat). ` +
    `End with </body></html>.\n\n` +
    `CUTOFF (last characters):\n${cutoff}`
  );
}

export async function completeTruncatedPresentationHtml(input: {
  html: string;
  userRequest: string;
  requestedSlides: number;
  continueOnce: (prompt: string) => Promise<string>;
  onProgress?: (status: string) => void;
}): Promise<{ html: string; continued: boolean; stillIncomplete: boolean }> {
  let html = input.html;
  let continued = false;
  const requestedSlides = Math.max(input.requestedSlides, 6);

  for (let i = 0; i < MAX_CONTINUES; i++) {
    if (!isIncompletePresentationHtml(html, { requestedSlides })) {
      return { html, continued, stillIncomplete: false };
    }
    if (html.trim().length < 80 && countSlideMarkers(html) === 0) {
      return { html, continued, stillIncomplete: true };
    }
    input.onProgress?.(
      i === 0
        ? "Deck was cut off — continuing from where it stopped…"
        : "Still incomplete — finishing remaining slides…"
    );
    try {
      const extra = await input.continueOnce(
        buildPresentationContinuePrompt({
          html,
          userRequest: input.userRequest,
          requestedSlides,
        })
      );
      if (!extra.trim()) break;
      html = stitchPresentationHtml(html, extra);
      continued = true;
    } catch {
      break;
    }
  }

  return {
    html,
    continued,
    stillIncomplete: isIncompletePresentationHtml(html, { requestedSlides }),
  };
}
