/**
 * Context from the open deck + chat session so slide inserts stay on-theme.
 */

import type { ChatSession } from "../../types";
import { listFreeformSlideTitles } from "./freeformHtmlSlideEdit";

/** Visual/markup theme detected from existing slides. */
export type DeckLayoutTheme = "split" | "content-layout" | "generic";

export type DeckSlideContext = {
  /** Original user ask that created / drives the deck. */
  presentationRequest: string;
  /** Deck title from <title> / hero h1 / session. */
  deckTitle: string;
  /** Existing slide titles for continuity. */
  slideTitles: string[];
  /** Short prose samples from existing slides (voice/style). */
  styleSamples: string[];
  /** Prefer paragraphs vs bullets to match neighbors. */
  bodyStyle: "paragraphs" | "bullets" | "mixed";
  /** Put image on left (like many Spain content slides). */
  imageOnLeft: boolean;
  /** Markup pattern to clone for new slides. */
  layoutTheme: DeckLayoutTheme;
  /** Optional kicker/eyebrow line used by split-theme decks. */
  kickerPrefix: string;
};

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractDeckTitle(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title && stripTags(title).length > 2) return stripTags(title);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (h1 && stripTags(h1).length > 2) return stripTags(h1);
  return "";
}

function detectLayoutTheme(html: string): DeckLayoutTheme {
  const split = (html.match(/\bclass=["'][^"']*\bsplit\b/gi) || []).length;
  const sideImg = (html.match(/\bclass=["'][^"']*\bside-img\b/gi) || []).length;
  const contentLayout = (html.match(/\bcontent-layout\b/gi) || []).length;
  if (split >= 2 && sideImg >= 2) return "split";
  if (contentLayout >= 2) return "content-layout";
  if (split >= 1 && sideImg >= 1) return "split";
  return "generic";
}

function extractStyleSamples(html: string, limit = 3): string[] {
  const samples: string[] = [];
  // Prefer themed `.text` blocks, then legacy `.text-side`.
  const textRe =
    /<div[^>]*class=["'][^"']*\b(?:text-side|text)\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = textRe.exec(html)) !== null && samples.length < limit) {
    const block = m[1];
    if (/data:image/i.test(block.slice(0, 120))) continue;
    const kicker = block.match(
      /<p[^>]*class=["'][^"']*\bkicker\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
    )?.[1];
    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
    const paras = [...block.matchAll(/<p(?![^>]*\bkicker\b)[^>]*>([\s\S]*?)<\/p>/gi)].map(
      (x) => stripTags(x[1])
    );
    const lis = [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((x) =>
      stripTags(x[1])
    );
    const title = h2 ? stripTags(h2) : "";
    const body = [...paras, ...lis].filter((t) => t.length > 20).slice(0, 3);
    if (!title && body.length === 0) continue;
    const sample = [
      kicker && `Kicker: ${stripTags(kicker)}`,
      title && `Title: ${title}`,
      ...body.map((b) => `• ${b}`),
    ]
      .filter(Boolean)
      .join("\n");
    if (sample.length > 40) samples.push(sample.slice(0, 500));
  }
  return samples;
}

function inferBodyStyle(html: string): DeckSlideContext["bodyStyle"] {
  const destList = (html.match(/\bdest-list\b/gi) || []).length;
  const lis = (html.match(/<li\b/gi) || []).length;
  const textParas = (
    html.match(/<div[^>]*\b(?:text-side|text)\b[\s\S]*?<p\b/gi) || []
  ).length;
  if (destList >= 2) return "bullets";
  if (lis >= 4 && textParas >= 2) return "mixed";
  if (lis >= textParas * 2) return "bullets";
  return "paragraphs";
}

function presentationRequestFromSession(session?: ChatSession | null): string {
  if (!session) return "";
  for (const msg of session.messages) {
    if (msg.role !== "user") continue;
    const t = (msg.content || "").trim();
    if (t.length < 8) continue;
    if (/^(add|insert|remove|delete|change|edit)\b/i.test(t)) continue;
    return t.slice(0, 400);
  }
  return (session.streamingArtifactTitle || session.title || "").trim();
}

/**
 * Build deck-aware context for synthesizing a new slide.
 */
export function buildDeckSlideContext(options: {
  html?: string;
  session?: ChatSession | null;
  insertIndex?: number;
}): DeckSlideContext {
  const html = options.html || "";
  const slideTitles = html ? listFreeformSlideTitles(html) : [];
  const styleSamples = html ? extractStyleSamples(html) : [];
  const layoutTheme = html ? detectLayoutTheme(html) : "generic";
  const deckTitle =
    extractDeckTitle(html) ||
    options.session?.streamingArtifactTitle?.trim() ||
    options.session?.title?.trim() ||
    "";
  const presentationRequest = presentationRequestFromSession(options.session);
  // split-theme decks usually put text left / image right.
  const imageOnLeft =
    layoutTheme === "split"
      ? false
      : (options.insertIndex ?? slideTitles.length) % 2 === 1;

  return {
    presentationRequest,
    deckTitle,
    slideTitles: slideTitles.filter(Boolean).slice(0, 12),
    styleSamples,
    bodyStyle: html ? inferBodyStyle(html) : "paragraphs",
    imageOnLeft,
    layoutTheme,
    kickerPrefix: "Place to visit",
  };
}
