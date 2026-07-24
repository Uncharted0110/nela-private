/**
 * Presentation JSON plan prompts — split for OpenRouter prompt caching.
 */

export const PRESENTATION_SCHEMA_STATIC = `You generate ONLY a JSON presentation plan. No markdown, no code fences, no commentary.

Schema:
{"slides":[{"title":"string","layout":"TITLE"|"SECTION"|"BULLET"|"TWO_COLUMN"|"IMAGE_LEFT"|"STAT"|"QUOTE"|"CARDS"|"COMPARISON"|"CENTERED","bullets":["string"],"notes":"string","left_title":"string","right_title":"string"}],"theme":"midnight"|"corporate"|"sunset"|"minimal"|"academic"|"cyber"|"ocean"|"forest"|"lavender"|"neon"|"rose"|"slate"}

Layouts (pick to fit content):
- TITLE: cover. bullets = subtitle + 1–2 concrete taglines.
- SECTION: section divider with 1–3 real intro lines.
- BULLET: 4–6 bullets, each 15–40 words with a claim + brief explanation or example.
- TWO_COLUMN / IMAGE_LEFT: 4–6 concrete points.
- STAT: bullets[0] = headline metric/fact; then 2–3 supporting specifics.
- QUOTE: takeaway + attribution/context.
- CARDS: 3–4 items as "Label: 1–2 sentence specifics".
- COMPARISON: 3–5 points per side; left_title/right_title must be real domain terms (e.g. Classical vs Quantum), never "Primary approach".
- CENTERED: 2–4 short paragraphs of real takeaways.

Content rules:
- First slide TITLE; last slide CENTERED with a concrete takeaway about THIS topic.
- Slide 1–2 must DEFINE the topic (what it is / how it works). Later slides need named examples (algorithms, products, people, events, case studies — whatever fits).
- Every bullet must be specifically about the user's topic. No vague fluff ("transformative potential", "continuous innovation") unless tied to a fact.
- Use ≥4 different layouts. Avoid Q&A / References / Final Thoughts unless asked.
- Theme must match the topic.`;

export type PresentationSystemParts = {
  cacheable: string;
  dynamic: string;
};

export function buildPresentationSystemParts(options: {
  slideCountInstruction: string;
  sourceDocumentRules: string;
}): PresentationSystemParts {
  const dynamic = [
    `- ${options.slideCountInstruction}`,
    options.sourceDocumentRules.trim(),
  ]
    .filter(Boolean)
    .join("\n");

  return { cacheable: PRESENTATION_SCHEMA_STATIC, dynamic };
}

export function buildPresentationSystemPrompt(options: {
  slideCountInstruction: string;
  sourceDocumentRules: string;
}): string {
  const parts = buildPresentationSystemParts(options);
  return parts.dynamic
    ? `${parts.cacheable}\n\n${parts.dynamic}`
    : parts.cacheable;
}
