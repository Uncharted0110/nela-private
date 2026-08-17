import { listen } from "@tauri-apps/api/event";
import { Api, cloudStreamChat } from "../../api";
import { useCloudStore } from "../../stores/cloudStore";
import { useModelStore } from "../../stores/modelStore";
import { cloudQualityModeForIntelligence } from "../intelligenceModes";
import { friendlyError } from "../friendlyError";
import { prepareMessagesForCloudCaching } from "./prepareCloudMessages";
import {
  CLOUD_STREAM_ABSOLUTE_TIMEOUT_MS,
  CLOUD_STREAM_IDLE_TIMEOUT_MS,
} from "./webSearchLimits";
import type {
  CloudChatMessage,
  CloudChatRequest,
  CloudFileParserPlugin,
  CloudIntent,
  CloudQualityMode,
  CloudToolCall,
  CloudToolChoice,
  CloudToolDefinition,
  FileAnnotation,
} from "../../types";

type StreamFinishMeta = {
  tool_calls?: CloudToolCall[];
  model?: string;
  creditsRemaining?: number;
  trialCreditsRemaining?: number;
  trialExpiresAt?: string | null;
  annotations?: FileAnnotation[];
};

type StreamCallbacks = {
  onChunk: (chunk: string) => void;
  onThinking: (thinking: string) => void;
  onFinish: (meta?: StreamFinishMeta) => void;
  onError: (err: unknown) => void;
};

type StreamArgs = {
  messages: CloudChatMessage[];
  intent?: CloudIntent;
  mode?: CloudQualityMode;
  containsFileContext: boolean;
  /** When true, file-derived context may be sent to cloud. Default false. */
  userConfirmedCloudContext?: boolean;
  contextSource?: string;
  plugins?: CloudFileParserPlugin[];
  modelId?: string | null;
  signal?: AbortSignal;
  disableThinking?: boolean;
  tools?: CloudToolDefinition[];
  tool_choice?: CloudToolChoice;
  response_format?: { type: "json_object" | "text" };
  /** When true, cloud failures surface via onError instead of local fallback. */
  disableLocalFallback?: boolean;
  /**
   * Route to the local model regardless of cloud preference. For background
   * utility calls (e.g. slide copy synthesis) where callers manage their own
   * cloud-first retry and a local answer beats failing.
   */
  forceLocal?: boolean;
  generationOptions?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    repeatPenalty?: number;
    grammar?: string;
    idSlot?: number | null;
    sessionId?: string | null;
    workspaceId?: string | null;
  };
} & StreamCallbacks;

export function isCloudReadyForMode(mode: CloudQualityMode): boolean {
  const { entitlement } = useCloudStore.getState();
  if (!entitlement?.cloudEnabled) return false;
  if (entitlement.paidCloud) return true;
  if (mode === "smart" || mode === "deep") return false;
  if (mode === "fast" || mode === "auto") {
    return (
      (entitlement.fastFree?.remaining ?? 0) > 0 ||
      entitlement.status === "active"
    );
  }
  return false;
}

/**
 * Whether we should attempt a cloud request for the current routing preference.
 * Explicit Cloud mode still requires paid entitlement for Smart/Deep (no silent Fast clamp).
 */
export function canAttemptCloud(mode: CloudQualityMode): boolean {
  const { preferredMode, entitlement } = useCloudStore.getState();
  if (!entitlement?.cloudEnabled) return false;
  if (preferredMode === "cloud") {
    if (mode === "smart" || mode === "deep") return Boolean(entitlement.paidCloud);
    return true;
  }
  return isCloudReadyForMode(mode);
}

/** True when Cloud Smart/Deep would require Premium. */
export function needsPremiumForCloudMode(mode: CloudQualityMode): boolean {
  const { preferredMode, entitlement } = useCloudStore.getState();
  if (preferredMode === "local") return false;
  if (mode !== "smart" && mode !== "deep") return false;
  return !entitlement?.paidCloud;
}

