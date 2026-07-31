import { listen } from "@tauri-apps/api/event";
import { Api, cloudStreamChat } from "../../api";
import { useCloudStore } from "../../stores/cloudStore";
import { useModelStore } from "../../stores/modelStore";
import { cloudQualityModeForIntelligence } from "../intelligenceModes";
import { friendlyError } from "../friendlyError";
import { prepareMessagesForCloudCaching } from "./prepareCloudMessages";
import type {
  CloudChatMessage,
  CloudChatRequest,
  CloudIntent,
  CloudQualityMode,
  CloudToolCall,
  CloudToolChoice,
  CloudToolDefinition,
} from "../../types";

type StreamCallbacks = {
  onChunk: (chunk: string) => void;
  onThinking: (thinking: string) => void;
  onFinish: (meta?: { tool_calls?: CloudToolCall[] }) => void;
  onError: (err: unknown) => void;
};

type StreamArgs = {
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    tool_calls?: CloudToolCall[];
    tool_call_id?: string;
    name?: string;
  }>;
  intent?: CloudIntent;
  mode?: CloudQualityMode;
  containsFileContext: boolean;
  /** When true, file-derived context may be sent to cloud. Default false. */
  userConfirmedCloudContext?: boolean;
  contextSource?: string;
  modelId?: string | null;
  signal?: AbortSignal;
  disableThinking?: boolean;
  tools?: CloudToolDefinition[];
  tool_choice?: CloudToolChoice;
  response_format?: { type: "json_object" | "text" };
  /** When true, cloud failures surface via onError instead of local fallback. */
  disableLocalFallback?: boolean;
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
 * Explicit Cloud mode tries as long as the account has cloud enabled — the API
 * clamps unpaid Smart/Deep requests down to Fast. Auto mode still requires the
 * selected tier to be entitled client-side.
 */
export function canAttemptCloud(mode: CloudQualityMode): boolean {
  const { preferredMode, entitlement } = useCloudStore.getState();
  if (!entitlement?.cloudEnabled) return false;
  if (preferredMode === "cloud") return true;
  return isCloudReadyForMode(mode);
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

function runLocalStream(args: StreamArgs): void {
  const localMessages = args.messages
    .filter(
      (m) =>
        m.role === "system" || m.role === "user" || m.role === "assistant"
    )
    .map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content ?? "",
    }));
  Api.streamChat(
    localMessages,
    args.onChunk,
    args.onThinking,
    () => args.onFinish(),
    args.onError,
    undefined,
    args.modelId,
    args.signal,
    args.disableThinking,
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
      maxTokens: args.generationOptions?.maxTokens,
      temperature: args.generationOptions?.temperature,
    },
    tools: args.tools,
    tool_choice: args.tool_choice,
    response_format: args.response_format,
    client: {
      platform: "desktop",
      sessionId: stickySessionId,
    },
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    void (async () => {
      const unlisten = await listen<{
        chunk: string;
        done: boolean;
        error?: string;
        tool_calls?: CloudToolCall[];
      }>("cloud-chat-stream", (event) => {
        if (settled) return;
        const { chunk, done, error, tool_calls } = event.payload;
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
        if (chunk) args.onChunk(chunk);
        if (done) {
          finish(() => {
            unlisten();
            args.onFinish(tool_calls?.length ? { tool_calls } : undefined);
            resolve();
          });
        }
      });

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

  if (preferredMode === "local" || fileBlocksCloud) {
    runLocalStream(localArgs);
    return;
  }

  if (!wantsCloud) {
    runLocalStream(localArgs);
    return;
  }

  if (!cloudReady) {
    const paidNeeded = mode === "smart" || mode === "deep";
    const reason = paidNeeded
      ? "Smart/Deep cloud needs a paid plan or sign-in"
      : "not signed in or Fast quota exhausted";
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
    if (disableLocalFallback) {
      args.onError(err);
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
