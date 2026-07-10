/** Infer page archetype from the user prompt. */

export const HTML_PAGE_ARCHETYPES = [
  "landing",
  "local_business",
  "article",
  "portfolio",
  "dashboard",
  "documentation",
  "event",
  "comparison",
  "catalog",
  "resume",
  "infographic",
  "newsletter",
  "interactive",
] as const;

export type HtmlPageArchetype = (typeof HTML_PAGE_ARCHETYPES)[number];

const KEYWORDS: Record<HtmlPageArchetype, { aliases: string[]; topics: string[] }> = {
  landing: {
    aliases: ["landing page", "homepage", "home page", "saas", "startup", "product page", "product launch"],
    topics: ["software", "platform", "subscription", "sign up", "free trial"],
  },
  local_business: {
    aliases: ["menu", "bakery", "restaurant", "café", "cafe", "hours", "neighborhood", "coffee shop", "barber", "salon", "pizzeria"],
    topics: ["bakery", "bread", "coffee", "pizza", "diner", "opening hours", "downtown", "family owned"],
  },
  article: {
    aliases: ["article", "blog post", "blog", "essay", "editorial", "write about", "story about"],
    topics: ["analysis", "explainer", "deep dive", "guide to", "history of", "opinion", "thoughts on"],
  },
  portfolio: {
    aliases: ["portfolio", "showcase", "my projects", "my work", "case studies"],
    topics: ["designer", "developer", "photographer", "freelance", "creative", "illustrator", "agency"],
  },
  dashboard: {
    aliases: [
      "dashboard",
      "analytics page",
      "admin panel",
      "control panel",
      "kpi dashboard",
      "pie chart",
      "bar chart",
      "bar graph",
      "line chart",
      "line graph",
      "data visualization",
      "visualize",
    ],
    topics: ["kpi", "monitoring", "reporting", "traffic", "revenue", "metrics overview", "analytics", "chart", "plot", "graph"],
  },
  documentation: {
    aliases: ["docs page", "documentation", "tutorial page", "how-to guide", "manual", "readme"],
    topics: ["api", "setup", "install", "getting started", "step by step", "reference", "sdk"],
  },
  event: {
    aliases: ["event page", "conference", "summit", "wedding", "tickets", "festival", "meetup"],
    topics: ["schedule", "speakers", "venue", "register", "agenda", "workshop", "gala"],
  },
  comparison: {
    aliases: ["compare", "comparison page", "versus", " vs ", "alternatives", "which is better"],
    topics: ["pros and cons", "difference between", "side by side", "review", "pricing tiers"],
  },
  catalog: {
    aliases: ["catalog", "online shop", "shop page", "store page", "products page", "ecommerce", "e-commerce"],
    topics: ["buy", "price", "sale", "merchandise", "listing", "add to cart", "collection"],
  },
  resume: {
    aliases: ["resume", "cv page", "curriculum vitae", "profile page", "about me page"],
    topics: ["experience", "skills", "education", "career", "job history", "hire me"],
  },
  infographic: {
    aliases: ["infographic", "fact sheet", "visual guide", "one-pager", "cheat sheet"],
    topics: ["facts", "statistics", "timeline", "science", "process", "by the numbers", "data viz"],
  },
  newsletter: {
    aliases: ["newsletter", "subscribe page", "signup page", "waitlist", "mailing list"],
    topics: ["join", "updates", "notify me", "email list", "stay in the loop"],
  },
  interactive: {
    aliases: [
      "random picker",
      "randomizer",
      "mini app",
      "web app",
      "interactive page",
      "recommendation",
      "movie recommendation",
      "what to watch",
    ],
    topics: [
      "random",
      "recommend",
      "recommendation",
      "picker",
      "pick a",
      "pick me",
      "generator",
      "generate",
      "what should i watch",
      "movie",
      "movies",
      "film",
      "suggest",
      "suggestion",
      "roll",
      "dice",
      "spin",
      "shuffle",
      "quiz",
      "calculator",
      "help me choose",
      "decide for me",
      "surprise me",
    ],
  },
};

function hashString(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

export function isHtmlArchetype(value: unknown): value is HtmlPageArchetype {
  return typeof value === "string" && (HTML_PAGE_ARCHETYPES as readonly string[]).includes(value);
}

export function normalizeHtmlArchetype(value: unknown): HtmlPageArchetype {
  return isHtmlArchetype(value) ? value : "landing";
}

export function inferHtmlPageStructure(text: string): HtmlPageArchetype {
  const lower = text.toLowerCase();

  // Utility / picker pages — must win over generic "landing" defaults.
  const priority: HtmlPageArchetype[] = [
    "interactive",
    "local_business",
    "article",
    "portfolio",
    "dashboard",
    "documentation",
    "event",
    "comparison",
    "catalog",
    "resume",
    "infographic",
    "newsletter",
    "landing",
  ];

  for (const id of priority) {
    if (KEYWORDS[id].aliases.some((kw) => lower.includes(kw))) {
      return id;
    }
  }

  // Strong signal: random + recommend/movie → interactive tool page.
  const wantsRandom = /\brandom\b|surprise me|pick (one|a)/i.test(lower);
  const wantsRec =
    /recommend|suggestion|what to watch|movie|film|show me/i.test(lower);
  if (wantsRandom && wantsRec) {
    return "interactive";
  }

  let best: HtmlPageArchetype | null = null;
  let bestScore = 0;
  for (const id of priority) {
    const score = KEYWORDS[id].topics.reduce(
      (acc, kw) => (lower.includes(kw) ? acc + 1 : acc),
      0
    );
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  if (best) return best;

  return HTML_PAGE_ARCHETYPES[hashString(lower.trim()) % HTML_PAGE_ARCHETYPES.length];
}
