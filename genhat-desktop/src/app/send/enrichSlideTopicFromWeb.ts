/**
 * Fill an "about X" slide using presentation web research + LLM synthesis
 * grounded in the deck's original request, title, and existing slide voice.
 */

import { Api } from "../../api";
import { buildArtifactImagePool } from "../artifactImagePool";
import {
  slideTopicWebQuery,
  webPresentationGroundingPreamble,
} from "../webSearchQuery";
import { runWebSearchWithDepth } from "./webSearchDepth";
import { mergeWebSearchResults } from "./webSearchToolLoop";
import { streamChatByMode } from "./cloudOrLocalStream";
import type { DeckSlideContext } from "./deckSlideContext";
import type { WebSearchResult } from "../../types";

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
    .replace(/\s+/g, " ")
    .replace(/\[[^\]]*]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
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
      const bullets = Array.isArray(obj.bullets)
        ? obj.bullets
            .filter((b): b is string => typeof b === "string")
            .map((b) => cleanText(b))
            .filter((b) => b.length >= 12)
            .slice(0, 6)
        : [];
      const paragraphs = Array.isArray(obj.paragraphs)
        ? obj.paragraphs
            .filter((b): b is string => typeof b === "string")
            .map((b) => cleanText(b))
            .filter((b) => b.length >= 20)
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
function extractCopyFromWebContext(
  title: string,
  webContext: string
): { summary: string; bullets: string[]; paragraphs: string[] } {
  const needle = title
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 4);
  const sentences = webContext
    .split(/(?<=[.!?])\s+/)
    .map((s) => cleanText(s))
    .filter((s) => s.length >= 40 && s.length <= 220)
    .filter((s) => !/cookie|subscribe|sign up|privacy policy/i.test(s));

  const scored = sentences
    .map((s) => {
      const lower = s.toLowerCase();
      const hit = needle.reduce((n, w) => (lower.includes(w) ? n + 1 : n), 0);
      return { s, hit };
    })
    .sort((a, b) => b.hit - a.hit || b.s.length - a.s.length);

  const picked = scored.map((x) => x.s).slice(0, 6);
  const paragraphs = picked.slice(0, 3);
  const bullets = picked.slice(0, 4);
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

function researchQueries(topic: string, deck?: DeckSlideContext | null): string[] {
  const theme =
    deck?.presentationRequest ||
    deck?.deckTitle ||
    "travel destinations places to visit";
  // Tie the place to the deck theme (tourism / places), not sports trivia.
  const themed = `${topic} visit travel guide ${slideTopicWebQuery(theme)}`.slice(
    0,
    120
  );
  const place = slideTopicWebQuery(`${topic} what to see visitor experience`).slice(
    0,
    120
  );
  return [place, themed];
}

function synthesizeSlideFromWebContext(
  title: string,
  webContext: string,
  deck: DeckSlideContext | null | undefined,
  onStatus?: (message: string) => void
): Promise<{ summary: string; bullets: string[]; paragraphs: string[] } | null> {
  onStatus?.(`Writing on-theme slide copy for “${title}”…`);
  const bodyStyle = deck?.bodyStyle ?? "paragraphs";
  const brief = deckBrief(deck);

  return new Promise((resolve) => {
    let content = "";
    let settled = false;
    const finish = (
      value: { summary: string; bullets: string[]; paragraphs: string[] } | null
    ) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    streamChatByMode({
      messages: [
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
      ],
      intent: "quick_chat",
      containsFileContext: false,
      disableThinking: true,
      generationOptions: { maxTokens: 550, temperature: 0.35 },
      onChunk: (chunk) => {
        content += chunk;
      },
      onThinking: () => {},
      onFinish: () => finish(parseSlideJson(content)),
      onError: (err) => {
        console.warn("Slide web synthesis failed:", err);
        finish(null);
      },
    });
  });
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
 */
export async function enrichSlideTopicFromWeb(
  topic: string,
  onStatus?: (message: string) => void,
  deck?: DeckSlideContext | null
): Promise<EnrichedSlideContent> {
  const title = topic.trim();
  const queries = researchQueries(title, deck);

  onStatus?.(`Searching the web for “${title}” (deck-aware)…`);
  let merged: WebSearchResult | null = null;
  try {
    const primary = await runWebSearchWithDepth({
      query: queries[0],
      depth: "full",
      messages: [
        {
          role: "user",
          content:
            (deck?.presentationRequest
              ? `${deck.presentationRequest}\n\n`
              : "") + `Add a slide about ${title} to this presentation.`,
        },
      ],
      onToolStatus: onStatus,
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
        `${title} visit travel`,
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
