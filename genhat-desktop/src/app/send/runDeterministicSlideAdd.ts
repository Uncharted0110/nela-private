import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import {
  editedOutputName,
  isNelaPresentationDeckHtml,
  isPresentationSlideAddRequest,
  parseAddSlideFromPrompt,
  parseSlideInsertIndex,
} from "../artifactEdit";
import {
  countFreeformSlides,
  insertSlideIntoFreeformHtml,
  isHtmlSlideDeck,
} from "./freeformHtmlSlideEdit";
import {
  enrichSlideTopicFromWeb,
  slideNeedsWebEnrichment,
} from "./enrichSlideTopicFromWeb";
import { buildDeckSlideContext } from "./deckSlideContext";
import type { SendHandlerContext } from "./types";
import { friendlyErrorFromUnknown } from "../friendlyError";

/**
 * Deterministic slide insert — no LLM for layout. Topic slides ("about X")
 * are enriched via web search before insert.
 */
export async function runDeterministicSlideAdd(
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
  if (!isPresentationSlideAddRequest(text)) return false;

  updateEditMsg("SearchingDisk");
  const lower = artifactPath.toLowerCase();
  const isPptx = lower.endsWith(".pptx") || lower.endsWith(".ppt");

  const session = ctx.sessions.find((s) => s.id === sid) ?? null;

  const enrichIfNeeded = async (
    slideSpec: ReturnType<typeof parseAddSlideFromPrompt>,
    deckHtml?: string,
    insertIndex?: number
  ) => {
    const deck = buildDeckSlideContext({
      html: deckHtml,
      session,
      insertIndex,
    });
    if (!slideNeedsWebEnrichment(slideSpec)) {
      return {
        title: slideSpec.title,
        bullets: slideSpec.bullets,
        paragraphs: undefined as string[] | undefined,
        summary: undefined as string | undefined,
        imageDataUri: undefined as string | undefined,
        imageOnLeft: deck.imageOnLeft,
        bodyStyle: deck.bodyStyle,
        layoutTheme: deck.layoutTheme,
        kicker: deck.kickerPrefix,
        layout: slideSpec.layout,
      };
    }
    updateEditMsg(
      "CrunchingMetrics",
      null,
      `Researching **${slideSpec.title}** for this deck…`
    );
    const enriched = await enrichSlideTopicFromWeb(
      slideSpec.title,
      (msg) => updateEditMsg("CrunchingMetrics", null, msg),
      deck
    );
    return {
      title: enriched.title,
      bullets: enriched.bullets,
      paragraphs: enriched.paragraphs,
      summary: enriched.summary,
      imageDataUri: enriched.imageDataUri,
      imageOnLeft: enriched.imageOnLeft,
      bodyStyle: enriched.bodyStyle,
      layoutTheme: enriched.layoutTheme,
      kicker: enriched.kicker,
      layout: slideSpec.layout,
    };
  };

  // Freeform / NELA HTML: prefer in-place HTML surgery when the file is a slide deck.
  if (!isPptx && (lower.endsWith(".html") || lower.endsWith(".htm"))) {
    let html: string;
    try {
      html = await Api.readFileText(artifactPath);
    } catch (err: unknown) {
      console.warn("Deterministic slide-add read failed:", err);
      return false;
    }

    if (isNelaPresentationDeckHtml(html)) {
      // Fall through to parsePresentationDeck + editPresentationDeck below.
    } else {
      // Freeform HTML — never call the NELA/PPTX parser.
      if (!isHtmlSlideDeck(html)) {
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          "Couldn't find `.slide` sections in this HTML page, so I can't add a slide."
        );
        return true;
      }
      const slideCount = countFreeformSlides(html);
      const position = parseSlideInsertIndex(text, slideCount);
      const slideSpec = parseAddSlideFromPrompt(text, position.index);
      const filled = await enrichIfNeeded(slideSpec, html, position.index);
      const outputName = editedOutputName(artifactPath);

      updateEditMsg("WritingCode", null, `Adding **${filled.title}**…`);
      try {
        const next = insertSlideIntoFreeformHtml(
          html,
          {
            title: filled.title,
            bullets: filled.bullets,
            paragraphs: filled.paragraphs,
            summary: filled.summary,
            imageDataUri: filled.imageDataUri,
            imageOnLeft: filled.imageOnLeft,
            bodyStyle: filled.bodyStyle,
            layoutTheme: filled.layoutTheme,
            kicker: filled.kicker,
          },
          position.index
        );
        const newPath = await Api.writeArtifactCopy(artifactPath, next, outputName);
        ctx.updateSession(sid, {
          loading: false,
          artifactPath: newPath,
          artifactStage: "LivePreview",
          artifactPanelOpen: true,
          streamingArtifactHtml: next,
        });
        const filename = newPath.split(/[/\\]/).pop();
        const factNote =
          filled.bullets.length > 0
            ? ` with ${filled.bullets.length} web facts`
            : "";
        updateEditMsg(
          "LivePreview",
          newPath,
          `Added slide ${position.label}: **${filled.title}**${factNote} (${filename})`
        );
        return true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("Freeform slide-add failed:", message);
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          friendlyErrorFromUnknown(`Failed to add slide: ${message}`)
        );
        return true;
      }
    }
  }

  let parsedDeck: Awaited<ReturnType<typeof Api.parsePresentationDeck>>;
  try {
    parsedDeck = await Api.parsePresentationDeck(artifactPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("Deterministic slide-add parse failed:", message);
    return false;
  }

  const position = parseSlideInsertIndex(text, parsedDeck.slideCount);
  const slideSpec = parseAddSlideFromPrompt(text, position.index);
  let deckHtmlForContext: string | undefined;
  if (!isPptx) {
    try {
      deckHtmlForContext = await Api.readFileText(artifactPath);
    } catch {
      /* style samples optional */
    }
  }
  const filled = await enrichIfNeeded(
    slideSpec,
    deckHtmlForContext,
    position.index
  );
  const outputName = editedOutputName(artifactPath);

  updateEditMsg("WritingCode", null, `Adding **${filled.title}**…`);
  try {
    const result = isPptx
      ? await Api.applyPresentationOps({
          path: artifactPath,
          outputName,
          ops: [
            {
              op: "insert_slide",
              index: position.index,
              title: filled.title,
              layout: filled.layout,
              bullets: filled.bullets,
            },
          ],
        })
      : await Api.editPresentationDeck({
          path: artifactPath,
          appendSlides: [
            {
              title: filled.title,
              layout: filled.layout,
              bullets: filled.bullets,
            },
          ],
          insertAt: position.index,
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
      `Added slide ${position.label}: **${filled.title}** (${filename})`
    );
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("Deterministic slide-add apply failed:", message);
    ctx.updateSession(sid, { loading: false });
    updateEditMsg(
      "Error",
      null,
      friendlyErrorFromUnknown(`Failed to add slide: ${message}`)
    );
    // Handled — don't fall through to an LLM path that needs a warm model.
    return true;
  }
}
