/**
 * Fill an "about X" slide using presentation web research + LLM synthesis
 * grounded in the deck's original request, title, and existing slide voice.
 */

import { Api } from "../../api";
import { buildArtifactImagePool } from "../artifactImagePool";
import { webPresentationGroundingPreamble } from "../webSearchQuery";
import { runWebSearchWithDepth } from "./webSearchDepth";
import { mergeWebSearchResults } from "./webSearchToolLoop";
import { streamChatByMode } from "./cloudOrLocalStream";
import type { DeckSlideContext } from "./deckSlideContext";
import type { WebSearchResult } from "../../types";
import type { WebToolDepth } from "./webSearchDepth";

export type EnrichedSlideContent = {
  title: string;
  summary: string;
  bullets: string[];
  /** Travel-style short paragraphs matching many freeform decks. */
  paragraphs?: string[];
  imageDataUri?: string;
  imageOnLeft?: boolean;
  bodyStyle?: DeckSlideContext["bodyStyle"];
  layoutTheme?: DeckSlideContext["layoutTheme"];
  kicker?: string;
};

function cleanText(raw: string): string {
  return raw
    .replace(/\[[^\]]*]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    // Photo / image credit parentheticals: "(Photo: X - Wikipedia/Public Domain)"
    .replace(/\((?:photo|image|img|picture|credit|source)s?\s*:[^)]*\)/gi, "")
    // Scraper labels like "Content:" / "Excerpt:" at the start of a chunk.
    .replace(/\b(?:content|title|description|caption|excerpt|snippet)\s*:\s*/gi, "")
    // Markdown residue: headings, bold/italics, list markers, table pipes.
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*+/g, " ")
    .replace(/[_`|>]+/g, " ")
    // Table-of-contents anchor fragments: "#camp-nou-experience)" (keep "#1").
    .replace(/#[A-Za-z][\w-]*\)?/g, "")
    // Leftover empty parens/brackets after the removals above.
    .replace(/[([{]\s*[)\]}]/g, "")
    .replace(/(?:\(\s*)+(?=[A-Z#])/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Junk sentences that must never become slide copy. */
const WEB_NOISE_SENTENCE =
  /cookie|subscribe|sign\s*up|privacy policy|public domain|wikipedia|wikimedia|getty|shutterstock|unsplash|flickr|\bphoto\b|\bcredit\b|here are other|read more|click here|see also|all rights reserved|terms of (?:use|service)|table of contents|\bexcerpt\b|\bsource\s*:|physical address|\b[\w-]+\.(?:com|net|org|io|co|id|uk)\b|\bI['’]?m?\b|\bwe['’](?:ve|re)\b|\bmy\b|as mentioned (?:earlier|above|before)/i;

/** Normalize a sentence for duplicate detection across merged web sources. */
function dedupeKey(sentence: string): string {
  return sentence.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 80);
}

/** True when a cleaned sentence reads like standalone slide-ready prose. */
function isUsableCopy(s: string): boolean {
  if (s.length < 40 || s.length > 220) return false;
  if (!/^[A-Z0-9“"']/.test(s)) return false;
  // Complete sentence, not a truncated excerpt or heading.
  if (!/[.!?]["”']?$/.test(s)) return false;
  const letters = (s.match(/[a-zA-Z]/g) ?? []).length;
  if (letters / s.length <= 0.72) return false;
  // Unbalanced parens mean we caught a fragment of a larger structure.
  if ((s.match(/\(/g) ?? []).length !== (s.match(/\)/g) ?? []).length) return false;
  return !WEB_NOISE_SENTENCE.test(s);
}

function parseSlideJson(raw: string): {
  summary: string;
  bullets: string[];
  paragraphs: string[];
} | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace?.[0]) candidates.push(brace[0]);

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as {
        summary?: unknown;
        bullets?: unknown;
        paragraphs?: unknown;
      };
      const summary = typeof obj.summary === "string" ? cleanText(obj.summary) : "";
      // Weak local models sometimes echo scraper noise from the web context;
      // reject those lines but keep short legit bullets.
      const noEcho = (b: string) => !WEB_NOISE_SENTENCE.test(b);
      const bullets = Array.isArray(obj.bullets)
        ? obj.bullets
            .filter((b): b is string => typeof b === "string")
            .map((b) => cleanText(b))
            .filter((b) => b.length >= 12 && noEcho(b))
            .slice(0, 6)
        : [];
      const paragraphs = Array.isArray(obj.paragraphs)
        ? obj.paragraphs
            .filter((b): b is string => typeof b === "string")
            .map((b) => cleanText(b))
            .filter((b) => b.length >= 20 && noEcho(b))
            .slice(0, 4)
        : [];
      if (summary || bullets.length > 0 || paragraphs.length > 0) {
        return {
          summary: summary || paragraphs[0] || bullets[0] || "",
          bullets,
          paragraphs,
        };
      }
    } catch {
      /* next */
    }
  }
  return null;
}

/** Build slide copy from web snippets when the chat model isn't available. */
export function extractCopyFromWebContext(
  title: string,
  webContext: string
): { summary: string; bullets: string[]; paragraphs: string[] } {
  const needle = title
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 4);

  // Process each line independently: formatted contexts are records with
  // metadata lines ("Source: …", "Excerpt: …") and joining lines would glue
  // truncated excerpts, headings, and footers into Franken-sentences.
  const seen = new Set<string>();
  const sentences: string[] = [];
  for (const line of webContext.split(/\n+/)) {
    // Metadata-only lines from the formatted search context.
    if (/^\s*(?:source|url|link|query|result\s*\d*)\s*[:-]/i.test(line)) continue;
    const cleaned = cleanText(line);
    if (cleaned.length < 40) continue;
    for (const raw of cleaned.split(/(?<=[.!?])\s+/)) {
      const s = raw.trim();
      if (!isUsableCopy(s)) continue;
      // Merged search + extract contexts repeat sentences — keep the first.
      const key = dedupeKey(s);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      sentences.push(s);
    }
  }

  const scored = sentences
    .map((s) => {
      const lower = s.toLowerCase();
      const hit = needle.reduce((n, w) => (lower.includes(w) ? n + 1 : n), 0);
      return { s, hit };
    })
    .sort((a, b) => b.hit - a.hit || b.s.length - a.s.length);

  const picked = scored.map((x) => x.s).slice(0, 6);
  // Keep paragraphs and bullets disjoint so decks rendering both never show
  // the same sentence twice.
  const paragraphs = picked.slice(0, 2);
  const bullets = picked.slice(2, 6);
  const summary =
    paragraphs[0] ||
    `Discover more about ${title} — a standout stop for travelers exploring this destination.`;
  return { summary, bullets, paragraphs };
}

function deckBrief(deck?: DeckSlideContext | null): string {
  if (!deck) return "";
  const parts: string[] = [];
  if (deck.presentationRequest) {
    parts.push(`ORIGINAL USER REQUEST (deck purpose):\n${deck.presentationRequest}`);
  }
  if (deck.deckTitle) {
    parts.push(`PRESENTATION TITLE:\n${deck.deckTitle}`);
  }
  if (deck.slideTitles.length) {
    parts.push(`EXISTING SLIDES:\n- ${deck.slideTitles.join("\n- ")}`);
  }
  if (deck.styleSamples.length) {
    parts.push(
      `STYLE SAMPLES FROM THIS DECK (match tone & density):\n${deck.styleSamples.join("\n\n")}`
    );
  }
  return parts.join("\n\n");
}

/**
 * Neutral keyword queries for a slide topic. Prefer a caller-supplied query
 * (from the edit planner) when present; otherwise search the topic itself plus
 * a light deck-theme keyword — never the old travel/visitor boilerplate.
 */
function researchQueries(
  topic: string,
  deck?: DeckSlideContext | null,
  preferredQuery?: string | null
): string[] {
  const primary =
    preferredQuery?.trim().slice(0, 120) || topic.trim().slice(0, 120);
  if (!primary) return [];

  const themeBits = (
    deck?.presentationRequest ||
    deck?.deckTitle ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  const secondary =
    themeBits && !primary.toLowerCase().includes(themeBits.toLowerCase())
      ? `${primary} ${themeBits}`.slice(0, 120)
      : null;

  return secondary && secondary !== primary ? [primary, secondary] : [primary];
}

/** Transient cloud conditions worth retrying / falling back to local for. */
const TRANSIENT_CLOUD_ERROR =
  /\bbusy\b|overloaded|rate limit|too many requests|\b429\b|\b502\b|\b503\b|stopped sending tokens|took too long|timed?\s*out/i;

function isAbortLike(err: unknown): boolean {
  return (
    (err instanceof DOMException || err instanceof Error) &&
    err.name === "AbortError"
  );
}

function streamSynthesisOnce(
  messages: Array<{ role: "system" | "user"; content: string }>,
  forceLocal: boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = "";
    let settled = false;
    streamChatByMode({
      messages,
      intent: "quick_chat",
      containsFileContext: false,
      disableThinking: true,
      forceLocal,
      generationOptions: { maxTokens: 550, temperature: 0.35 },
      onChunk: (chunk) => {
        content += chunk;
      },
      onThinking: () => {},
      onFinish: () => {
        if (settled) return;
        settled = true;
        resolve(content);
      },
      onError: (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    });
  });
}

async function synthesizeSlideFromWebContext(
  title: string,
  webContext: string,
  deck: DeckSlideContext | null | undefined,
  onStatus?: (message: string) => void
): Promise<{ summary: string; bullets: string[]; paragraphs: string[] } | null> {
  onStatus?.(`Writing on-theme slide copy for “${title}”…`);
  const bodyStyle = deck?.bodyStyle ?? "paragraphs";
  const brief = deckBrief(deck);

  const messages: Array<{ role: "system" | "user"; content: string }> = [
    {
      role: "system",
      content:
        webPresentationGroundingPreamble() +
        `You write ONE new slide that belongs in an EXISTING presentation.\n` +
        `Match the deck's purpose, audience, and voice — not a generic encyclopedia entry.\n` +
        `If the deck is about places to visit / travel, write visitor-oriented copy ` +
        `(why go, what to experience, atmosphere, tips) — NOT sports stats, capacity tables, or match history unless a traveler would care.\n` +
        `Reply with ONLY JSON (no markdown):\n` +
        `{"summary":"1 short hook sentence","paragraphs":["...","..."],"bullets":["...","..."]}\n` +
        `- summary: 1 sentence in the same voice as existing slides.\n` +
        `- paragraphs: 2 short travel-style paragraphs when bodyStyle is paragraphs/mixed; else [].\n` +
        `- bullets: 3-4 short visitor highlights when bodyStyle is bullets/mixed; else [].\n` +
        `- Preferred bodyStyle for this deck: ${bodyStyle}.\n` +
        `- Use ONLY facts supported by WEB RESEARCH.\n` +
        `- No URLs, citations, capacity trivia dumps, or sports-finals lists.\n` +
        `- Keep formatting plain text suitable for the existing HTML theme.`,
    },
    {
      role: "user",
      content:
        `${brief}\n\n` +
        `NEW SLIDE TOPIC (must fit the deck above): ${title}\n\n` +
        `WEB RESEARCH:\n${webContext.slice(0, 12000)}`,
    },
  ];

  // Cloud-first with one retry on transient "busy" errors, then the local
  // model. A local answer still beats the raw web-text extraction fallback,
  // so this background call ignores the strict no-local-fallback chat policy.
  const attempts: Array<{ forceLocal: boolean; delayMs: number }> = [
    { forceLocal: false, delayMs: 0 },
    { forceLocal: false, delayMs: 1500 },
    { forceLocal: true, delayMs: 0 },
  ];

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (attempt.delayMs > 0) {
      await new Promise((r) => setTimeout(r, attempt.delayMs));
    }
    try {
      const content = await streamSynthesisOnce(messages, attempt.forceLocal);
      const parsed = parseSlideJson(content);
      if (parsed) return parsed;
      console.warn(
        `Slide web synthesis returned unparseable output (attempt ${i + 1})`
      );
    } catch (err) {
      if (isAbortLike(err)) return null;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Slide web synthesis failed (attempt ${i + 1}):`, msg);
      // A cloud retry only helps for transient errors — otherwise jump
      // straight to the local attempt.
      if (!attempt.forceLocal && !TRANSIENT_CLOUD_ERROR.test(msg)) {
        const localIdx = attempts.findIndex((a) => a.forceLocal);
        if (localIdx > i) i = localIdx - 1;
      }
    }
  }
  return null;
}

/** True when the slide needs web research (topic title, no user-provided bullets). */
export function slideNeedsWebEnrichment(spec: {
  title: string;
  bullets: string[];
}): boolean {
  if (spec.bullets.length > 0) return false;
  if (/thank\s*you|thanks|new slide|untitled/i.test(spec.title)) return false;
  return spec.title.trim().length >= 2;
}

/**
 * Research `topic` in the context of the open deck and return on-theme slide copy.
 * Optional `searchQuery` / `searchDepth` let the edit planner drive the search
 * with its own wording instead of the neutral topic defaults.
 */
export async function enrichSlideTopicFromWeb(
  topic: string,
  onStatus?: (message: string) => void,
  deck?: DeckSlideContext | null,
  options?: { searchQuery?: string | null; searchDepth?: WebToolDepth }
): Promise<EnrichedSlideContent> {
  const title = topic.trim();
  const queries = researchQueries(title, deck, options?.searchQuery);
  const depth = options?.searchDepth ?? "full";

  onStatus?.(`Searching the web for “${queries[0] || title}”…`);
  let merged: WebSearchResult | null = null;
  try {
    const primary = await runWebSearchWithDepth({
      query: queries[0] || title,
      depth,
      messages: [
        {
          role: "user",
          content:
            (deck?.presentationRequest
              ? `${deck.presentationRequest}\n\n`
              : "") + `Add a slide about ${title} to this presentation.`,
        },
      ],
      onToolStatus: onStatus
        ? (status) => {
            if (status != null) onStatus(status);
          }
        : undefined,
    });
    merged = primary;

    if (queries[1]) {
      try {
        const secondary = await Api.webSearch(queries[1], 5, {
          profile: "research",
        });
        merged = mergeWebSearchResults(merged, secondary);
      } catch (err) {
        console.warn("Secondary slide web query failed:", err);
      }
    }
  } catch (err) {
    console.warn("Slide topic web search failed:", err);
    return {
      title,
      summary: "",
      bullets: [],
      paragraphs: [
        `${title} is a memorable stop for travelers exploring this destination.`,
      ],
      imageOnLeft: deck?.imageOnLeft,
      bodyStyle: deck?.bodyStyle,
      layoutTheme: deck?.layoutTheme,
      kicker: deck?.kickerPrefix,
    };
  }

  let webContext = merged.formatted_context?.trim() || "";
  const urls = (merged.results ?? [])
    .map((r) => r.url)
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 3);
  if (urls.length > 0) {
    onStatus?.(`Reading sources for “${title}”…`);
    try {
      const extracted = await Api.webExtract(
        urls,
        title,
        "basic"
      );
      if (extracted.formatted_context?.trim()) {
        webContext = [webContext, extracted.formatted_context.trim()]
          .filter(Boolean)
          .join("\n\n");
      }
      if (extracted.results?.length) {
        merged = mergeWebSearchResults(merged, {
          query: title,
          results: merged.results,
          formatted_context: extracted.formatted_context,
          images: extracted.results.flatMap((r) => r.images ?? []),
        });
      }
    } catch (err) {
      console.warn("Slide topic web extract failed:", err);
    }
  }

  let summary = "";
  let bullets: string[] = [];
  let paragraphs: string[] = [];

  if (webContext.trim()) {
    const synthesized = await synthesizeSlideFromWebContext(
      title,
      webContext,
      deck,
      onStatus
    );
    if (synthesized) {
      summary = synthesized.summary;
      bullets = synthesized.bullets;
      paragraphs = synthesized.paragraphs;
    }
  }

  // If the model isn't ready, still expand from raw web text (no local LLM).
  if (!summary && paragraphs.length === 0 && bullets.length === 0 && webContext.trim()) {
    const extracted = extractCopyFromWebContext(title, webContext);
    summary = extracted.summary;
    bullets = extracted.bullets;
    paragraphs = extracted.paragraphs;
  }

  if (!summary && paragraphs.length === 0 && bullets.length === 0) {
    paragraphs = [
      `Visit ${title} as part of your journey — a highlight that fits this guide’s focus on places worth experiencing firsthand.`,
    ];
    summary = paragraphs[0];
  }

  onStatus?.(`Finding an image for “${title}”…`);
  let imageDataUri: string | undefined;
  try {
    const pool = await buildArtifactImagePool({
      webHits: merged.results,
      galleryUrls: merged.images,
      maxImages: 1,
    });
    imageDataUri = pool[0]?.data_uri;
  } catch (err) {
    console.warn("Slide topic image download failed:", err);
  }

  return {
    title,
    summary: summary.slice(0, 280),
    bullets: bullets.slice(0, 5),
    paragraphs: paragraphs.slice(0, 4),
    imageDataUri,
    imageOnLeft: deck?.imageOnLeft ?? true,
    bodyStyle: deck?.bodyStyle ?? "paragraphs",
    layoutTheme: deck?.layoutTheme ?? "generic",
    kicker: deck?.kickerPrefix || "Place to visit",
  };
}
