import type { ChatMessage, ChatSession } from "../types";

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
  return {
    ...session,
    streamingContent: "",
    loading: false,
    cancelled: false,
    streamingArtifactHtml: undefined,
    streamingArtifactCsv: undefined,
    messages: session.messages.map((m) => ({
      ...m,
      streamingArtifactHtml: undefined,
      streamingArtifactCsv: undefined,
    })),
  };
}
