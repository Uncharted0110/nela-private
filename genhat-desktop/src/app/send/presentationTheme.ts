/** The complete set of presentation themes supported by the renderer. */
export const PRESENTATION_THEMES = [
  "midnight",
  "corporate",
  "sunset",
  "minimal",
  "academic",
  "cyber",
  "ocean",
  "forest",
  "lavender",
  "neon",
  "rose",
  "slate",
] as const;

export type PresentationTheme = (typeof PRESENTATION_THEMES)[number];

/**
 * Maps each theme to keyword groups. The first group holds the explicit theme
 * names/aliases (highest priority); the second holds topic/domain keywords so a
 * theme can be inferred from the subject matter even when no style is named.
 */
const THEME_KEYWORDS: Record<PresentationTheme, { aliases: string[]; topics: string[] }> = {
  corporate: {
    aliases: ["corporate", "business", "professional", "executive", "formal", "enterprise"],
    topics: ["strategy", "quarterly", "revenue", "sales", "finance", "investor", "stakeholder", "roi", "market share", "company", "startup", "pitch deck", "kpi", "b2b"],
  },
  academic: {
    aliases: ["academic", "research", "university", "thesis", "serif", "scholarly", "scholar", "dissertation"],
    topics: ["study", "literature", "hypothesis", "methodology", "paper", "history", "philosophy", "education", "lecture", "curriculum", "experiment", "citation"],
  },
  cyber: {
    aliases: ["cyber", "tech", "hacker", "matrix", "futuristic", "sci-fi", "scifi"],
    topics: ["ai", "machine learning", "artificial intelligence", "software", "programming", "cybersecurity", "security", "blockchain", "crypto", "cloud", "devops", "data science", "neural", "algorithm", "robotics", "quantum"],
  },
  ocean: {
    aliases: [
      "ocean",
      "aqua",
      "marine",
      "blue",
      "bluish",
      "blueish",
      "blue gradient",
      "bluish gradient",
      "azure",
      "sky blue",
      "sea",
      "water",
    ],
    topics: ["health", "wellness", "medical", "medicine", "healthcare", "ocean", "water", "climate ocean", "fishery", "diving", "hydro", "calm", "meditation"],
  },
  forest: {
    aliases: ["forest", "nature", "eco", "green", "organic"],
    topics: ["environment", "sustainability", "climate", "renewable", "ecology", "biology", "agriculture", "conservation", "carbon", "green energy", "plant", "wildlife", "farming"],
  },
  sunset: {
    aliases: ["sunset", "warm", "vibrant", "colorful", "energetic", "orange", "tangerine", "amber"],
    topics: ["marketing", "campaign", "branding", "social media", "advertising", "growth", "launch", "event", "festival", "travel", "food", "lifestyle"],
  },
  lavender: {
    aliases: ["lavender", "purple", "violet", "dreamy", "soft"],
    topics: ["creativity", "art", "storytelling", "writing", "poetry", "imagination", "wedding", "beauty", "spa"],
  },
  neon: {
    aliases: ["neon", "electric", "bright", "bold", "punchy", "loud"],
    topics: ["gaming", "game", "esports", "music", "concert", "nightlife", "entertainment", "streaming", "youth", "party", "hype"],
  },
  rose: {
    aliases: ["rose", "pink", "elegant", "luxury", "luxurious", "premium"],
    topics: ["fashion", "luxury", "cosmetics", "jewelry", "romance", "valentine", "boutique", "couture", "perfume"],
  },
  slate: {
    aliases: ["slate", "gray", "grey", "mono", "monochrome", "neutral", "industrial"],
    topics: ["engineering", "architecture", "manufacturing", "logistics", "infrastructure", "hardware", "construction", "operations", "supply chain", "report"],
  },
  minimal: {
    aliases: ["minimal", "minimalist", "clean", "simple", "light theme", "white background", "plain"],
    topics: ["overview", "summary", "introduction", "getting started", "basics", "tutorial", "guide", "checklist"],
  },
  midnight: {
    aliases: ["midnight", "dark", "default", "sleek", "modern"],
    topics: ["product", "roadmap", "vision", "future", "innovation", "general", "tech demo"],
  },
};

/** Small stable string hash (djb2) for deterministic theme fallback. */
export function hashString(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Decide a presentation theme DIRECTLY from the prompt, always returning one of
 * the 12 supported themes. Resolution order:
 *   1. Explicit theme name/alias in the prompt (e.g. "neon", "corporate").
 *   2. Topic/domain keywords inferred from the subject (e.g. "AI" -> cyber).
 *   3. Stable hash of the prompt across all 12 themes (deterministic + varied).
 * The result is stable: the same prompt always maps to the same theme.
 */
export function inferPresentationTheme(text: string): PresentationTheme {
  const lower = text.toLowerCase();

  // 1. Explicit theme name / alias wins.
  for (const theme of PRESENTATION_THEMES) {
    if (THEME_KEYWORDS[theme].aliases.some((kw) => lower.includes(kw))) {
      return theme;
    }
  }

  // 2. Topic / domain keyword inference — score each theme by keyword hits.
  let best: PresentationTheme | null = null;
  let bestScore = 0;
  for (const theme of PRESENTATION_THEMES) {
    const score = THEME_KEYWORDS[theme].topics.reduce(
      (acc, kw) => (lower.includes(kw) ? acc + 1 : acc),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      best = theme;
    }
  }
  if (best) {
    return best;
  }

  // 3. Deterministic fallback: stable across runs, varied across prompts.
  const idx = hashString(lower.trim()) % PRESENTATION_THEMES.length;
  return PRESENTATION_THEMES[idx];
}

/**
 * Decide how many slides a presentation deck should contain.
 *
 * Honors an explicit count in the prompt (e.g. "make a 7 slide deck",
 * "10-slide presentation", "slides: 8"), clamped to a sane range. Falls back
 * to a default when the user doesn't specify a number.
 *
 * Returns the resolved count plus whether it was explicitly requested so the
 * prompt can phrase the instruction accordingly.
 */
export function extractSlideCount(text: string): { count: number; explicit: boolean } {
  const MIN_SLIDES = 3;
  const MAX_SLIDES = 20;
  const DEFAULT_SLIDES = 6;

  const lower = text.toLowerCase();

  const explicitMatch =
    lower.match(/(\d{1,2})\s*-?\s*slides?\b/) ||
    lower.match(/\bslides?\s*[:=]?\s*(\d{1,2})\b/) ||
    lower.match(/\b(\d{1,2})\s*-?\s*slide\b/);

  if (explicitMatch) {
    const n = parseInt(explicitMatch[1], 10);
    if (!Number.isNaN(n) && n > 0) {
      return {
        count: Math.min(MAX_SLIDES, Math.max(MIN_SLIDES, n)),
        explicit: true,
      };
    }
  }

  return { count: DEFAULT_SLIDES, explicit: false };
}