export function willRouteToCloud(args?: {
  containsFileContext?: boolean;
  userConfirmedCloudContext?: boolean;
  mode?: CloudQualityMode;
}): boolean {
  const { preferredMode } = useCloudStore.getState();
  const intelligenceMode = useModelStore.getState().intelligenceMode;
  const mode =
    args?.mode ?? cloudQualityModeForIntelligence(intelligenceMode);
  const cloudReady = canAttemptCloud(mode);
  // Explicit Cloud mode is consent to send this turn (including file-derived
  // artifact context) to NELA Cloud. Auto still requires an explicit confirm.
  const confirmed =
    Boolean(args?.userConfirmedCloudContext) || preferredMode === "cloud";
  const fileBlocksCloud =
    Boolean(args?.containsFileContext) && !confirmed;
  if (preferredMode === "local" || fileBlocksCloud) return false;
  if (preferredMode === "cloud") return cloudReady;
  return preferredMode === "auto" && cloudReady;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/** Short user-visible reason extracted from cloud / API errors. */
export function summarizeCloudError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return friendlyError(raw);
}

export function formatCloudFallbackNotice(err: unknown): string {
  return `*NELA Cloud is unavailable right now — ${summarizeCloudError(err)} Using your local model instead.*\n\n`;
}

/** Deep / artifact cloud answers should not inherit tiny local-model max_tokens. */
const CLOUD_DEEP_MIN_OUTPUT_TOKENS = 65_536;
const CLOUD_ARTIFACT_MIN_OUTPUT_TOKENS = 65_536;

function resolveCloudMaxTokens(
  mode: CloudQualityMode,
  intent: CloudIntent | undefined,
  requested: number | undefined
): number | undefined {
  const base =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.round(requested)
      : undefined;
  if (intent === "artifact_plan") {
    return Math.max(base ?? 0, CLOUD_ARTIFACT_MIN_OUTPUT_TOKENS);
  }
  if (mode === "deep") {
    return Math.max(base ?? 0, CLOUD_DEEP_MIN_OUTPUT_TOKENS);
  }
  return base;
}

function runLocalStream(args: StreamArgs): void {
  const localMessages = args.messages
    .filter(
      (m) =>
        m.role === "system" || m.role === "user" || m.role === "assistant"
    )
    .map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content:
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((part): part is { type: "text"; text: string } => part.type === "text")
                .map((part) => part.text)
                .join("\n")
            : m.content ?? "",
    }));
  const localModel =
    args.modelId?.trim() ||
    useModelStore.getState().selectedModel?.trim() ||
    undefined;
  Api.streamChat(
    localMessages,
    args.onChunk,
    args.onThinking,
    () => args.onFinish(localModel ? { model: localModel } : undefined),
    args.onError,
    undefined,
    args.modelId,
    args.signal,
    // Local llama never streams reasoning into the chat UI.
    true,
    args.generationOptions
  );
}

/** Local stream prefixed with a one-time fallback notice in the assistant reply. */
function runLocalStreamWithNotice(args: StreamArgs, notice: string): void {
  let noticeSent = false;
  runLocalStream({
    ...args,
    onChunk: (chunk) => {
      if (!noticeSent) {
        noticeSent = true;
        args.onChunk(notice);
      }
      args.onChunk(chunk);
    },
    onFinish: (meta) => {
      if (!noticeSent) {
        noticeSent = true;
        args.onChunk(notice);
      }
      args.onFinish(meta);
    },
  });
}

