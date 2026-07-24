import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import {
  editedOutputName,
  MAX_PATCH_SOURCE_CHARS,
  truncateForPatchEdit,
} from "../artifactEdit";
import { parseArtifactPlanJson } from "../artifactPlanJson";
import { normalizePresentationPlan } from "../artifactPlanNormalize";
import {
  formatAmbientFileSection,
  loadAmbientFileBody,
  MAX_ARTIFACT_SOURCE_CHARS,
} from "../ambientFileContent";
import { inferPresentationTheme } from "./presentationTheme";
import { repairNestedKeys } from "./repairNestedKeys";
import { streamChatByMode, willRouteToCloud } from "./cloudOrLocalStream";
import type { GenerationOptions, SendHandlerContext } from "./types";

export async function runPresentationArtifactEdit(
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
  updateEditMsg("SearchingDisk");

  let sourceContext = "";
  if (artifactPath.endsWith(".html") || artifactPath.endsWith(".htm")) {
    const html = await Api.readFileText(artifactPath);
    sourceContext = truncateForPatchEdit(html, MAX_PATCH_SOURCE_CHARS);
  } else {
    const body = await loadAmbientFileBody(artifactPath, MAX_ARTIFACT_SOURCE_CHARS);
    sourceContext = formatAmbientFileSection(artifactPath, body);
  }

  updateEditMsg("CrunchingMetrics");

  const useCloud = willRouteToCloud({
    containsFileContext: Boolean(sourceContext.trim()),
  });
  const grammar = useCloud
    ? undefined
    : await Api.getSchemaGrammar("presentation_synthesis");
  const themeHint = inferPresentationTheme(text);
  const outputName = editedOutputName(artifactPath);

  const systemPrompt = `You are a professional assistant that EDITS existing presentations via a JSON slide plan.
Return ONLY JSON — no markdown fences or explanations.

EDIT MODE RULES:
- Start from the EXISTING content below; apply the user's requested changes.
- Preserve slide order and topics unless the user asks to add, remove, or reorder slides.
- Keep real names, numbers, and facts from the source — do not replace with placeholders.
- When adding slides, pick varied layouts (BULLET, STAT, CARDS, COMPARISON, etc.).

Schema: {"slides": [{"title": "string", "layout": "TITLE" | "SECTION" | "BULLET" | "TWO_COLUMN" | "IMAGE_LEFT" | "STAT" | "QUOTE" | "CARDS" | "COMPARISON" | "CENTERED" | "BLANK", "bullets": ["string"], "notes": "string"}], "theme": "midnight" | "corporate" | "sunset" | "minimal" | "academic" | "cyber" | "ocean" | "forest" | "lavender" | "neon" | "rose" | "slate"}`;

  const userPrompt = `=== EXISTING PRESENTATION CONTENT (authoritative baseline) ===
${sourceContext}
=== END EXISTING CONTENT ===

User edit request: "${text}"

Produce an updated presentation plan that applies these edits. Use the "${themeHint}" theme unless the user specifies another style.`;

  let planJson = "";
  await new Promise<void>((resolve, reject) => {
    streamChatByMode({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      intent: "artifact_plan",
      containsFileContext: Boolean(sourceContext.trim()),
      contextSource: "artifact_edit",
      modelId: ctx.selectedModel || undefined,
      signal: ctrl.signal,
      disableThinking: true,
      response_format: useCloud ? { type: "json_object" } : undefined,
      generationOptions: {
        ...generationOptions,
        maxTokens: 6144,
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
            planObj.output_name = outputName;

            const result = await Api.generatePresentation(planObj);
            ctx.updateSession(sid, { loading: false });
            const filename = result.path.split(/[/\\]/).pop();
            updateEditMsg(
              "LivePreview",
              result.path,
              `Updated presentation: **${filename}**\nPath: \`${result.path}\``
            );
            resolve();
          } catch (execErr: unknown) {
            const message =
              execErr instanceof Error ? execErr.message : String(execErr);
            ctx.updateSession(sid, { loading: false });
            updateEditMsg(
              "Error",
              null,
              `Failed to apply presentation edits: ${message}`
            );
            resolve();
          }
        })();
      },
      onError: (err) => {
        ctx.updateSession(sid, { loading: false });
        updateEditMsg(
          "Error",
          null,
          `Failed to generate presentation edit plan: ${err}`
        );
        reject(err);
      },
    });
  });
}