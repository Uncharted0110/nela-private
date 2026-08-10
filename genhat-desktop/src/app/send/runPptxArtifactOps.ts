import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import {
  editedOutputName,
  isPresentationFullRewriteRequest,
  prefersSurgicalPresentationEdit,
} from "../artifactEdit";
import { streamChatByMode, willRouteToCloud } from "./cloudOrLocalStream";
import type { GenerationOptions, SendHandlerContext } from "./types";
import { friendlyErrorFromUnknown } from "../friendlyError";

const THEMES = [
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

function stripJsonFences(raw: string): string {
  let t = raw.trim();
  if (t.startsWith("```")) {
    const lines = t.split("\n");
    if (lines[0]?.startsWith("```")) lines.shift();
    if (lines[lines.length - 1]?.trim() === "```") lines.pop();
    t = lines.join("\n").trim();
  }
  return t;
}

function parseOpsJson(raw: string): Record<string, unknown>[] {
  const cleaned = stripJsonFences(raw);
  const parsed = JSON.parse(cleaned) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.filter((x) => x && typeof x === "object") as Record<
      string,
      unknown
    >[];
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as { ops?: unknown };
    if (Array.isArray(obj.ops)) {
      return obj.ops.filter((x) => x && typeof x === "object") as Record<
        string,
        unknown
      >[];
    }
  }
  throw new Error("Model did not return an ops array");
}

function summarizeSlides(
  slides: Record<string, unknown>[],
  max = 40
): string {
  return slides
    .slice(0, max)
    .map((s, i) => {
      const title = String(s.title ?? s.heading ?? `Slide ${i + 1}`);
      const bullets = Array.isArray(s.bullets)
        ? (s.bullets as unknown[]).map(String).slice(0, 6)
        : [];
      const bulletPreview = bullets.length
        ? ` | bullets: ${bullets.join("; ")}`
        : "";
      return `${i}. ${title}${bulletPreview}`;
    })
    .join("\n");
}

/**
 * Surgical presentation edit: LLM emits a small op list; Rust applies it to the
 * existing NELA HTML deck or native PPTX without regenerating untouched slides.
 */
export async function runPptxArtifactOps(
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
): Promise<boolean> {
  if (
    isPresentationFullRewriteRequest(text) ||
    !prefersSurgicalPresentationEdit(text)
  ) {
    return false;
  }

  updateEditMsg("SearchingDisk");
  let parsed: Awaited<ReturnType<typeof Api.parsePresentationDeck>>;
  try {
    parsed = await Api.parsePresentationDeck(artifactPath);
  } catch (err: unknown) {
    console.warn("Surgical presentation parse failed; falling back:", err);
    return false;
  }

  if (!parsed.slides?.length) {
    return false;
  }

  updateEditMsg("CrunchingMetrics");

  const useCloud = willRouteToCloud();
  const theme = parsed.theme ?? "midnight";
  const inventory = summarizeSlides(parsed.slides as Record<string, unknown>[]);

  const systemPrompt = `You edit existing PowerPoint / NELA slide decks surgically.
Return ONLY JSON: {"ops":[...]} — no markdown fences, no prose.

Each op is one of:
- {"op":"set_theme","theme":"<name>"}  themes: ${THEMES.join(", ")}
- {"op":"set_font","heading":"<Font Name>","body":"<Font Name>"}  (omit unused fields)
- {"op":"set_colors","accent":"#hex or color name","background":"#hex or color name"}
- {"op":"insert_slide","at":"end"|"start"|"before:N"|"after:N","title":"...","layout":"TITLE|BULLET|CENTERED|SECTION|STAT|QUOTE|CARDS|COMPARISON","bullets":["..."]}
- {"op":"patch_slide","index":0,"title":"...","bullets":["..."],"layout":"BULLET"}  (0-based index)
- {"op":"remove_slide","index":0}  (0-based index)
- {"op":"move_slide","from":8,"to":3}  (0-based indexes; move slide to a new position)

RULES:
- Emit the MINIMUM ops needed for the user request.
- Do NOT rewrite the whole deck. Do NOT invent unrelated slides.
- Preserve existing slide text unless the user asks to change that slide.
- For "change font / color / theme" use set_font / set_colors / set_theme only.
- For "add a thank you slide" use insert_slide only.
- Slide indexes in the inventory below are 0-based.`;

  const userPrompt = `EXISTING DECK (${parsed.slideCount} slides, theme: ${theme}):
${inventory}

User request: "${text}"

Return {"ops":[...]} only.`;

  let opsJson = "";
  try {
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
          maxTokens: 1200,
          temperature: 0.1,
        },
        onChunk: (chunk) => {
          opsJson += chunk;
        },
        onThinking: () => {},
        onFinish: () => resolve(),
        onError: (err) => reject(err),
      });
    });
  } catch (err: unknown) {
    console.warn("Surgical ops generation failed; falling back:", err);
    return false;
  }

  let ops: Record<string, unknown>[];
  try {
    ops = parseOpsJson(opsJson);
  } catch (err) {
    console.warn("Failed to parse surgical ops; falling back:", err, opsJson);
    return false;
  }

  if (!ops.length) {
    console.warn("Empty surgical ops; falling back to full edit");
    return false;
  }

  updateEditMsg("WritingCode");
  try {
    const result = await Api.applyPresentationOps({
      path: artifactPath,
      ops,
      outputName: editedOutputName(artifactPath),
    });
    ctx.updateSession(sid, {
      loading: false,
      artifactPath: result.path,
      artifactStage: "LivePreview",
      artifactPanelOpen: true,
    });
    const filename = result.path.split(/[/\\]/).pop();
    const opSummary = ops
      .map((o) => String(o.op ?? "edit"))
      .slice(0, 6)
      .join(", ");
    updateEditMsg(
      "LivePreview",
      result.path,
      `Applied surgical edits (${opSummary}) → **${filename}** (original left unchanged).`
    );
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("applyPresentationOps failed; falling back:", message);
    return false;
  }
}