async function runCloudStream(args: StreamArgs): Promise<void> {
  const intelligenceMode = useModelStore.getState().intelligenceMode;
  const mode =
    args.mode ?? cloudQualityModeForIntelligence(intelligenceMode);

  const prepared = prepareMessagesForCloudCaching(args.messages);
  const messages: CloudChatMessage[] = prepared.map((m) => ({
    role: m.role,
    content: m.content ?? null,
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.name,
    annotations: m.annotations,
  }));

  const sessionId =
    args.generationOptions?.sessionId?.trim() ||
    args.generationOptions?.workspaceId?.trim() ||
    undefined;

  // Stable sticky key: same chat → same OpenRouter provider (cache warmth).
  const stickySessionId = sessionId
    ? `nela-desktop:${args.generationOptions?.workspaceId?.trim() || "ws"}:${sessionId}`.slice(
        0,
        256
      )
    : undefined;

  const request: CloudChatRequest = {
    mode,
    intent: args.intent ?? "quick_chat",
    messages,
    stream: true,
    privacy: {
      containsFileContext: args.containsFileContext,
      userConfirmedCloudContext: args.userConfirmedCloudContext ?? false,
      contextSource: args.contextSource,
    },
    generation: {
      maxTokens: resolveCloudMaxTokens(mode, args.intent, args.generationOptions?.maxTokens),
      temperature: args.generationOptions?.temperature,
    },
    tools: args.tools,
    tool_choice: args.tool_choice,
    response_format: args.response_format,
    includeReasoning: args.disableThinking !== true,
    plugins: args.plugins,
    client: {
      platform: "desktop",
      sessionId: stickySessionId,
    },
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let absoluteTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (absoluteTimer) {
        clearTimeout(absoluteTimer);
        absoluteTimer = null;
      }
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimers();
      fn();
    };

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(() => {
          unlistenFn?.();
          args.onError(
            new Error(
              "NELA Cloud stopped sending tokens. Please try again."
            )
          );
          resolve();
        });
      }, CLOUD_STREAM_IDLE_TIMEOUT_MS);
    };

    let unlistenFn: (() => void) | null = null;

    void (async () => {
      const unlisten = await listen<{
        chunk: string;
        thinking?: string;
        done: boolean;
        error?: string;
        tool_calls?: CloudToolCall[];
        model?: string;
        creditsRemaining?: number;
        trialCreditsRemaining?: number;
        trialExpiresAt?: string | null;
        annotations?: FileAnnotation[];
      }>("cloud-chat-stream", (event) => {
        if (settled) return;
        const {
          chunk,
          thinking,
          done,
          error,
          tool_calls,
          model,
          creditsRemaining,
          trialCreditsRemaining,
          trialExpiresAt,
          annotations,
        } = event.payload;
        if (error) {
          finish(() => {
            unlisten();
            args.onError(new Error(error));
            // Resolve so callers that only await this promise don't hang;
            // onError already triggered fallback / UI handling.
            resolve();
          });
          return;
        }
        if (thinking) {
          armIdle();
          args.onThinking(thinking);
        }
        if (chunk) {
          armIdle();
          args.onChunk(chunk);
        }
        if (done) {
          finish(() => {
            unlisten();
            const meta: StreamFinishMeta = {};
            if (tool_calls?.length) meta.tool_calls = tool_calls;
            if (model?.trim()) meta.model = model.trim();
            if (typeof creditsRemaining === "number") {
              meta.creditsRemaining = creditsRemaining;
            }
            if (typeof trialCreditsRemaining === "number") {
              meta.trialCreditsRemaining = trialCreditsRemaining;
            }
            if (trialExpiresAt !== undefined) {
              meta.trialExpiresAt = trialExpiresAt;
            }
            if (annotations?.length) meta.annotations = annotations;
            if (typeof meta.creditsRemaining === "number") {
              useCloudStore.getState().applyCreditsSnapshot({
                balance: meta.creditsRemaining,
                trialCredits: meta.trialCreditsRemaining,
                trialExpiresAt: meta.trialExpiresAt,
              });
            }
            args.onFinish(
              meta.tool_calls ||
                meta.model ||
                typeof meta.creditsRemaining === "number" ||
                meta.annotations
                ? meta
                : undefined
            );
            resolve();
          });
        }
      });
      unlistenFn = unlisten;

      if (args.signal) {
        const onAbort = () => {
          finish(() => {
            unlisten();
            args.onError(new DOMException("Aborted", "AbortError"));
            reject(new DOMException("Aborted", "AbortError"));
          });
        };
        if (args.signal.aborted) {
          onAbort();
          return;
        }
        args.signal.addEventListener("abort", onAbort, { once: true });
      }

      absoluteTimer = setTimeout(() => {
        finish(() => {
          unlisten();
          args.onError(
            new Error(
              "That took too long. Please try again with a shorter request."
            )
          );
          resolve();
        });
      }, CLOUD_STREAM_ABSOLUTE_TIMEOUT_MS);
      armIdle();

      try {
        // Returns immediately (stream runs in a Rust background task) so
        // Tauri can deliver chunk events while tokens arrive.
        await cloudStreamChat(request);
      } catch (err) {
        finish(() => {
          unlisten();
          args.onError(err);
          reject(err);
        });
      }
    })();
  });
}

