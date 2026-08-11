/**
 * LLM-first presentation edit system — the edit planner.
 *
 * EVERY edit request comes here first. The model maps the request onto the
 * command vocabulary the executor runs, which is also how it chooses between
 * deterministic work (colors/fonts/layout/structure become batched Rust ops
 * with no further model or web calls) and generated work (`patch_content`,
 * `add_slide`, `change_image` carry model-authored content).
 *
 * The model also drives its own research: instead of a regex-triggered search
 * with a hardcoded query, it may answer with a `web_search` tool call carrying
 * its own query AND depth — the same contract it already follows in chat
 * (`WEB_SEARCH_TOOL_SYSTEM`) — and we feed the results back for a final turn.
 */

import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import { isNelaPresentationDeckHtml } from "../artifactEdit";
import { willRouteToCloud, streamChatByMode } from "./cloudOrLocalStream";
import { listFreeformSlideTitles } from "./freeformHtmlSlideEdit";
import type { PresentationEditCommand } from "./presentationEditCommand";
import type { GenerationOptions, SendHandlerContext } from "./types";
import {
  normalizeWebToolDepth,
  runWebSearchWithDepth,
  type WebToolDepth,
} from "./webSearchDepth";

type UpdateEditMsg = (
  stage: PipelineStageKind,
  path?: string | null,
  contentOverride?: string
) => void;

const NELA_THEMES =
  "midnight, corporate, sunset, minimal, academic, cyber, ocean, forest, lavender, neon, rose, slate";

const LAYOUTS =
  "TITLE, BULLET, TWO_COLUMN, IMAGE_LEFT, SECTION, STAT, QUOTE, CARDS, COMPARISON, CENTERED";

/** Tool rounds the planner may spend before it must emit ops. */
const MAX_PLANNER_TOOL_ROUNDS = 2;

/** Chars of web context handed back to the planner per tool round. */
const WEB_CONTEXT_CHAR_LIMIT = 9000;

/**
 * Deck edits stay interactive, so the multi-query facet depths collapse to a
 * single research pass. The model may still ask for them — capping here keeps
 * its choice valid instead of rejecting the tool call.
 */
export function capEditDepth(depth: WebToolDepth): WebToolDepth {
  return depth === "standard" || depth === "deep" ? "full" : depth;
}

// ── Deck inventory ───────────────────────────────────────────────────────────

async function buildDeckInventory(artifactPath: string): Promise<{
  inventory: string;
  slideCount: number;
  theme: string | null;
}> {
  const lower = artifactPath.toLowerCase();
  const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");

  if (isHtml) {
    const html = await Api.readFileText(artifactPath);
    if (!isNelaPresentationDeckHtml(html)) {
      const titles = listFreeformSlideTitles(html);
      const inventory = titles
        .map((t, i) => `${i + 1}. ${t || `Slide ${i + 1}`}`)
        .join("\n");
      return { inventory, slideCount: titles.length, theme: null };
    }
  }

  const parsed = await Api.parsePresentationDeck(artifactPath);
  const inventory = (parsed.slides ?? [])
    .slice(0, 40)
    .map((s, i) => {
      const title = String(
        (s as { title?: unknown }).title ?? `Slide ${i + 1}`
      );
      const bullets = Array.isArray((s as { bullets?: unknown }).bullets)
        ? ((s as { bullets: unknown[] }).bullets as unknown[])
            .map(String)
            .slice(0, 4)
            .map((b) => (b.length > 120 ? `${b.slice(0, 120)}…` : b))
        : [];
      return `${i + 1}. ${title}${bullets.length ? ` | ${bullets.join("; ")}` : ""}`;
    })
    .join("\n");
  return {
    inventory,
    slideCount: parsed.slideCount || parsed.slides?.length || 0,
    theme: parsed.theme,
  };
}

// ── Planner output parsing ───────────────────────────────────────────────────

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

type PlannerOp = Record<string, unknown>;

/** One planner turn: either a tool call to run, or the final ops. */
export type PlannerTurn =
  | { kind: "ops"; ops: PlannerOp[] }
  | { kind: "web_search"; query: string; depth: WebToolDepth };

