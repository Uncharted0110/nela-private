/**
 * Normalize artifact plans before sending them to the native renderer.
 * Fills missing required fields so minor model output drift does not fail generation.
 */

function readString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function normalizeSlide(slide: unknown, index: number, fallbackTitle: string): Record<string, unknown> {
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

  return {
    ...s,
    title,
    layout,
    bullets,
  };
}

export function normalizePresentationPlan(
  plan: Record<string, unknown>,
  userPrompt: string
): Record<string, unknown> {
  const fallbackTitle = userPrompt.trim().slice(0, 120) || "Presentation";
  const repaired = { ...plan };

  const slidesRaw = Array.isArray(repaired.slides) ? repaired.slides : [];
  let slides = slidesRaw.map((slide, i) =>
    normalizeSlide(slide, i, fallbackTitle)
  );

  if (slides.length === 0) {
    slides = [
      {
        title: fallbackTitle,
        layout: "TITLE",
        bullets: [userPrompt.trim().slice(0, 200) || "Generated presentation"],
      },
    ];
  } else if (readString(slides[0].layout) !== "TITLE") {
    slides[0] = { ...slides[0], layout: "TITLE" };
  }

  repaired.slides = slides;
  repaired._prompt = userPrompt;
  return repaired;
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
