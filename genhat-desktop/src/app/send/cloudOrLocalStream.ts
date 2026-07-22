import { listen } from "@tauri-apps/api/event";
import { Api, cloudStreamChat } from "../../api";
import { useCloudStore } from "../../stores/cloudStore";
import type { CloudChatRequest, CloudIntent } from "../../types";

type StreamCallbacks = {
  onChunk: (chunk: string) => void;
  onThinking: (thinking: string) => void;
  onFinish: () => void;
  onError: (err: unknown) => void;
};

type StreamArgs = {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  intent?: CloudIntent;
  containsFileContext: boolean;
  /** When true, file-derived context may be sent to cloud. Default false. */
  userConfirmedCloudContext?: boolean;
  contextSource?: string;
  modelId?: string | null;
  signal?: AbortSignal;
  disableThinking?: boolean;
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

function runLocalStream(args: StreamArgs): void {
  Api.streamChat(
    args.messages,
    args.onChunk,
    args.onThinking,
    args.onFinish,
    args.onError,
    undefined,
    args.modelId,
    args.signal,
    args.disableThinking,
    args.generationOptions
  );
}

async function runCloudStream(args: StreamArgs): Promise<void> {
  const request: CloudChatRequest = {
    intent: args.intent ?? "quick_chat",
    messages: args.messages,
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
    client: {
      platform: "desktop",
    },
  };

  let settled = false;
  const unlisten = await listen<{ chunk: string; done: boolean; error?: string }>(
    "cloud-chat-stream",
    (event) => {
      if (settled) return;
      const { chunk, done, error } = event.payload;
      if (error) {
        settled = true;
        unlisten();
        args.onError(new Error(error));
        return;
      }
      if (chunk) args.onChunk(chunk);
      if (done) {
        settled = true;
        unlisten();
        args.onFinish();
      }
    }
  );

  if (args.signal) {
    const onAbort = () => {
      if (settled) return;
      settled = true;
      unlisten();
      args.onError(new DOMException("Aborted", "AbortError"));
    };
    if (args.signal.aborted) {
      onAbort();
      return;
    }
    args.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await cloudStreamChat(request);
  } catch (err) {
    if (!settled) {
      settled = true;
      unlisten();
      args.onError(err);
    }
  }
}

/**
 * Route chat streaming by preferred cloud mode.
 * - local: always local llama
 * - cloud: cloud only (errors surface to UI)
 * - auto: cloud when entitled; fall back to local on failure / missing entitlement
 *
 * File-derived context is never sent to cloud unless userConfirmedCloudContext is true;
 * otherwise cloud/auto fall back to local for that turn.
 */
export function streamChatByMode(args: StreamArgs): void {
  const { preferredMode, entitlement } = useCloudStore.getState();
  const cloudReady = Boolean(entitlement?.cloudEnabled && entitlement.status === "active");
  const fileBlocksCloud =
    args.containsFileContext && !(args.userConfirmedCloudContext ?? false);

  const tryCloud = preferredMode === "cloud" || (preferredMode === "auto" && cloudReady);

  if (preferredMode === "local" || fileBlocksCloud || !tryCloud) {
    runLocalStream(args);
    return;
  }

  if (preferredMode === "cloud" && !cloudReady) {
    args.onError(
      new Error(
        "Fast Cloud requires an active NELA Cloud plan. Open Cloud Settings to upgrade, or switch to Private Local."
      )
    );
    return;
  }

  void runCloudStream(args).catch((err) => {
    if (preferredMode === "auto") {
      console.warn("Cloud stream failed; falling back to local:", err);
      runLocalStream(args);
      return;
    }
    args.onError(err);
  });
}