function jsonCandidates(raw: string): string[] {
  const cleaned = stripJsonFences(raw);
  const candidates = [cleaned];
  const brace = cleaned.match(/[[{][\s\S]*[\]}]/);
  if (brace?.[0]) candidates.push(brace[0]);
  return candidates;
}

function opsFrom(parsed: unknown): PlannerOp[] | null {
  if (Array.isArray(parsed)) {
    return parsed.filter((x) => x && typeof x === "object") as PlannerOp[];
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as { ops?: unknown; commands?: unknown };
    const list = obj.ops ?? obj.commands;
    if (Array.isArray(list)) {
      return list.filter((x) => x && typeof x === "object") as PlannerOp[];
    }
  }
  return null;
}

/**
 * Parse one planner reply. Ops win over tool calls so a reply that carries
 * both (some models narrate a search then answer) still applies the edit.
 *
 * `image_search` is accepted as a terminal alias for a `change_image` op: the
 * candidates it would return are images the model can't evaluate — the user
 * picks one — so spending a tool round on it would buy nothing.
 */
export function parsePlannerTurn(raw: string): PlannerTurn | null {
  for (const c of jsonCandidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }

    const ops = opsFrom(parsed);
    if (ops?.length) return { kind: "ops", ops };

    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const tool = str(obj.tool) ?? str(obj.name);
    const query = str(obj.query);

    if (tool === "web_search" && query) {
      return {
        kind: "web_search",
        query: query.slice(0, 200),
        depth: capEditDepth(normalizeWebToolDepth(obj.depth ?? obj.web_depth)),
      };
    }

    if (tool === "image_search" && query) {
      return {
        kind: "ops",
        ops: [
          {
            op: "change_image",
            slide: obj.slide ?? obj.index,
            image_query: query,
          },
        ],
      };
    }
  }
  return null;
}

function num(value: unknown): number | null {
  const n = typeof value === "string" ? parseInt(value, 10) : (value as number);
  return Number.isFinite(n) && (n as number) >= 1 ? Math.floor(n as number) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strList(value: unknown, maxLen = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x.length > 260 ? `${x.slice(0, 260)}…` : x))
    .slice(0, maxLen);
}

function scopeFromOp(value: unknown):
  | { type: "deck" }
  | { type: "slide"; oneBased: number }
  | null {
  if (value == null || value === "deck" || value === "all") return { type: "deck" };
  const n = num(value);
  return n != null ? { type: "slide", oneBased: n } : null;
}

