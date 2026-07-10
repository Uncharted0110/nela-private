/**
 * Deterministic HTML theme inference — mirrors presentation theme logic.
 */

import { HTML_RENDERER_THEMES, type HtmlRendererTheme } from "./htmlArtifactPrompt";

const THEME_KEYWORDS: Record<HtmlRendererTheme, { aliases: string[]; topics: string[] }> = {
  corporate: {
    aliases: ["corporate", "business", "professional", "executive", "formal", "enterprise"],
    topics: ["strategy", "quarterly", "revenue", "sales", "finance", "investor", "kpi", "b2b", "dashboard"],
  },
  academic: {
    aliases: ["academic", "research", "university", "thesis", "serif", "scholarly"],
    topics: ["study", "hypothesis", "methodology", "paper", "history", "education", "lecture"],
  },
  cyber: {
    aliases: ["cyber", "tech", "hacker", "matrix", "futuristic", "sci-fi"],
    topics: ["ai", "machine learning", "software", "cybersecurity", "blockchain", "cloud", "data science"],
  },
  ocean: {
    aliases: ["ocean", "aqua", "marine", "blue", "sea", "water"],
    topics: ["health", "wellness", "medical", "healthcare", "climate", "calm"],
  },
  forest: {
    aliases: ["forest", "nature", "eco", "green", "organic"],
    topics: ["environment", "sustainability", "climate", "renewable", "ecology", "agriculture"],
  },
  sunset: {
    aliases: ["sunset", "warm", "vibrant", "colorful", "energetic"],
    topics: ["marketing", "branding", "food", "restaurant", "travel", "lifestyle"],
  },
  lavender: {
    aliases: ["lavender", "purple", "violet", "dreamy", "soft"],
    topics: ["creativity", "art", "storytelling", "wedding", "beauty"],
  },
  neon: {
    aliases: ["neon", "electric", "bright", "bold", "punchy"],
    topics: ["gaming", "esports", "music", "entertainment", "streaming"],
  },
  rose: {
    aliases: ["rose", "pink", "elegant", "luxury", "premium"],
    topics: ["fashion", "cosmetics", "jewelry", "romance", "boutique"],
  },
  slate: {
    aliases: ["slate", "gray", "grey", "mono", "monochrome", "industrial"],
    topics: ["engineering", "architecture", "manufacturing", "logistics", "operations", "report"],
  },
  minimal: {
    aliases: ["minimal", "minimalist", "clean", "simple", "light theme", "white background"],
    topics: ["overview", "summary", "tutorial", "guide", "documentation", "docs"],
  },
  midnight: {
    aliases: ["midnight", "dark", "sleek", "modern"],
    topics: ["product", "roadmap", "vision", "innovation", "saas"],
  },
  aurora: {
    aliases: ["aurora", "northern lights", "gradient", "teal purple"],
    topics: ["analytics", "data viz", "visualization", "metrics", "chart", "dashboard"],
  },
  paper: {
    aliases: ["paper", "editorial", "print", "cream", "newspaper"],
    topics: ["report", "briefing", "memo", "newsletter", "article"],
  },
};

function hashString(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

export function inferHtmlTheme(text: string): HtmlRendererTheme {
  const lower = text.toLowerCase();

  for (const theme of HTML_RENDERER_THEMES) {
    if (THEME_KEYWORDS[theme].aliases.some((kw) => lower.includes(kw))) {
      return theme;
    }
  }

  let best: HtmlRendererTheme | null = null;
  let bestScore = 0;
  for (const theme of HTML_RENDERER_THEMES) {
    const score = THEME_KEYWORDS[theme].topics.reduce(
      (acc, kw) => (lower.includes(kw) ? acc + 1 : acc),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      best = theme;
    }
  }
  if (best) return best;

  const idx = hashString(lower.trim()) % HTML_RENDERER_THEMES.length;
  return HTML_RENDERER_THEMES[idx];
}
