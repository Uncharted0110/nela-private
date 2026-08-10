import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import {
  editedOutputName,
  isPresentationSlideAddRequest,
  parseAddSlideFromPrompt,
  parseSlideInsertIndex,
} from "../artifactEdit";
import { parseArtifactPlanJson } from "../artifactPlanJson";
import { normalizePresentationPlan } from "../artifactPlanNormalize";
import { inferPresentationTheme } from "./presentationTheme";
import { repairNestedKeys } from "./repairNestedKeys";
import { streamChatByMode, willRouteToCloud } from "./cloudOrLocalStream";
import type { GenerationOptions, SendHandlerContext } from "./types";
import { friendlyErrorFromUnknown } from "../friendlyError";

export async function runPresentationDeckEdit(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  generationOptions: GenerationOptions,
  updateEditMsg: (
    stage: PipelineStageKind,
    path?: string | null,
    contentOverride?: string
  ) => void
): Promise<void> {
  const outputName = editedOutputName(artifactPath);

  // Fast path: insert slide(s) deterministically — no LLM, no diff patch.
  if (isPresentationSlideAddRequest(text)) {
    updateEditMsg("SearchingDisk");
    let parsedDeck: Awaited<ReturnType<typeof Api.parsePresentationDeck>>;
    try {
      parsedDeck = await Api.parsePresentationDeck(artifactPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.updateSession(sid, { loading: false });
      updateEditMsg("Error", null, friendlyErrorFromUnknown(`Could not parse presentation deck: ${message}`));
      return;
    }

    const position = parseSlideInsertIndex(text, parsedDeck.slideCount);
    const slideSpec = parseAddSlideFromPrompt(text, position.index);

    updateEditMsg("WritingCode");
    try {
      const result = await Api.editPresentationDeck({
        path: artifactPath,
        appendSlides: [
          {
            title: slideSpec.title,
            layout: slideSpec.layout,
            bullets: slideSpec.bullets,
          },
        ],
        insertAt: position.index,
        outputName,
      });
      ctx.updateSession(sid, { loading: false });
      const filename = result.path.split(/[/\\]/).pop();
      updateEditMsg(
        "LivePreview",
        result.path,
        `Added slide ${position.label}: **${slideSpec.title}** (${filename})`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.updateSession(sid, { loading: false });
      updateEditMsg("Error", null, friendlyErrorFromUnknown(`Failed to add slide: ${message}`));
    }
    return;
  }

  updateEditMsg("SearchingDisk");
  let parsedDeck: Awaited<ReturnType<typeof Api.parsePresentationDeck>>;
  try {
    parsedDeck = await Api.parsePresentationDeck(artifactPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.updateSession(sid, { loading: false });
    updateEditMsg("Error", null, friendlyErrorFromUnknown(`Could not parse presentation deck: ${message}`));
    return;
  }

  updateEditMsg("CrunchingMetrics");

  const useCloud = willRouteToCloud();
  const grammar = useCloud
    ? undefined
    : await Api.getSchemaGrammar("presentation_synthesis");
  const themeHint = parsedDeck.theme ?? inferPresentationTheme(text);
  const slidesJson = JSON.stringify(parsedDeck.slides);

  const systemPrompt = `You are a professional assistant that EDITS existing presentation slide decks.
Return ONLY a JSON object with the FULL updated "slides" array — no markdown fences.

EDIT RULES:
- Start from the EXISTING SLIDES below; apply the user's requested changes.
- Preserve slides and content unless the user asks to remove or replace them.
- When adding slides, insert at the position the user specifies:
  * beginning / first / starting / opening → index 0
  * end / last / closing → append after final slide
  * before slide N → insert at index N-1 (1-based slide numbers)
  * after slide N → insert at index N
  * at slide N / position N → insert at index N-1
  * between slide A and B → insert at index A (after slide A)
- Keep real names, numbers, and facts — no placeholders.
- Each slide needs: title, layout, bullets (array of strings). Optional: notes.

Schema: {"slides": [{"title": "string", "layout": "TITLE" | "BULLET" | "CENTERED" | ..., "bullets": ["string"]}], "theme": "optional"}`;

  const userPrompt = `EXISTING SLIDES (${parsedDeck.slideCount} slides, theme: ${themeHint}):
${slidesJson}

User edit request: "${text}"

Return the complete updated slides array with the requested changes applied.`;

  let planJson = "";
  await new Promise<void>((resolve, reject) => {
    streamChatByMode({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      intent: "artifact_plan",
      containsFileContext: false,
      modelId: ctx.selectedModel || undefined,
      signal: ctrl.signal,
      disableThinking: true,
      response_format: useCloud ? { type: "json_object" } : undefined,
      generationOptions: {
        ...generationOptions,
        maxTokens: 65_536,
        temperature: 0.15,
        grammar,
      },
      onChunk: (chunk) => {
        planJson += chunk;
      },
      onThinking: () => {},
      onFinish: () => {
        void (async () => {
          updateEditMsg("WritingCode");
          try {
            let planObj = parseArtifactPlanJson(planJson, {
              userPrompt: text,
              schemaId: "presentation_synthesis",
            });
            planObj = repairNestedKeys(planObj);
            planObj.theme = themeHint;
            planObj = normalizePresentationPlan(planObj, text);

            const result = await Api.editPresentationDeck({
              path: artifactPath,
              replacementPlan: planObj,
              outputName,
            });

            ctx.updateSession(sid, { loading: false });
            const filename = result.path.split(/[/\\]/).pop();
            updateEditMsg(
              "LivePreview",
              result.path,
              `Saved an updated deck copy: **${filename}** (original left unchanged).`
            );
            resolve();
          } catch (execErr: unknown) {
            const message =
              execErr instanceof Error ? execErr.message : String(execErr);
            ctx.updateSession(sid, { loading: false });
            updateEditMsg("Error", null, friendlyErrorFromUnknown(`Failed to apply deck edits: ${message}`));
            resolve();
          }
        })();
      },
      onError: (err) => {
        ctx.updateSession(sid, { loading: false });
        updateEditMsg("Error", null, friendlyErrorFromUnknown(`Failed to generate deck edit plan: ${err}`));
        reject(err);
      },
    });
  });
}