/** Map planner JSON ops onto executor commands. Unknown ops are skipped. */
export function plannerOpsToCommands(
  ops: PlannerOp[],
  slideCount: number
): PresentationEditCommand[] {
  const commands: PresentationEditCommand[] = [];
  for (const op of ops) {
    const kind = str(op.op) ?? str(op.kind);
    switch (kind) {
      case "patch_content":
      case "patch_slide": {
        const oneBased = num(op.slide) ?? num(op.index);
        if (oneBased == null) break;
        commands.push({
          kind: "patch_content",
          oneBased,
          title: str(op.title) ?? undefined,
          bullets: strList(op.bullets),
          layout: str(op.layout) ?? undefined,
        });
        break;
      }
      case "set_background": {
        const scope = scopeFromOp(op.scope ?? op.slide);
        const color = str(op.color);
        if (!scope || !color) break;
        commands.push({
          kind: "set_background",
          scope,
          color,
          colorLabel: color,
        });
        break;
      }
      case "set_text_color": {
        const scope = scopeFromOp(op.scope ?? op.slide);
        const color = str(op.color);
        if (!scope || !color) break;
        commands.push({
          kind: "set_text_color",
          scope,
          color,
          colorLabel: color,
        });
        break;
      }
      case "set_font": {
        const font = str(op.font) ?? str(op.heading) ?? str(op.body);
        if (!font) break;
        commands.push({ kind: "set_font", font });
        break;
      }
      case "set_theme": {
        const theme = str(op.theme);
        if (!theme) break;
        // Delegated theme runner expects natural language.
        commands.push({ kind: "set_theme", prompt: `change the theme to ${theme}` });
        break;
      }
      case "set_layout": {
        const oneBased = num(op.slide) ?? num(op.index);
        const layout = str(op.layout);
        if (oneBased == null || !layout) break;
        commands.push({
          kind: "set_layout",
          scope: { type: "slide", oneBased },
          layout: layout.toUpperCase().replace(/[\s-]+/g, "_"),
        });
        break;
      }
      case "reformat_content": {
        const scope = scopeFromOp(op.scope ?? op.slide);
        const style = str(op.style);
        if (!scope || (style !== "bullets" && style !== "paragraph")) break;
        commands.push({ kind: "reformat_content", scope, style });
        break;
      }
      case "add_slide": {
        const title = str(op.title);
        if (!title) break;
        const at = str(op.at)?.toLowerCase() ?? "end";
        let insertIndex: number | undefined;
        if (at === "start" || at === "beginning") insertIndex = 0;
        else if (at.startsWith("before:")) {
          const n = num(at.slice("before:".length));
          if (n != null) insertIndex = Math.max(0, n - 1);
        } else if (at.startsWith("after:")) {
          const n = num(at.slice("after:".length));
          if (n != null) insertIndex = Math.min(slideCount, n);
        }
        commands.push({
          kind: "add_slide_spec",
          insertIndex,
          title,
          bullets: strList(op.bullets),
          layout: str(op.layout) ?? undefined,
        });
        break;
      }
      case "remove_slide": {
        const oneBased = num(op.slide) ?? num(op.index);
        if (oneBased == null) break;
        commands.push({ kind: "remove_slide_at", oneBased });
        break;
      }
      case "move_slide": {
        const from = num(op.from);
        const to = num(op.to);
        if (from == null || to == null) break;
        commands.push({
          kind: "move_slide_spec",
          fromOneBased: from,
          toOneBased: to,
        });
        break;
      }
      case "change_image": {
        const oneBased = num(op.slide) ?? num(op.index) ?? 1;
        // The model writes the image query itself ("Lionel Messi Barcelona
        // celebrating"), replacing the old templated topic search.
        const query = str(op.image_query) ?? str(op.query) ?? str(op.topic);
        commands.push({
          kind: "change_image",
          oneBased,
          query: query ?? undefined,
          raw: query
            ? `change the image on slide ${oneBased} to ${query}`
            : `change the image on slide ${oneBased}`,
        });
        break;
      }
      default:
        break;
    }
  }
  return commands;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(toolRoundsLeft: number): string {
  const opsSpec = `Each op is one of (slide numbers are 1-based):
- {"op":"patch_content","slide":N,"title":"...","bullets":["..."],"layout":"..."}  rewrite one slide's content (omit fields you keep)
- {"op":"set_background","scope":"deck"|N,"color":"#hex"}
- {"op":"set_text_color","scope":"deck"|N,"color":"#hex"}
- {"op":"set_font","font":"Font Name"}
- {"op":"set_theme","theme":"<name>"}  themes: ${NELA_THEMES}
- {"op":"set_layout","slide":N,"layout":"..."}  layouts: ${LAYOUTS}
- {"op":"reformat_content","slide":N,"style":"bullets"|"paragraph"}
- {"op":"add_slide","at":"end"|"start"|"before:N"|"after:N","title":"...","bullets":["..."],"layout":"..."}
- {"op":"remove_slide","slide":N}
- {"op":"move_slide","from":N,"to":N}
- {"op":"change_image","slide":N,"image_query":"web image search query for the new picture"}`;

  const rules = `RULES:
- Emit the MINIMUM ops for the request. Do NOT rewrite untouched slides.
- Style-only asks (colors, fonts, layout, theme, bullets/paragraph reformat, remove/move) need NO research — answer with ops immediately.
- For content rewrites, write the final bullets yourself: 3-6 concrete, specific bullets (15-30 words each). Ground them in WEB RESULTS when present.
- Preserve each slide's existing title unless the user asks to change it.
- To rename the presentation / title slide, emit patch_content on slide 1 with the new title (and keep existing bullets unless asked otherwise).
- Colors must be #hex values.
- image_query is a plain web image search query for the subject the user named — describe the subject and how it should look ("Lionel Messi FC Barcelona celebrating"). Never add deck framing like "visitor experience" or "key facts".`;

  const toolSpec =
    toolRoundsLeft > 0
      ? `\n\nYou may FIRST call one tool instead of answering, when the edit needs real-world facts or a picture you must name accurately:
{"tool":"web_search","query":"concise keyword query","depth":"snippet|full|standard|deep"}
depth meanings: snippet = quick facts; full = richer page content; standard = multi-facet research; deep = exhaustive research.
Write the query yourself from the user's subject — do not append boilerplate.
You have ${toolRoundsLeft} tool call${toolRoundsLeft === 1 ? "" : "s"} left; after that you must return ops.`
      : `\n\nNo tool calls left — return ops now, using any WEB RESULTS above.`;

  return `You plan edits to an existing slide deck. Reply with ONLY JSON — no markdown, no prose.
Normally: {"ops":[...]}

${opsSpec}

${rules}${toolSpec}`;
}

function buildUserPrompt(args: {
  text: string;
  deck: { inventory: string; slideCount: number; theme: string | null };
  activeOneBased: number | null;
  webContext: string;
}): string {
  const { text, deck, activeOneBased, webContext } = args;
  return (
    `EXISTING DECK (${deck.slideCount} slides${deck.theme ? `, theme: ${deck.theme}` : ""}):\n` +
    `${deck.inventory}\n\n` +
    (activeOneBased != null ? `CURRENTLY OPEN SLIDE: ${activeOneBased}\n\n` : "") +
    (webContext
      ? `WEB RESULTS (ground content edits in these facts):\n${webContext}\n\n`
      : "") +
    `User request: "${text}"`
  );
}

// ── Planner loop ─────────────────────────────────────────────────────────────

/** Transient cloud conditions worth retrying / falling back to local for. */
const TRANSIENT_CLOUD_ERROR =
  /\bbusy\b|overloaded|rate limit|too many requests|\b429\b|\b502\b|\b503\b|stopped sending tokens|took too long|timed?\s*out/i;

function isAbortLike(err: unknown): boolean {
  return (
    (err instanceof DOMException || err instanceof Error) &&
    err.name === "AbortError"
  );
}

function streamPlannerTurn(args: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  ctx: SendHandlerContext;
  ctrl: AbortController;
  generationOptions: GenerationOptions;
  forceLocal?: boolean;
}): Promise<string> {
  const { messages, ctx, ctrl, generationOptions, forceLocal } = args;
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    streamChatByMode({
      messages,
      intent: "artifact_plan",
      containsFileContext: false,
      modelId: ctx.selectedModel || undefined,
      signal: ctrl.signal,
      disableThinking: true,
      forceLocal: Boolean(forceLocal),
      // Local models often can't honor json_object; keep it cloud-only.
      response_format:
        !forceLocal && willRouteToCloud()
          ? { type: "json_object" }
          : undefined,
      generationOptions: {
        ...generationOptions,
        maxTokens: 1600,
        temperature: 0.15,
      },
      onChunk: (chunk) => {
        raw += chunk;
      },
      onThinking: () => {},
      onFinish: () => {
        if (settled) return;
        settled = true;
        resolve(raw);
      },
      onError: (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    });
  });
}

