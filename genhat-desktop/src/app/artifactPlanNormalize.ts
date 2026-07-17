/**
 * Normalize presentation plans before native rendering.
 *
 * IMPORTANT: Do NOT invent topic content. Fake outline templates (injecting the
 * prompt into industrial-history boilerplate) produced decks that mentioned the
 * topic name everywhere while saying nothing real about it.
 *
 * This module only:
 * - normalizes field names / layouts
 * - drops empty / placeholder slides
 * - ensures a TITLE slide when possible
 * - never fabricates domain content
 */

function readString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Strip slash commands / filler so we keep the real presentation topic. */
export function cleanPresentationTopic(prompt: string): string {
  let t = prompt.trim();
  t = t.replace(/^\/+\s*(ppt|slides?|presentation|deck)\b[\s:]*/i, "");
  t = t.replace(
    /\b(make|create|generate|build|write|prepare)\s+(a|an|me|us)?\s*/gi,
    ""
  );
  t = t.replace(/\b(\d{1,2})\s*-?\s*slides?\b/gi, "");
  t = t.replace(/\bslides?\s*[:=]?\s*\d{1,2}\b/gi, "");
  // "presentation on X" / "deck about X" → X
  t = t.replace(
    /^(a\s+)?(presentation|deck|slides?|talk|lecture)\s+(on|about|regarding|concerning)\s+/i,
    ""
  );
  t = t.replace(/^(on|about|regarding|concerning)\s+/i, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t || "Presentation";
}

function normalizeSlide(
  slide: unknown,
  index: number,
  fallbackTitle: string
): Record<string, unknown> {
  const s =
    slide && typeof slide === "object" && !Array.isArray(slide)
      ? { ...(slide as Record<string, unknown>) }
      : {};

  let title =
    readString(s.title) ||
    readString(s.heading) ||
    readString(s.name) ||
    readString(s.topic) ||
    readString(s.label);

  if (!title && Array.isArray(s.bullets) && s.bullets.length > 0) {
    title = readString(s.bullets[0]);
  }
  if (!title) {
    title = index === 0 && fallbackTitle ? fallbackTitle : `Slide ${index + 1}`;
  }

  const layout =
    readString(s.layout).toUpperCase() || (index === 0 ? "TITLE" : "BULLET");

  const bullets = Array.isArray(s.bullets)
    ? s.bullets.map((b) => readString(b)).filter(Boolean)
    : [];

  // Drop our own legacy filler if it somehow reappears.
  const cleanedBullets = bullets.filter(
    (b) =>
      !/^an introduction to\b/i.test(b) &&
      !/^core themes, turning points/i.test(b) &&
      !/^this section frames how\b/i.test(b) &&
      !/^point \d+ on\b/i.test(b) &&
      !/\bhow it connects to the broader topic\b/i.test(b)
  );

  return {
    ...s,
    title,
    layout,
    bullets: cleanedBullets,
  };
}

/** True when a slide has no usable body text (and is not a real titled cover). */
function isEmptyOrPlaceholder(slide: Record<string, unknown>): boolean {
  const title = readString(slide.title);
  const layout = readString(slide.layout).toUpperCase() || "BULLET";
  const bullets = Array.isArray(slide.bullets)
    ? slide.bullets.map((b) => readString(b)).filter(Boolean)
    : [];
  const notes = readString(slide.notes);

  if (/^slide\s*\d+$/i.test(title) && bullets.length === 0) return true;
  if (!title && bullets.length === 0 && !notes) return true;

  // Title/section with only a generic heading and no body → drop.
  if (
    (layout === "TITLE" || layout === "SECTION" || layout === "CENTERED") &&
    bullets.length === 0 &&
    !notes
  ) {
    return true;
  }

  const contentLayouts = new Set([
    "BULLET",
    "TWO_COLUMN",
    "IMAGE_LEFT",
    "STAT",
    "QUOTE",
    "CARDS",
    "COMPARISON",
  ]);
  if (contentLayouts.has(layout) && bullets.length === 0 && !notes) return true;

  return false;
}

export interface NormalizePresentationOptions {
  /** Desired slide count (informational / passed through for backend). */
  targetSlideCount?: number;
}

/**
 * Keep the model's slides. Only drop empties — never invent domain content.
 */
export function normalizePresentationPlan(
  plan: Record<string, unknown>,
  userPrompt: string,
  options?: NormalizePresentationOptions
): Record<string, unknown> {
  const topic = cleanPresentationTopic(userPrompt);
  const target = Math.max(
    3,
    Math.min(20, options?.targetSlideCount ?? 6)
  );
  const repaired = { ...plan };

  const slidesRaw = Array.isArray(repaired.slides) ? repaired.slides : [];
  let slides = slidesRaw
    .map((slide, i) => normalizeSlide(slide, i, topic))
    .filter((s) => !isEmptyOrPlaceholder(s));

  // Deduplicate accidental repeated TITLE slides (keep first).
  let sawTitle = false;
  slides = slides.filter((s) => {
    const layout = readString(s.layout).toUpperCase();
    if (layout === "TITLE") {
      if (sawTitle) return false;
      sawTitle = true;
    }
    return true;
  });

  if (slides.length === 0) {
    // Absolute last resort: one honest title slide — no fake body paragraphs.
    slides = [
      {
        title: topic,
        layout: "TITLE",
        bullets: [
          `Presentation on ${topic}`,
          "Regenerate if this deck looks incomplete — content could not be recovered from the model output.",
        ],
      },
    ];
  } else if (readString(slides[0].layout) !== "TITLE") {
    slides[0] = { ...slides[0], layout: "TITLE" };
  }

  repaired.slides = slides;
  repaired._prompt = userPrompt;
  repaired._target_slides = target;
  return repaired;
}

/** @deprecated Kept for any external imports; prefer not fabricating outlines. */
export function buildTopicPresentationOutline(
  topic: string,
  _targetCount: number
): Record<string, unknown>[] {
  return [
    {
      title: cleanPresentationTopic(topic),
      layout: "TITLE",
      bullets: [
        `Presentation on ${cleanPresentationTopic(topic)}`,
        "Regenerate if this deck looks incomplete.",
      ],
    },
  ];
}

export function normalizeSpreadsheetPlan(
  plan: Record<string, unknown>
): Record<string, unknown> {
  const repaired = { ...plan };
  if (!Array.isArray(repaired.ops)) {
    repaired.ops = [];
  }
  return repaired;
}
