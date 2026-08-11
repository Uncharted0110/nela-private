import type { ChatMessage, ChatSession, WebSearchResult } from "../types";

/** Cap persisted thinking blobs so history reloads stay usable without filling quota. */
const THINKING_PERSIST_MAX_CHARS = 2000;

function isDataUrl(value: string | undefined | null): boolean {
  return typeof value === "string" && value.startsWith("data:");
}

function webSearchResultForPersistence(
  result: WebSearchResult | undefined
): WebSearchResult | undefined {
  if (!result) return undefined;
  return {
    query: result.query,
    queries: result.queries,
    results: result.results,
    // Drop huge model-context blobs; UI only needs hits for disclosure.
    formatted_context: "",
    images: result.images,
  };
}

function messageForPersistence(m: ChatMessage): ChatMessage {
  const thinking =
    typeof m.thinking === "string" && m.thinking
      ? m.thinking.length > THINKING_PERSIST_MAX_CHARS
        ? m.thinking.slice(-THINKING_PERSIST_MAX_CHARS)
        : m.thinking
      : undefined;

  return {
    ...m,
    thinking,
    audioUrl: isDataUrl(m.audioUrl) ? undefined : m.audioUrl,
    webSearchResult: webSearchResultForPersistence(m.webSearchResult),
    streamingArtifactHtml: undefined,
    streamingArtifactCsv: undefined,
  };
}

/** Create a fresh, empty ChatSession with a unique ID. */
export function createEmptySession(): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: "New Chat",
    messages: [],
    streamingContent: "",
    loading: false,
    audioOutputs: [],
    cancelled: false,
    ragResult: null,
    mediaAssets: {},
    createdAt: Date.now(),
  };
}

/** Derive a short title from the first user message in a session. */
export function deriveTitleFromMessage(text: string): string {
  const trimmed = text.trim().replace(/\n+/g, " ");
  return trimmed.length > 32 ? `${trimmed.slice(0, 32)}…` : trimmed || "New Chat";
}

function normalizeMessage(raw: ChatMessage): ChatMessage {
  const artifactPath =
    typeof raw.artifactPath === "string" && raw.artifactPath
      ? raw.artifactPath
      : raw.artifactPath === null
        ? null
        : undefined;
  const artifactStage =
    typeof raw.artifactStage === "string" && raw.artifactStage
      ? raw.artifactStage
      : artifactPath
        ? "LivePreview"
        : raw.artifactStage === null
          ? null
          : undefined;

  return {
    ...raw,
    id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
    content: typeof raw.content === "string" ? raw.content : "",
    artifactPath,
    artifactStage,
    artifactUseSidePanel: Boolean(raw.artifactUseSidePanel) || Boolean(artifactPath),
    artifactTitle:
      typeof raw.artifactTitle === "string" && raw.artifactTitle
        ? raw.artifactTitle
        : undefined,
    artifactFollowup:
      typeof raw.artifactFollowup === "string" && raw.artifactFollowup.trim()
        ? raw.artifactFollowup
        : undefined,
    streamingArtifactType:
      raw.streamingArtifactType === "text/html" ||
      raw.streamingArtifactType === "text/csv"
        ? raw.streamingArtifactType
        : undefined,
    streamingArtifactTitle:
      typeof raw.streamingArtifactTitle === "string"
        ? raw.streamingArtifactTitle
        : undefined,
    // Bodies are reloaded from disk via artifactPath — don't keep huge blobs.
    streamingArtifactHtml: undefined,
    streamingArtifactCsv: undefined,
  };
}

/** Ensure persisted sessions are safely shaped after loading from storage. */
export function normalizeSession(raw: Partial<ChatSession>): ChatSession {
  const messages = Array.isArray(raw.messages)
    ? raw.messages
        .filter(
          (m): m is ChatMessage =>
            !!m &&
            (m.role === "user" || m.role === "assistant" || m.role === "system") &&
            typeof m.content === "string"
        )
        .map(normalizeMessage)
    : [];

  const artifactPath =
    typeof raw.artifactPath === "string" && raw.artifactPath
      ? raw.artifactPath
      : messages
          .slice()
          .reverse()
          .find((m) => m.artifactPath)?.artifactPath ?? null;

  const artifactStage =
    typeof raw.artifactStage === "string" && raw.artifactStage
      ? raw.artifactStage
      : artifactPath
        ? "LivePreview"
        : null;

  const lastArtifactMsg = [...messages]
    .reverse()
    .find((m) => m.artifactPath || m.artifactUseSidePanel);

  const inferredType =
    raw.streamingArtifactType === "text/html" ||
    raw.streamingArtifactType === "text/csv"
      ? raw.streamingArtifactType
      : lastArtifactMsg?.streamingArtifactType === "text/html" ||
          lastArtifactMsg?.streamingArtifactType === "text/csv"
        ? lastArtifactMsg.streamingArtifactType
        : artifactPath && /\.xlsx?$/i.test(artifactPath)
          ? ("text/csv" as const)
          : artifactPath && /\.html?$/i.test(artifactPath)
            ? ("text/html" as const)
            : undefined;

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
    title: typeof raw.title === "string" && raw.title ? raw.title : "New Chat",
    messages,
    streamingContent: "",
    loading: false,
    audioOutputs: Array.isArray(raw.audioOutputs)
      ? raw.audioOutputs
      : typeof raw.audioOutput === "string" && raw.audioOutput
        ? [raw.audioOutput]
        : [],
    cancelled: false,
    ragResult: raw.ragResult ?? null,
    mediaAssets: raw.mediaAssets ?? {},
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    artifactPath,
    artifactStage,
    // Keep panel closed on restore; chip can reopen. Content hydrates from path.
    artifactStreamActive: Boolean(artifactPath),
    artifactPanelOpen: false,
    streamingArtifactType: inferredType,
    streamingArtifactTitle:
      (typeof raw.streamingArtifactTitle === "string" &&
        raw.streamingArtifactTitle) ||
      lastArtifactMsg?.artifactTitle ||
      lastArtifactMsg?.streamingArtifactTitle,
    streamingArtifactHtml: undefined,
    streamingArtifactCsv: undefined,
  };
}

/** Strip large transient bodies before writing workspace state. */
export function sessionForPersistence(session: ChatSession): ChatSession {
  const audioOutputs = (session.audioOutputs ?? []).filter((url) => !isDataUrl(url));
  return {
    ...session,
    streamingContent: "",
    loading: false,
    cancelled: false,
    audioOutputs,
    audioOutput: isDataUrl(session.audioOutput) ? undefined : session.audioOutput,
    streamingArtifactHtml: undefined,
    streamingArtifactCsv: undefined,
    messages: session.messages.map(messageForPersistence),
  };
}

/** Lightweight stub for non-active chats in the localStorage mirror only. */
export function sessionStubForLocalMirror(session: ChatSession): ChatSession {
  return {
    id: session.id,
    title: session.title,
    messages: [],
    streamingContent: "",
    loading: false,
    audioOutputs: [],
    cancelled: false,
    ragResult: null,
    mediaAssets: {},
    createdAt: session.createdAt,
  };
}