/**
 * Cloud-first planner turn with one retry on transient "busy", then local.
 * Edit planning is a background utility — a local JSON plan beats failing the
 * whole edit when Cloud is briefly overloaded.
 */
async function streamPlannerTurnResilient(args: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  ctx: SendHandlerContext;
  ctrl: AbortController;
  generationOptions: GenerationOptions;
  updateEditMsg: UpdateEditMsg;
}): Promise<string> {
  const attempts: Array<{ forceLocal: boolean; delayMs: number }> = [
    { forceLocal: false, delayMs: 0 },
    { forceLocal: false, delayMs: 1200 },
    { forceLocal: true, delayMs: 0 },
  ];

  let lastErr: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    if (attempt.delayMs > 0) {
      await new Promise((r) => setTimeout(r, attempt.delayMs));
    }
    if (attempt.forceLocal) {
      args.updateEditMsg(
        "CrunchingMetrics",
        null,
        "Cloud is busy — planning with your local model…"
      );
    }
    try {
      return await streamPlannerTurn({
        messages: args.messages,
        ctx: args.ctx,
        ctrl: args.ctrl,
        generationOptions: args.generationOptions,
        forceLocal: attempt.forceLocal,
      });
    } catch (err) {
      if (isAbortLike(err)) throw err;
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Edit planner turn failed (attempt ${i + 1}):`, msg);
      if (!attempt.forceLocal && !TRANSIENT_CLOUD_ERROR.test(msg)) {
        // Non-transient cloud failure → jump straight to local.
        const localIdx = attempts.findIndex((a) => a.forceLocal);
        if (localIdx > i) i = localIdx - 1;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "Planner failed"));
}

export async function runPresentationEditPlanner(args: {
  text: string;
  artifactPath: string;
  ctx: SendHandlerContext;
  ctrl: AbortController;
  generationOptions: GenerationOptions;
  updateEditMsg: UpdateEditMsg;
  activeSlideIndex?: number | null;
}): Promise<PresentationEditCommand[] | null> {
  const { text, artifactPath, ctx, ctrl, generationOptions, updateEditMsg } = args;

  updateEditMsg("CrunchingMetrics", null, "Working out the edit…");

  let deck: Awaited<ReturnType<typeof buildDeckInventory>>;
  try {
    deck = await buildDeckInventory(artifactPath);
  } catch (err) {
    console.warn("Edit planner deck inventory failed:", err);
    return null;
  }
  if (deck.slideCount < 1) return null;

  const activeOneBased =
    args.activeSlideIndex != null && args.activeSlideIndex >= 0
      ? args.activeSlideIndex + 1
      : null;

  let webContext = "";
  for (let round = 0; round <= MAX_PLANNER_TOOL_ROUNDS; round++) {
    const toolRoundsLeft = MAX_PLANNER_TOOL_ROUNDS - round;
    updateEditMsg(
      "CrunchingMetrics",
      null,
      round === 0 ? "Planning the edit…" : "Planning the edit with sources…"
    );

    let raw: string;
    try {
      raw = await streamPlannerTurnResilient({
        messages: [
          { role: "system", content: buildSystemPrompt(toolRoundsLeft) },
          {
            role: "user",
            content: buildUserPrompt({ text, deck, activeOneBased, webContext }),
          },
        ],
        ctx,
        ctrl,
        generationOptions,
        updateEditMsg,
      });
    } catch (err) {
      if (isAbortLike(err)) return null;
      console.warn("Edit planner LLM call failed:", err);
      return null;
    }

    const turn = parsePlannerTurn(raw);
    if (!turn) {
      console.warn("Edit planner returned unusable JSON:", raw.slice(0, 300));
      return null;
    }

    if (turn.kind === "ops") {
      const commands = plannerOpsToCommands(turn.ops, deck.slideCount);
      return commands.length ? commands : null;
    }

    if (toolRoundsLeft === 0) {
      // Still asking for tools with no rounds left — searching again would be
      // thrown away, so hand off to the deterministic parser.
      console.warn("Edit planner exhausted tool rounds without ops");
      return null;
    }

    // web_search — the model chose both the query and the depth.
    updateEditMsg("CrunchingMetrics", null, `Searching the web for “${turn.query}”…`);
    try {
      const result = await runWebSearchWithDepth({
        query: turn.query,
        depth: turn.depth,
        messages: [{ role: "user", content: text }],
        modelId: ctx.selectedModel || undefined,
        signal: ctrl.signal,
        onToolStatus: (status) => {
          if (status) updateEditMsg("CrunchingMetrics", null, status);
        },
      });
      const context =
        result.formatted_context?.trim() ||
        result.results
          .map((h, i) => `${i + 1}. ${h.title}\n${h.snippet}\n${h.url}`)
          .join("\n\n");
      const next = context.trim();
      if (!next) {
        // No usable results: tell the model so it stops asking and writes ops.
        webContext = `(no results for "${turn.query}" — use your own knowledge)`;
      } else {
        webContext = (webContext ? `${webContext}\n\n${next}` : next).slice(
          0,
          WEB_CONTEXT_CHAR_LIMIT
        );
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      console.warn("Edit planner web search failed:", err);
      webContext = `(search failed for "${turn.query}" — use your own knowledge)`;
    }
  }

  return null;
}