/**
 * Route chat streaming by preferred cloud routing preference.
 * - local: always local llama
 * - cloud: always try NELA Cloud (no silent local fallback). File context is
 *   allowed because choosing Cloud mode is treated as confirmation.
 * - auto: try cloud when entitled; on failure fall back to local. File-derived
 *   context stays local unless userConfirmedCloudContext is true.
 *
 * Grammar is local-only — never sent on the cloud path.
 */
export function streamChatByMode(args: StreamArgs): void {
  const { preferredMode } = useCloudStore.getState();
  const intelligenceMode = useModelStore.getState().intelligenceMode;
  const mode =
    args.mode ?? cloudQualityModeForIntelligence(intelligenceMode);
  const strictCloud = preferredMode === "cloud";
  const confirmedCloudContext =
    Boolean(args.userConfirmedCloudContext) || strictCloud;
  const cloudReady = canAttemptCloud(mode);
  const fileBlocksCloud =
    Boolean(args.containsFileContext) && !confirmedCloudContext;

  const wantsCloud =
    preferredMode === "cloud" || preferredMode === "auto";

  // Prefer no silent local fallback in explicit Cloud mode (artifacts/chat).
  const disableLocalFallback =
    Boolean(args.disableLocalFallback) || strictCloud;

  const localArgs: StreamArgs = {
    ...args,
    generationOptions: args.generationOptions,
  };

  const cloudArgs: StreamArgs = {
    ...args,
    mode,
    userConfirmedCloudContext: confirmedCloudContext,
    generationOptions: args.generationOptions
      ? { ...args.generationOptions, grammar: undefined }
      : undefined,
  };

  if (args.forceLocal || preferredMode === "local" || fileBlocksCloud) {
    runLocalStream(localArgs);
    return;
  }

  if (!wantsCloud) {
    runLocalStream(localArgs);
    return;
  }

  if (!cloudReady) {
    const paidNeeded = needsPremiumForCloudMode(mode);
    if (paidNeeded) {
      useCloudStore.getState().openUpgradeModal();
      args.onError(new Error(friendlyError("Upgrade to Premium to use Smart and Deep in Cloud")));
      return;
    }
    const reason = "not signed in or Fast quota exhausted";
    if (disableLocalFallback) {
      args.onError(new Error(friendlyError(reason)));
      return;
    }
    console.warn(`Cloud not ready (${reason}); falling back to local`);
    runLocalStreamWithNotice(
      localArgs,
      formatCloudFallbackNotice(new Error(reason))
    );
    return;
  }

  const failOrFallback = (err: unknown) => {
    if (isAbortError(err)) {
      args.onError(err);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/upgrade to premium|UPGRADE_REQUIRED|buy a credit pack/i.test(msg)) {
      useCloudStore.getState().openUpgradeModal("upgrade");
      args.onError(new Error(friendlyError(msg)));
      return;
    }
    if (/QUOTA_EXHAUSTED|credit balance|FAST_QUOTA|buy a pack/i.test(msg)) {
      useCloudStore.getState().openUpgradeModal("credits");
      args.onError(new Error(friendlyError(msg)));
      return;
    }
    if (disableLocalFallback) {
      args.onError(new Error(friendlyError(msg)));
      return;
    }
    console.warn("Cloud stream failed; falling back to local:", err);
    runLocalStreamWithNotice(localArgs, formatCloudFallbackNotice(err));
  };

  // Try cloud; on failure fall back to local with notice (unless aborted / disabled).
  void runCloudStream({
    ...cloudArgs,
    onFinish: args.onFinish,
    onThinking: args.onThinking,
    onChunk: args.onChunk,
    onError: failOrFallback,
  }).catch(failOrFallback);
}
