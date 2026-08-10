/**
 * Deterministic "increase / expand content of slide N" — web research, no local model.
 */

import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import {
  editedOutputName,
  isNelaPresentationDeckHtml,
  isPresentationSlideExpandRequest,
  parseSlideExpandIndex,
} from "../artifactEdit";
import {
  countFreeformSlides,
  expandSlideInFreeformHtml,
  getFreeformSlideBlock,
  isHtmlSlideDeck,
  listFreeformSlideTitles,
} from "./freeformHtmlSlideEdit";
import { enrichSlideTopicFromWeb } from "./enrichSlideTopicFromWeb";
import { buildDeckSlideContext } from "./deckSlideContext";
import type { SendHandlerContext } from "./types";
import { friendlyErrorFromUnknown } from "../friendlyError";

function mergeUnique(existing: string[], incoming: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of [...existing, ...incoming]) {
    const key = s.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s.trim());
    if (out.length >= max) break;
  }
  return out;
}

function existingBulletsFromBlock(block: string): string[] {
  return [...block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 8);
}

function existingParagraphsFromBlock(block: string): string[] {
  return [...block.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)]
    .filter((m) => !/\bkicker\b/i.test(m[1]) && !/\bkicker\b/i.test(m[0]))
    .map((m) => m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 20);
}

export async function runDeterministicSlideExpand(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  updateEditMsg: (
    stage: PipelineStageKind,
    path?: string | null,
    contentOverride?: string
  ) => void
): Promise<boolean> {
  if (!isPresentationSlideExpandRequest(text)) return false;

  updateEditMsg("SearchingDisk");
  const lower = artifactPath.toLowerCase();
  const isPptx = lower.endsWith(".pptx") || lower.endsWith(".ppt");
  const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");
  const outputName = editedOutputName(artifactPath);
  const session = ctx.sessions.find((s) => s.id === sid) ?? null;

  if (!isPptx && isHtml) {
    let html: string;
    try {
      html = await Api.readFileText(artifactPath);
    } catch (err: unknown) {
      console.warn("Deterministic slide-expand read failed:", err);
      return false;
    }

    if (!isNelaPresentationDeckHtml(html)) {
      const slideCount = countFreeformSlides(html);
      if (!isHtmlSlideDeck(html) && slideCount < 1) {
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          "Couldn't find `.slide` sections to expand."
        );
        return true;
      }

      const titles = listFreeformSlideTitles(html);
      const target = parseSlideExpandIndex(
        text,
        titles.length || slideCount,
        titles
      );
      if (!target) {
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          "Couldn't tell which slide to expand. Try “increase the content of slide 9”."
        );
        return true;
      }

      const title = (titles[target.index] || `Slide ${target.index + 1}`).trim();
      const deck = buildDeckSlideContext({
        html,
        session,
        insertIndex: target.index,
      });
      const block = getFreeformSlideBlock(html, target.index);
      const existingBullets = existingBulletsFromBlock(block);
      const existingParas = existingParagraphsFromBlock(block);

      updateEditMsg(
        "CrunchingMetrics",
        null,
        `Expanding **${title}** with more web-backed detail…`
      );
      const enriched = await enrichSlideTopicFromWeb(
        title,
        (msg) => updateEditMsg("CrunchingMetrics", null, msg),
        deck
      );

      const bullets = mergeUnique(existingBullets, enriched.bullets ?? [], 6);
      const paragraphs = mergeUnique(
        existingParas,
        enriched.paragraphs?.length
          ? enriched.paragraphs
          : enriched.summary
            ? [enriched.summary]
            : [],
        4
      );

      updateEditMsg("WritingCode", null, `Updating ${target.label}…`);
      try {
        const next = expandSlideInFreeformHtml(html, target.index, {
          title,
          bullets,
          paragraphs,
          summary: enriched.summary || paragraphs[0],
          bodyStyle:
            bullets.length >= Math.max(1, paragraphs.length)
              ? "bullets"
              : deck.bodyStyle,
          layoutTheme: deck.layoutTheme,
          kicker: enriched.kicker || deck.kickerPrefix,
          preserveImage: true,
        });
        const newPath = await Api.writeArtifactCopy(
          artifactPath,
          next,
          outputName
        );
        ctx.updateSession(sid, {
          loading: false,
          artifactPath: newPath,
          artifactStage: "LivePreview",
          artifactPanelOpen: true,
          streamingArtifactHtml: next,
        });
        const filename = newPath.split(/[/\\]/).pop();
        updateEditMsg(
          "LivePreview",
          newPath,
          `Expanded ${target.label} (**${title}**) with more detail (${filename})`
        );
        return true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          friendlyErrorFromUnknown(`Failed to expand slide: ${message}`)
        );
        return true;
      }
    }
  }

  // NELA / PPTX — patch_slide with richer bullets.
  let parsed: Awaited<ReturnType<typeof Api.parsePresentationDeck>>;
  try {
    parsed = await Api.parsePresentationDeck(artifactPath);
  } catch (err: unknown) {
    console.warn("Deterministic slide-expand parse failed:", err);
    return false;
  }

  const titles = (parsed.slides ?? []).map((s) =>
    String((s as { title?: string }).title ?? "")
  );
  const target = parseSlideExpandIndex(text, parsed.slideCount, titles);
  if (!target) {
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      "Couldn't tell which slide to expand. Try “increase the content of slide 9”."
    );
    return true;
  }

  const slide = parsed.slides[target.index] as {
    title?: string;
    bullets?: string[];
  };
  const title = String(slide?.title || titles[target.index] || "Slide").trim();
  const existing = Array.isArray(slide?.bullets)
    ? slide.bullets.map(String).filter(Boolean)
    : [];

  let deckHtml: string | undefined;
  if (!isPptx) {
    try {
      deckHtml = await Api.readFileText(artifactPath);
    } catch {
      /* optional */
    }
  }
  const deck = buildDeckSlideContext({
    html: deckHtml,
    session,
    insertIndex: target.index,
  });

  updateEditMsg(
    "CrunchingMetrics",
    null,
    `Expanding **${title}** with more web-backed detail…`
  );
  const enriched = await enrichSlideTopicFromWeb(
    title,
    (msg) => updateEditMsg("CrunchingMetrics", null, msg),
    deck
  );
  const bullets = mergeUnique(
    existing,
    [
      ...(enriched.bullets ?? []),
      ...(enriched.paragraphs ?? []),
      ...(enriched.summary ? [enriched.summary] : []),
    ],
    6
  );

  updateEditMsg("WritingCode", null, `Updating ${target.label}…`);
  try {
    const result = await Api.applyPresentationOps({
      path: artifactPath,
      ops: [
        {
          op: "patch_slide",
          index: target.index,
          title,
          bullets,
        },
      ],
      outputName,
    });
    ctx.updateSession(sid, {
      loading: false,
      artifactPath: result.path,
      artifactStage: "LivePreview",
      artifactPanelOpen: true,
    });
    const filename = result.path.split(/[/\\]/).pop();
    updateEditMsg(
      "LivePreview",
      result.path,
      `Expanded ${target.label} (**${title}**) with more detail (${filename})`
    );
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      friendlyErrorFromUnknown(`Failed to expand slide: ${message}`)
    );
    return true;
  }
}
