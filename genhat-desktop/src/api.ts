import { invoke, convertFileSrc as tauriConvertFileSrc } from "@tauri-apps/api/core";
import type {
  ChatMessage,
  DiscoveredModelUnit,
  ModelFile,
  RegisteredModel,
  IngestionStatus,
  RagResult,
  RagStreamSetup,
  DirectDocumentPromptSetup,
  InspectedAttachment,
  PreparedCloudAttachment,
  PdfParserEngine,
  MediaAsset,
  PodcastRequest,
  PodcastResult,
  ImportDownloadedModelRequest,
  WorkspaceOpenResult,
  WorkspaceRecord,
  RagModelPreferences,
  ChatContextCompactionRequest,
  ChatContextCompactionResult,
  WebSearchResult,
  IntentDecision,
  SpreadsheetPlan,
  PresentationPlan,
  HtmlPlan,
  ArtifactResult,
  ArtifactImageAsset,
  LlmMessage,
  UserProfile,
  AvatarSource,
} from "./types";
import {
  llamaContextKey,
  resolveLlamaSlot,
} from "./app/llamaSlotAffinity";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useSessionStore } from "./stores/sessionStore";

/** Pin chat completions to a per-session/workspace llama-server KV slot. */
function resolveRequestIdSlot(opts?: {
  idSlot?: number | null;
  sessionId?: string | null;
  workspaceId?: string | null;
}): number {
  if (typeof opts?.idSlot === "number" && Number.isFinite(opts.idSlot) && opts.idSlot >= 0) {
    return Math.floor(opts.idSlot);
  }
  const workspaceId =
    opts?.workspaceId ??
    useWorkspaceStore.getState().activeWorkspace?.id ??
    "default";
  const sessionId =
    opts?.sessionId ?? (useSessionStore.getState().activeSessionId || "anon");
  return resolveLlamaSlot(llamaContextKey(workspaceId, sessionId));
}

export interface HFModel {
  _id: string;
  id: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  [key: string]: unknown;
}

export interface HFRepoFile {
  type: string;
  oid: string;
  size: number;
  path: string;
  file_name?: string;
  [key: string]: unknown;
}

/** Documented model requirements from README.md */
export interface DocumentedRequirements {
  minRAM?: number;        // GB
  recommendedRAM?: number; // GB
  minVRAM?: number;       // GB
  contextLength?: number;
  source: 'documented' | 'estimated';
  notes?: string;
}

/** Device hardware specifications */
export interface DeviceSpecs {
  total_ram_mb: number;
  available_ram_mb: number;
  total_ram_gb: number;
  available_ram_gb: number;
  cpu_cores: number;
  cpu_has_avx2?: boolean;
  cpu_model: string;
  os: string;
  available_disk_gb: number;
  total_disk_gb: number;
  /** The models directory path being used for disk space calculation */
  models_dir?: string;
}

/** Model compatibility rating */
export type CompatibilityRating =
  | "efficient"
  | "usable"
  | "veryslow"
  | "satisfies"
  | "notrecommended"
  | "wontrun"
  | "unknown";

/** Model tier classification */
export type ModelTier = "tiny" | "small" | "medium" | "large" | "verylarge";

/** Detailed breakdown of compatibility factors */
export interface CompatibilityDetails {
  ram_check: string;
  disk_check: string;
  cpu_check: string;
  performance_notes: string[];
}

/** Compatibility check result */
export interface ModelCompatibility {
  rating: CompatibilityRating;
  reason: string;
  estimated_memory_mb: number;
  available_memory_mb: number;
  can_run: boolean;
  disk_space_sufficient: boolean;
  required_disk_gb: number;
  available_disk_gb: number;
  ram_usage_percent: number;
  disk_usage_percent: number;
  cpu_suitable: boolean;
  details: CompatibilityDetails;
  calculation?: {
    model_params: string;
    quant_level: string;
    base_fp16_size_gb: number;
    quant_multiplier: number;
    estimated_file_size_gb: number;
    actual_file_size_gb: number;
    ram_multiplier: number;
    assumed_context: number;
    required_ram_gb: number;
    total_ram_gb: number;
    available_ram_gb: number;
    ram_decision: "OK" | "NOT_RECOMMENDED" | "DO_NOT_DOWNLOAD" | string;
    cpu_cores: number;
    cpu_has_avx2: boolean;
    cpu_score: number;
    model_factor: number;
    quant_boost: number;
    perf_score: number;
    perf_classification: string;
  };
  alternative?: {
    suggestion: string;
    reason: string;
  };
}

export interface GgufMetadata {
  [key: string]: unknown;
}

export interface PerformanceScore {
  [key: string]: unknown;
}

export const Api = {
  // ── Model Management ───────────────────────────────────────────────────────

  /** List LLM .gguf model files from the LiquidAI-LLM subfolder. */
  async listModels(): Promise<ModelFile[]> {
    return invoke<ModelFile[]>("list_models");
  },

  /** List VLM .gguf model files from the LiquidAI-VLM subfolder. */
  async listVisionModels(): Promise<ModelFile[]> {
    return invoke<ModelFile[]>("list_vision_models");
  },

  /** List all registered models with their current status and supported tasks. */
  async listRegisteredModels(): Promise<RegisteredModel[]> {
    return invoke<RegisteredModel[]>("list_registered_models");
  },

  /** List all models defined in models.toml, including not-yet-downloaded entries. */
  async listModelCatalog(): Promise<RegisteredModel[]> {
    return invoke<RegisteredModel[]>("list_model_catalog");
  },

  /** Scan model folders and return discovered repo-container model units. */
  async discoverLocalModelUnits(): Promise<DiscoveredModelUnit[]> {
    return invoke<DiscoveredModelUnit[]>("discover_local_model_units");
  },

  /** Force runtime sync from disk-scanned model units. */
  async syncDiscoveredModels(): Promise<RegisteredModel[]> {
    return invoke<RegisteredModel[]>("sync_discovered_models");
  },

  /** Update runtime params for a registered model. */
  async updateModelParams(
    modelId: string,
    params: Record<string, string>
  ): Promise<RegisteredModel> {
    return invoke<RegisteredModel>("update_model_params", { modelId, params });
  },

  async downloadModel(modelId: string): Promise<void> {
    return invoke<void>("download_model", { modelId });
  },

  async downloadModelCategory(category: "embedding" | "grader" | "classifier"): Promise<number> {
    return invoke<number>("download_model_category", { category });
  },

  async cancelDownload(modelId: string): Promise<void> {
    return invoke<void>("cancel_download", { modelId });
  },

  async uninstallModel(modelId: string): Promise<void> {
    return invoke<void>("uninstall_model", { modelId });
  },

  /** Switch to a different LLM model by registry ID or file path. */
  async switchModel(modelIdentifier: string): Promise<string> {
    return invoke<string>("switch_model", { modelIdentifier });
  },

  /** Stop the currently active LLM server. */
  async stopLlama(): Promise<void> {
    await invoke("stop_llama");
  },

  /** Get the HTTP port of the running llama-server (triggers lazy start). */
  async getLlamaPort(modelId?: string | null): Promise<number> {
    return invoke<number>("get_llama_port", {
      modelId: modelId?.trim() ? modelId.trim() : null,
    });
  },

  /** Get estimated total memory usage of all loaded models (MB). */
  async getMemoryUsage(): Promise<number> {
    return invoke<number>("get_memory_usage");
  },

  /** Get a workspace identifier (cwd) for scoping local UI persistence. */
  async getWorkspaceScope(): Promise<string> {
    return invoke<string>("get_workspace_scope");
  },

  /** List all known app workspaces. */
  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return invoke<WorkspaceRecord[]>("list_workspaces");
  },

  /** Get currently active app workspace metadata. */
  async getActiveWorkspace(): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("get_active_workspace");
  },

  /** Clear the active workspace (shows startup modal on next app load). */
  async clearActiveWorkspace(): Promise<void> {
    return invoke<void>("clear_active_workspace");
  },

  /** Create a new workspace and make it active. */
  async createWorkspace(name?: string): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("create_workspace", {
      name: name ?? null,
    });
  },

  /** Open an existing workspace by id and make it active. */
  async openWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("open_workspace", {
      workspaceId,
    });
  },

  /** Delete a workspace by id; returns the active workspace after deletion. */
  async deleteWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("delete_workspace", {
      workspaceId,
    });
  },

  /** Rename a workspace by id; persists in the workspace registry. */
  async renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("rename_workspace", {
      workspaceId,
      name,
    });
  },

  /** Attach/update the saved .nela file path for a workspace. */
  async setWorkspaceFile(workspaceId: string, nelaPath: string): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("set_workspace_file", {
      workspaceId,
      nelaPath,
    });
  },

  /** Read persisted frontend state JSON for the active workspace. */
  async getWorkspaceFrontendState(): Promise<string | null> {
    return invoke<string | null>("get_workspace_frontend_state");
  },

  /** Persist frontend state JSON for the active workspace. */
  async saveWorkspaceFrontendState(frontendStateJson: string): Promise<void> {
    await invoke("save_workspace_frontend_state", {
      frontendStateJson,
    });
  },

  /** Save active workspace to a chosen .nela file path. */
  async saveWorkspaceAsNela(
    nelaPath: string,
    frontendStateJson?: string
  ): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("save_workspace_as_nela", {
      nelaPath,
      frontendStateJson: frontendStateJson ?? null,
    });
  },

  /** Save active workspace to its already-associated .nela path. */
  async saveWorkspaceNela(frontendStateJson?: string): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("save_workspace_nela", {
      frontendStateJson: frontendStateJson ?? null,
    });
  },

  /** Open/import a .nela file and make its workspace active. */
  async openWorkspaceNela(
    nelaPath: string,
    name?: string
  ): Promise<WorkspaceOpenResult> {
    return invoke<WorkspaceOpenResult>("open_workspace_nela", {
      nelaPath,
      name: name ?? null,
    });
  },

  /** Get RAG model preferences for a workspace. */
  async getRagModelPreferences(workspaceId: string): Promise<RagModelPreferences> {
    return invoke<RagModelPreferences>("get_rag_model_preferences", {
      workspaceId,
    });
  },

  /** Save RAG model preferences for a workspace. */
  async saveRagModelPreferences(
    workspaceId: string,
    prefs: RagModelPreferences
  ): Promise<void> {
    await invoke("save_rag_model_preferences", {
      workspaceId,
      prefs,
    });
  },

  /** Manually start (pre-warm) a model by ID. */
  async startModel(modelId: string): Promise<string> {
    return invoke<string>("start_model", { modelId });
  },

  /** Stop a model (all instances) by ID. */
  async stopModel(modelId: string): Promise<void> {
    await invoke("stop_model", { modelId });
  },

  /** Get the runtime status of a specific model. */
  async getModelStatus(modelId: string): Promise<unknown> {
    return invoke("get_model_status", { modelId });
  },

  // ── Audio ──────────────────────────────────────────────────────────────────

  /** Generate speech from text using the TTS backend. Returns a playable data URL. */
  async generateSpeech(
    input: string,
    options?: { voice?: string; speed?: number }
  ): Promise<string> {
    // Backend returns a data:audio/wav;base64,… URL directly
    return invoke<string>("generate_speech", {
      input,
      voice: options?.voice ?? null,
      speed: options?.speed ?? null,
    });
  },

  /** Transcribe an audio file to text using Whisper. */
  async transcribeAudio(audioPath: string): Promise<unknown> {
    return invoke("transcribe_audio", { audioPath });
  },

  /**
   * Transcribe audio from base64-encoded WAV data.
   * Used for real-time voice input from the browser's microphone.
   */
  async transcribeAudioBase64(audioBase64: string): Promise<string> {
    return invoke<string>("transcribe_audio_base64", { audioBase64 });
  },

  /** Start recording from the native microphone (bypasses WebView limitations). */
  async startMicRecording(): Promise<void> {
    return invoke<void>("start_mic_recording");
  },

  /** Stop native mic recording and return base64-encoded 16 kHz mono WAV. */
  async stopMicRecording(): Promise<string> {
    return invoke<string>("stop_mic_recording");
  },

  /**
   * Generate a speech chunk for streaming TTS.
   * Returns a base64-encoded WAV audio chunk.
   */
  async generateSpeechChunk(
    text: string,
    options?: { voice?: string; speed?: number }
  ): Promise<string> {
    return invoke<string>("generate_speech_chunk", {
      text,
      voice: options?.voice ?? null,
      speed: options?.speed ?? null,
    });
  },

  // ── Vision ─────────────────────────────────────────────────────────────────

  /** Read an image file and return it as a base64-encoded data URL (for preview). */
  async readImageBase64(path: string): Promise<string> {
    return invoke<string>("read_image_base64", { path });
  },

  /** Send image + prompt to VLM and return full response (non-streaming). */
  async visionChat(imagePath: string, prompt: string): Promise<string> {
    return invoke<string>("vision_chat", { imagePath, prompt });
  },

  /**
   * Start streaming vision chat. Emits "vision-stream" Tauri events.
   * Frontend should `listen("vision-stream", handler)` before calling this.
   */
  async visionChatStream(
    imagePath: string | undefined,
    prompt: string,
    modelId?: string
  ): Promise<void> {
    await invoke("vision_chat_stream", {
      imagePath: imagePath ?? null,
      prompt,
      modelId: modelId || null,
    });
  },

  // ── RAG ────────────────────────────────────────────────────────────────────

  /** Ingest a single document into the RAG knowledge base. */
  async ingestDocument(path: string): Promise<IngestionStatus> {
    return invoke<IngestionStatus>("ingest_document", { path });
  },

  /** Ingest all supported files in a directory. */
  async ingestFolder(path: string): Promise<IngestionStatus[]> {
    return invoke<IngestionStatus[]>("ingest_folder", { path });
  },

  /** List filesystem entries for the custom RAG source selector UI. */
  async listFsEntries(dirPath: string, allowedExtensions: string[]): Promise<import("./types").FsEntry[]> {
    return invoke<import("./types").FsEntry[]>("list_fs_entries", {
      path: dirPath,
      allowedExtensions,
      maxEntries: 1000,
    });
  },

  /** Top-level roots for the in-app filesystem browser (no OS dialog). */
  async listFsRoots(): Promise<import("./types").FsEntry[]> {
    return invoke<import("./types").FsEntry[]>("list_fs_roots");
  },

  /** Query the RAG pipeline (non-streaming). */
  async queryRag(query: string, topK?: number): Promise<RagResult> {
    return invoke<RagResult>("query_rag", { query, topK });
  },

  /**
   * Start structural knowledge-graph indexing for a directory.
   * Progress arrives on the `indexing-progress` event.
   */
  async startIndexingDirectory(
    path: string
  ): Promise<import("./types").DocGraphPipelineReport> {
    return invoke<import("./types").DocGraphPipelineReport>(
      "start_indexing_directory",
      { path }
    );
  },

  /** Hybrid RRF + subgraph expansion → Markdown context. */
  async queryKnowledgeBase(query: string, topK?: number): Promise<string> {
    return invoke<string>("query_knowledge_base", {
      query,
      topK: topK ?? null,
    });
  },

  async getKnowledgeBaseStats(): Promise<import("./types").DocGraphStats> {
    return invoke<import("./types").DocGraphStats>("get_knowledge_base_stats");
  },

  /** Pass 2 background retry status (deferred timeouts / retriable parse errors). */
  async getBackgroundIndexStatus(): Promise<
    import("./types").DocGraphBackgroundStatus
  > {
    return invoke<import("./types").DocGraphBackgroundStatus>(
      "get_background_index_status"
    );
  },

  async clearKnowledgeBase(): Promise<void> {
    await invoke("clear_knowledge_base");
  },

  /**
   * Search the web via the NELA backend Tavily proxy.
   * @param query - Search query (trimmed to 400 chars by backend).
   * @param maxResults - Number of results to return (1–10).
   * @param opts.profile - simple (default) | news | research (advanced depth + full content).
   * @param opts.site - Restrict results to one domain (e.g. "booking.com").
   * @param opts.timeRange - Recency filter: day | week | month | year.
   */
  async webSearch(
    query: string,
    maxResults: number,
    opts?: {
      profile?: import("./types").WebSearchProfile;
      site?: string;
      timeRange?: "day" | "week" | "month" | "year";
    }
  ): Promise<WebSearchResult> {
    return invoke<WebSearchResult>("web_search", {
      query,
      maxResults,
      profile: opts?.profile ?? null,
      site: opts?.site ?? null,
      timeRange: opts?.timeRange ?? null,
    });
  },

  /**
   * Extract clean markdown content from up to 5 URLs (Tavily Extract proxy).
   * @param urls - URLs to read (http/https only).
   * @param query - Optional intent used to rerank extracted chunks.
   * @param depth - basic (default) | advanced (tables/embedded content).
   */
  async webExtract(
    urls: string[],
    query?: string,
    depth?: "basic" | "advanced"
  ): Promise<import("./types").WebExtractResult> {
    return invoke<import("./types").WebExtractResult>("web_extract", {
      urls,
      query: query ?? null,
      depth: depth ?? null,
    });
  },

  /**
   * Streaming RAG query — retrieves sources immediately, then returns
   * the llama-server port + augmented prompt for frontend SSE streaming.
   */
  async queryRagStream(
    query: string,
    topK?: number
  ): Promise<RagStreamSetup> {
    return invoke<RagStreamSetup>("query_rag_stream", { query, topK });
  },

  /**
   * Build a direct-to-model prompt from attached files, bypassing RAG retrieval.
   */
  async prepareDirectDocumentPrompt(
    query: string,
    filePaths: string[],
    options?: { maxCharsPerDocument?: number; maxTotalChars?: number }
  ): Promise<DirectDocumentPromptSetup> {
    return invoke<DirectDocumentPromptSetup>("prepare_direct_document_prompt", {
      query,
      filePaths,
      maxCharsPerDocument: options?.maxCharsPerDocument ?? null,
      maxTotalChars: options?.maxTotalChars ?? null,
    });
  },

  async inspectAttachments(paths: string[]): Promise<InspectedAttachment[]> {
    return invoke<InspectedAttachment[]>("inspect_attachments", { paths });
  },

  async prepareCloudAttachments(
    files: Array<{ path: string; pdfEngine?: PdfParserEngine | null }>
  ): Promise<PreparedCloudAttachment[]> {
    return invoke<PreparedCloudAttachment[]>("prepare_cloud_attachments", {
      files: files.map((file) => ({
        path: file.path,
        pdfEngine: file.pdfEngine ?? null,
      })),
    });
  },

  /** List all ingested documents with their ingestion status. */
  async listRagDocuments(): Promise<IngestionStatus[]> {
    return invoke<IngestionStatus[]>("list_rag_documents");
  },

  /** Delete a document from the knowledge base. */
  async deleteRagDocument(docId: number): Promise<void> {
    await invoke("delete_rag_document", { docId });
  },

  async deleteAllRagDocuments(): Promise<number> {
    return invoke<number>("delete_all_rag_documents");
  },

  /** Read a file as base64 data URL for the frontend viewer. */
  async readFileBase64(path: string): Promise<string> {
    return invoke<string>("read_file_base64", { path });
  },

  /** Read a text-based file and return its content as a string. */
  async readFileText(path: string): Promise<string> {
    return invoke<string>("read_file_text", { path });
  },

  // ── Podcast ────────────────────────────────────────────────────────────────

  /** Generate a podcast from a RAG query with two-person dialogue + TTS. */
  async generatePodcast(request: PodcastRequest): Promise<PodcastResult> {
    return invoke<PodcastResult>("generate_podcast", { request });
  },

  /** Manually trigger a round of background enrichment. */
  async enrichRagDocuments(batchSize?: number): Promise<number> {
    return invoke<number>("enrich_rag_documents", { batchSize });
  },

  // ── RAPTOR ─────────────────────────────────────────────────────────────────

  /** Build a RAPTOR tree for a specific document (Phase 3). */
  async buildRaptorTree(docId: number): Promise<unknown> {
    return invoke("build_raptor_tree", { docId });
  },

  /** Check if a document has a RAPTOR tree. */
  async hasRaptorTree(docId: number): Promise<boolean> {
    return invoke<boolean>("has_raptor_tree", { docId });
  },

  /** Delete the RAPTOR tree for a document. */
  async deleteRaptorTree(docId: number): Promise<void> {
    await invoke("delete_raptor_tree", { docId });
  },

  /** Query using RAPTOR tree with confidence-aware traversal. */
  async queryRagWithRaptor(
    docId: number,
    query: string,
    topK?: number
  ): Promise<RagResult> {
    return invoke<RagResult>("query_rag_with_raptor", { docId, query, topK });
  },

  /** Streaming RAPTOR query — retrieve + return setup for SSE streaming. */
  async queryRagWithRaptorStream(
    docId: number,
    query: string,
    topK?: number
  ): Promise<RagStreamSetup> {
    return invoke<RagStreamSetup>("query_rag_with_raptor_stream", {
      docId,
      query,
      topK,
    });
  },

  // ── Media Retrieval ────────────────────────────────────────────────────────

  /**
   * Two-phase media retrieval: given the LLM's response text, find images/tables
   * whose captions are semantically similar to the response content.
   * Returns media assets that should be displayed alongside the chat answer.
   */
  async retrieveMediaForResponse(
    responseText: string,
    topK?: number,
    threshold?: number
  ): Promise<MediaAsset[]> {
    return invoke<MediaAsset[]>("retrieve_media_for_response", {
      responseText,
      topK: topK ?? null,
      threshold: threshold ?? null,
    });
  },

  /** Get all media assets for a specific ingested document. */
  async getMediaForDocument(docId: number): Promise<MediaAsset[]> {
    return invoke<MediaAsset[]>("get_media_for_document", { docId });
  },

  /**
   * Convert an absolute file path to a Tauri asset URL for display in an <img> tag.
   * Uses Tauri's convertFileSrc to create a localhost URL the webview can load.
   */
  mediaUrl(filePath: string): string {
    return convertFileSrc(filePath);
  },

  // ── Inference Routing ──────────────────────────────────────────────────────

  /**
   * Route any TaskRequest through the backend TaskRouter.
   * Supports: chat, summarize, mindmap, tts, podcast_script, transcribe,
   * embed, classify, enrich, grade, hyde, vision_chat, and custom tasks.
   */
  async routeRequest(
    taskType: string,
    input: string,
    modelOverride?: string,
    extra?: Record<string, string>
  ): Promise<unknown> {
    return invoke("route_request", {
      taskType,
      input,
      modelOverride: modelOverride || null,
      extra: extra || null,
    });
  },

  /** Analyze or compact chat context using backend token estimation and summarization fallback. */
  async compactChatContext(
    req: ChatContextCompactionRequest
  ): Promise<ChatContextCompactionResult> {
    return invoke<ChatContextCompactionResult>("compact_chat_context", {
      req,
    });
  },

  // ── Streaming Chat (HTTP → llama-server) ───────────────────────────────────

  /** Map internal LLM messages to OpenAI chat roles llama-server accepts. */
  llmMessagesForApi(
    messages: Array<Pick<ChatMessage, "role" | "content"> | LlmMessage>
  ): Array<{ role: string; content: string }> {
    return messages.map((m) => {
      if (m.role === "tool") {
        const name = "name" in m && m.name ? m.name : "tool";
        return {
          role: "user",
          content: `Tool result (${name}):\n${m.content}`,
        };
      }
      return { role: m.role, content: m.content };
    });
  },

  /**
   * Non-streaming chat completion via llama-server's OpenAI-compatible endpoint.
   * Used for tool-decision rounds and short structured completions.
   */
  async completeChat(
    messages: Array<Pick<ChatMessage, "role" | "content"> | LlmMessage>,
    options?: {
      port?: number;
      modelId?: string | null;
      signal?: AbortSignal;
      disableThinking?: boolean;
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      topK?: number;
      repeatPenalty?: number;
      grammar?: string;
      /** Override llama-server KV slot; defaults to active workspace+session affinity. */
      idSlot?: number | null;
      sessionId?: string | null;
      workspaceId?: string | null;
    }
  ): Promise<{ content: string; thinking: string }> {
    const llamaPort =
      options?.port ||
      (await invoke<number>("get_llama_port", {
        modelId: options?.modelId?.trim() ? options.modelId.trim() : null,
      }));

    const requestBody: Record<string, unknown> = {
      messages: this.llmMessagesForApi(messages),
      stream: false,
      model: options?.modelId?.trim() || "local",
      cache_prompt: true,
      id_slot: resolveRequestIdSlot(options),
      max_tokens: options?.maxTokens ?? 512,
      temperature: options?.temperature ?? 0.3,
      top_p: options?.topP ?? 0.95,
      top_k: options?.topK ?? 40,
      repeat_penalty: options?.repeatPenalty ?? 1.1,
    };

    if (options?.grammar) {
      requestBody.grammar = options.grammar;
    }

    const shouldDisableThinking = options?.disableThinking ?? true;
    if (!shouldDisableThinking) {
      requestBody.reasoning_format = "deepseek";
      requestBody.reasoning_budget = -1;
      requestBody.chat_template_kwargs = { enable_thinking: true };
    } else {
      requestBody.reasoning_format = "none";
      requestBody.reasoning_budget = 0;
      requestBody.chat_template_kwargs = { enable_thinking: false };
    }

    const res = await fetch(`http://127.0.0.1:${llamaPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: options?.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => res.statusText);
      throw new Error(`LLM server returned ${res.status}: ${errBody}`);
    }

    const parsed = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
      }>;
    };
    const message = parsed.choices?.[0]?.message;
    return {
      content: (message?.content ?? "").trim(),
      thinking: (message?.reasoning_content ?? "").trim(),
    };
  },

  /**
   * Stream a chat completion via llama-server's OpenAI-compatible SSE endpoint.
   * Fetches the dynamic port from the backend unless one is provided.
   */
  async streamChat(
    messages: Array<Pick<ChatMessage, "role" | "content"> | LlmMessage>,
    onChunk: (chunk: string) => void,
    onThinking: (thinking: string) => void,
    onFinish: () => void,
    onError: (err: unknown) => void,
    port?: number,
    modelId?: string | null,
    signal?: AbortSignal,
    disableThinking?: boolean,
    generationOptions?: {
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      topK?: number;
      repeatPenalty?: number;
      grammar?: string;
      /** Override llama-server KV slot; defaults to active workspace+session affinity. */
      idSlot?: number | null;
      sessionId?: string | null;
      workspaceId?: string | null;
    }
  ) {
    try {
      const apiMessages = this.llmMessagesForApi(messages);

      const llamaPort =
        port ||
        (await invoke<number>("get_llama_port", {
          modelId: modelId?.trim() ? modelId.trim() : null,
        }));

      const requestBody: Record<string, unknown> = {
        messages: apiMessages,
        stream: true,
        // Route via llama-server router preset section (GenHat model id).
        model: modelId?.trim() || "local",
        // Reuse KV cache prefix across turns (O(1) decode). Without this,
        // llama-server may re-prefill the entire growing transcript each request.
        cache_prompt: true,
        // Isolate prompt cache per chat/workspace (see llamaSlotAffinity).
        id_slot: resolveRequestIdSlot(generationOptions),
        max_tokens: generationOptions?.maxTokens ?? 2048,
        temperature: generationOptions?.temperature ?? 0.7,
        top_p: generationOptions?.topP ?? 0.95,
        top_k: generationOptions?.topK ?? 40,
        repeat_penalty: generationOptions?.repeatPenalty ?? 1.1,
      };

      if (generationOptions?.grammar) {
        requestBody.grammar = generationOptions.grammar;
      }

      // Reasoning is OFF by default; callers can enable by passing disableThinking=false.
      // IMPORTANT: When disabling, set ALL THREE:
      //   - reasoning_budget = 0 (disables generation of thinking tokens)
      //   - reasoning_format = "none" (prevents parsing of <think> tags)
      //   - chat_template_kwargs = {"enable_thinking": false} (for Qwen3 models)
      const shouldDisableThinking = disableThinking ?? true;
      if (!shouldDisableThinking) {
        requestBody.reasoning_format = "deepseek";
        requestBody.reasoning_budget = -1; // Unrestricted
        requestBody.chat_template_kwargs = { enable_thinking: true };
      } else {
        requestBody.reasoning_format = "none"; // Prevent <think> tag parsing
        requestBody.reasoning_budget = 0; // Disable thinking generation
        requestBody.chat_template_kwargs = { enable_thinking: false };
      }

      const postCompletion = async (body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${llamaPort}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });

      let res = await postCompletion(requestBody);

      // If llama-server rejects the GBNF (parse/sampler init) — or the process
      // crashes under grammar load ("proxy error: Failed to read connection") —
      // retry without grammar. Artifact plan parsers already repair free-form JSON.
      if (
        !res.ok &&
        generationOptions?.grammar &&
        requestBody.grammar
      ) {
        const errBody = await res.text().catch(() => res.statusText);
        const shouldRetryWithoutGrammar =
          /failed to parse grammar|Failed to initialize samplers|grammar|proxy error|Failed to read connection|connection reset|ECONNRESET|timed?\s*out|context.*(size|length|window)|out of memory/i.test(
            errBody
          );
        if (shouldRetryWithoutGrammar) {
          console.warn(
            "LLM request failed with grammar; retrying without grammar:",
            errBody
          );
          const retryBody = { ...requestBody };
          delete retryBody.grammar;
          // Slightly smaller output budget on retry to reduce crash risk.
          if (typeof retryBody.max_tokens === "number") {
            retryBody.max_tokens = Math.max(
              256,
              Math.floor((retryBody.max_tokens as number) * 0.6)
            );
          }
          res = await postCompletion(retryBody);
          if (!res.ok) {
            const retryErr = await res.text().catch(() => res.statusText);
            throw new Error(`LLM server returned ${res.status}: ${retryErr}`);
          }
        } else {
          throw new Error(`LLM server returned ${res.status}: ${errBody}`);
        }
      } else if (!res.ok) {
        const errBody = await res.text().catch(() => res.statusText);
        throw new Error(`LLM server returned ${res.status}: ${errBody}`);
      }

      if (!res.body)
        throw new Error("No response body received from local LLM");

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;

          const payload = line.replace("data:", "").trim();
          if (payload === "[DONE]") {
            onFinish();
            return;
          }

          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta;
            
            // Handle reasoning/thinking content
            const reasoningContent = delta?.reasoning_content;
            if (reasoningContent) {
              onThinking(reasoningContent);
            }
            
            // Handle regular content
            const content = delta?.content;
            if (content) {
              onChunk(content);
            }
          } catch (e) {
            console.warn("Failed to parse SSE JSON chunk", e);
          }
        }
      }

      onFinish();
    } catch (err) {
      // AbortError means the user cancelled — stop silently without error msg
      if (err instanceof DOMException && err.name === "AbortError") return;
      onError(err);
    }
  },

  // ── Hugging Face & Custom Downloads ────────────────────────────────────────

  /**
   * Invokes the Taurus backend to download an arbitrary file to a specified folder.
   */
  async downloadCustomFile(
    url: string,
    folder: string,
    filename: string,
    options?: { repoId?: string; relativePath?: string }
  ): Promise<void> {
    return invoke<void>("download_custom_file", {
      url,
      folder,
      filename,
      repoId: options?.repoId ?? null,
      relativePath: options?.relativePath ?? null,
    });
  },
  
  /**
   * Checks if a custom downloaded file already exists on disk.
   */
  async checkCustomFileExists(
    folder: string,
    filename: string,
    options?: { repoId?: string; relativePath?: string }
  ): Promise<boolean> {
    return invoke<boolean>("check_custom_file_exists", {
      folder,
      filename,
      repoId: options?.repoId ?? null,
      relativePath: options?.relativePath ?? null,
    });
  },

  /** Import a downloaded GGUF into runtime and persist custom registration. */
  async importDownloadedModel(request: ImportDownloadedModelRequest): Promise<RegisteredModel> {
    return invoke<RegisteredModel>("import_downloaded_model", { req: request });
  },

  async unregisterCustomModel(modelId: string): Promise<void> {
    await invoke("unregister_custom_model", { modelId });
  },

  /**
   * Searches Hugging Face for GGUF models matching a query.
   */
  async searchHuggingFace(query: string): Promise<HFModel[]> {
    const res = await fetch(`https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&limit=20`);
    if (!res.ok) {
      throw new Error(`HF search failed: ${res.statusText}`);
    }
    return res.json();
  },

  /**
   * Gets specific .gguf files inside a single Hugging Face repository.
   */
  async getHuggingFaceRepoFiles(repoId: string): Promise<HFRepoFile[]> {
    const res = await fetch(`https://huggingface.co/api/models/${repoId}/tree/main`);
    if (!res.ok) {
      throw new Error(`HF tree fetch failed: ${res.statusText}`);
    }
    const files: HFRepoFile[] = await res.json();
    return files.filter(f => f.type === "file" && f.path.endsWith(".gguf"));
  },

  /**
   * Try to fetch documented model requirements from README.md
   */
  async fetchModelDocumentation(repoId: string): Promise<DocumentedRequirements> {
    try {
      const res = await fetch(`https://huggingface.co/${repoId}/raw/main/README.md`);
      if (!res.ok) {
        return { source: 'estimated' };
      }
      
      const readme = await res.text();
      const result: DocumentedRequirements = { source: 'estimated' };
      
      // Try to parse various RAM requirement patterns
      // Patterns like: "RAM: 8GB", "Requires 16GB RAM", "Minimum: 8 GB"
      const ramPatterns = [
        /(?:minimum|min|requires?|needs?|ram:?)\s*(?:~|≈)?\s*(\d+(?:\.\d+)?)\s*gb/gi,
        /(\d+(?:\.\d+)?)\s*gb\s+(?:of\s+)?(?:ram|memory)/gi,
        /(?:recommended|rec):?\s*(?:~|≈)?\s*(\d+(?:\.\d+)?)\s*gb/gi
      ];
      
      for (const pattern of ramPatterns) {
        const matches = [...readme.matchAll(pattern)];
        for (const match of matches) {
          const value = parseFloat(match[1]);
          if (value > 0 && value < 1024) { // Sanity check
            if (!result.minRAM || value < result.minRAM) {
              result.minRAM = value;
              result.source = 'documented';
            }
          }
        }
      }
      
      // Try to find recommended RAM
      const recPatterns = [
        /recommended:?\s*(?:~|≈)?\s*(\d+(?:\.\d+)?)\s*gb/gi,
        /suggested:?\s*(?:~|≈)?\s*(\d+(?:\.\d+)?)\s*gb/gi
      ];
      
      for (const pattern of recPatterns) {
        const match = readme.match(pattern);
        if (match) {
          const value = parseFloat(match[1]);
          if (value > 0 && value < 1024) {
            result.recommendedRAM = value;
            result.source = 'documented';
          }
        }
      }
      
      // Try to find context length
      const contextPatterns = [
        /(?:context|ctx)(?:\s+length)?:?\s*(\d+)k?/gi,
        /(\d+)k?\s+(?:context|tokens)/gi
      ];
      
      for (const pattern of contextPatterns) {
        const match = readme.match(pattern);
        if (match) {
          let value = parseInt(match[1]);
          // If it says "8k context", multiply by 1024
          if (readme.toLowerCase().includes(`${value}k`)) {
            value *= 1024;
          }
          if (value >= 512 && value <= 128000) { // Sanity check
            result.contextLength = value;
          }
        }
      }
      
      return result;
    } catch (e) {
      console.error('Failed to fetch model documentation:', e);
      return { source: 'estimated' };
    }
  },

  // ── System Info & Compatibility ─────────────────────────────────────────────

  /** Get device specifications (RAM, CPU, OS, AVX2 support) */
  async getSystemSpecs(): Promise<DeviceSpecs> {
    return invoke<DeviceSpecs>("get_system_specs");
  },

  /** Check if a model is compatible with the current device */
  async checkCompatibility(
    fileSizeMb: number, 
    memoryMb?: number, 
    quantization?: string,
    filename?: string,
    contextLength?: number,
  ): Promise<ModelCompatibility> {
    return invoke<ModelCompatibility>("check_compatibility", {
      fileSizeMb,
      memoryMb: memoryMb ?? null,
      quantization: quantization ?? null,
      filename: filename ?? null,
      contextLength: contextLength ?? null,
    });
  },

  /** Get the model tier classification based on file size */
  async getModelTier(fileSizeMb: number): Promise<ModelTier> {
    return invoke<ModelTier>("get_model_tier", { fileSizeMb });
  },

  /** Estimate memory requirements for a model based on its file size */
  async estimateModelMemory(fileSizeMb: number): Promise<number> {
    return invoke<number>("estimate_model_memory", { fileSizeMb });
  },
  
  /** Detect quantization level from filename */
  async detectQuantization(filename: string): Promise<string> {
    return invoke<string>("detect_quantization", { filename });
  },
  
  /** Detect model parameter size from filename */
  async detectModelParams(filename: string): Promise<string> {
    return invoke<string>("detect_model_params", { filename });
  },

  /** Parse GGUF file and extract metadata (params, quant, context) */
  async parseModelMetadata(modelPath: string): Promise<GgufMetadata> {
    return invoke<GgufMetadata>("parse_model_metadata", { modelPath });
  },

  /** Calculate performance score for a model based on GGUF metadata */
  async calculateModelPerformance(modelPath: string): Promise<PerformanceScore> {
    return invoke<PerformanceScore>("calculate_model_performance", { modelPath });
  },

  /** Enhanced compatibility check with performance scoring */
  async checkCompatibilityWithPerformance(
    modelPath: string | null,
    fileSizeMb: number,
    memoryMb?: number
  ): Promise<ModelCompatibility> {
    return invoke<ModelCompatibility>("check_compatibility_with_performance", {
      modelPath,
      fileSizeMb,
      memoryMb: memoryMb ?? null,
    });
  },

  /** Batch check compatibility for multiple models */
  async batchCheckCompatibility(
    models: Array<[string, number]> // [path, file_size_mb]
  ): Promise<Array<[string, ModelCompatibility]>> {
    return invoke("batch_check_compatibility", { models });
  },

  /** Resolve macro-intent from prompt. */
  async resolveIntent(prompt: string, extra?: Record<string, string>): Promise<IntentDecision> {
    return invoke<IntentDecision>("resolve_intent", {
      request: { prompt, extra: extra ?? {} }
    });
  },

  /** Get GBNF grammar string for a specific schema/manifest ID. */
  async getSchemaGrammar(schemaId: string): Promise<string> {
    return invoke<string>("get_schema_grammar", { schemaId });
  },

  /** Generate spreadsheet artifact (rendered in-process). */
  async generateSpreadsheet(
    plan: SpreadsheetPlan | Record<string, unknown>
  ): Promise<ArtifactResult> {
    return invoke<ArtifactResult>("generate_spreadsheet", { plan });
  },

  /** Generate presentation artifact (rendered in-process). */
  async generatePresentation(
    plan: PresentationPlan | Record<string, unknown>
  ): Promise<ArtifactResult> {
    return invoke<ArtifactResult>("generate_presentation", { plan });
  },

  /** Parse a NELA HTML slide deck into slides + theme. */
  async parsePresentationDeck(path: string): Promise<{
    theme: string | null;
    slides: Record<string, unknown>[];
    slideCount: number;
    isNelaDeck: boolean;
  }> {
    return invoke("parse_presentation_deck", { request: { path } });
  },

  /** Append slides or replace a NELA HTML deck (parse → edit → re-render). */
  async editPresentationDeck(request: {
    path: string;
    appendSlides?: Record<string, unknown>[];
    insertAt?: number;
    replacementPlan?: Record<string, unknown>;
    outputName?: string;
  }): Promise<ArtifactResult> {
    return invoke<ArtifactResult>("edit_presentation_deck", { request });
  },

  /** Apply surgical presentation ops (theme/font/color/slide insert-patch-remove). */
  async applyPresentationOps(request: {
    path: string;
    ops: Record<string, unknown>[];
    outputName?: string;
  }): Promise<ArtifactResult> {
    return invoke<ArtifactResult>("apply_presentation_ops", { request });
  },

  /** Generate HTML artifact using the HTML sidecar. */
  async generateHtml(plan: HtmlPlan): Promise<ArtifactResult> {
    return invoke<ArtifactResult>("generate_html", { plan });
  },

  /** Parse cells/rows of spreadsheet files using Calamine/CSV. */
  async parseSpreadsheetData(
    path: string,
    maxRows?: number
  ): Promise<{
    sheet_name: string;
    rows: string[][];
    truncated?: boolean;
    sheets?: Array<{ sheet_name: string; rows: string[][]; truncated?: boolean }>;
  }> {
    return invoke<{
      sheet_name: string;
      rows: string[][];
      truncated?: boolean;
      sheets?: Array<{ sheet_name: string; rows: string[][]; truncated?: boolean }>;
    }>("parse_spreadsheet_data", {
      path,
      maxRows: maxRows ?? null,
    });
  },

  /** Aggregate chart points from spreadsheet rows (file-backed dashboards). */
  async aggregateSpreadsheetChart(request: {
    headers: string[];
    rows: string[][];
    labelColumn: string;
    valueColumn?: string | null;
    aggregation?: string | null;
    maxPoints?: number;
    sort?: string | null;
  }): Promise<Array<{ label: string; value: number }>> {
    return invoke<Array<{ label: string; value: number }>>(
      "aggregate_spreadsheet_chart",
      { request }
    );
  },

  /** Download a remote image as a base64 data URI for artifact embedding. */
  async downloadImageDataUri(url: string): Promise<string> {
    return invoke<string>("download_image_data_uri", { url });
  },

  /** Extract images from PDF/DOCX/PPTX as data URIs. */
  async extractDocumentImages(
    path: string,
    maxImages?: number
  ): Promise<ArtifactImageAsset[]> {
    return invoke<ArtifactImageAsset[]>("extract_document_images", { path, maxImages });
  },

  /**
   * Apply a unified diff patch, writing a **new** artifact file.
   * The original path is preserved. Returns the new file path.
   */
  async applyDiffPatch(path: string, patch: string): Promise<string> {
    return invoke<string>("apply_diff_patch", { path, patch });
  },

  /**
   * Write full text as a **new** artifact file (original path unchanged).
   * Used for deterministic freeform HTML slide inserts.
   */
  async writeArtifactCopy(
    path: string,
    contents: string,
    outputName?: string
  ): Promise<string> {
    return invoke<string>("write_artifact_copy", {
      path,
      contents,
      outputName: outputName ?? null,
    });
  },

  /** Write base64-encoded bytes to an absolute path (used by deck export). */
  async saveBinaryFile(path: string, contentsBase64: string): Promise<void> {
    await invoke("save_binary_file", { path, contentsBase64 });
  },

  /** Reveal file in OS file explorer and select it (P4 follow-up) */
  async revealInExplorer(path: string): Promise<void> {
    await invoke("reveal_in_explorer", { path });
  },

  /** Open a file with the OS default application. */
  async openPathInOs(path: string): Promise<void> {
    await invoke("open_path_in_os", { path });
  },

  /** Copy a file to a new absolute path (artifact download). */
  async copyFileToPath(source: string, dest: string): Promise<void> {
    await invoke("copy_file_to_path", { source, dest });
  },
};

// ── Playground / Pipeline commands ─────────────────────────────────────────────
// Imported directly by usePipelineStore to keep dependencies explicit.

import type { Pipeline } from "./app/playgroundTypes";

export async function listPipelines(): Promise<Pipeline[]> {
  return invoke<Pipeline[]>("playground_list_pipelines");
}

export async function loadPipeline(id: string): Promise<Pipeline> {
  return invoke<Pipeline>("playground_load_pipeline", { id });
}

export async function savePipeline(pipeline: Pipeline): Promise<void> {
  return invoke<void>("playground_save_pipeline", { pipeline });
}

export async function deletePipeline(id: string): Promise<void> {
  return invoke<void>("playground_delete_pipeline", { id });
}

export async function runPipeline(pipelineId: string): Promise<string> {
  return invoke<string>("playground_run_pipeline", { pipelineId });
}

export async function cancelPipelineRun(runId: string): Promise<void> {
  return invoke<void>("playground_cancel_run", { runId });
}

export async function storeCredential(key: string, value: string): Promise<void> {
  return invoke<void>("playground_store_credential", { key, value });
}

export async function exportPipelineFile(path: string, payload: string): Promise<void> {
  return invoke<void>("playground_export_pipeline", { path, payload });
}

// ── Watched Paths / Auto-discovery ───────────────────────────────────────────

export async function addWatchedPath(path: string): Promise<void> {
  return invoke<void>("add_watched_path", { path });
}

export async function removeWatchedPath(path: string): Promise<void> {
  return invoke<void>("remove_watched_path", { path });
}

export async function listWatchedPaths(): Promise<import("./types").WatchedPath[]> {
  return invoke<import("./types").WatchedPath[]>("list_watched_paths");
}

export async function triggerScan(): Promise<import("./types").ScanResult> {
  return invoke<import("./types").ScanResult>("trigger_scan");
}

// ── User profile / NELA Cloud auth ───────────────────────────────────────────

export type {
  UserProfile,
  AvatarSource,
  UserPlan,
  DeviceStartResponse,
  DevicePollResponse,
  EntitlementResponse,
  CheckoutResponse,
  CloudChatRequest,
} from "./types";

export async function getUserProfile(): Promise<UserProfile | null> {
  return invoke<UserProfile | null>("get_user_profile");
}

export async function saveUserProfile(input: {
  name: string;
  email: string;
  avatar?: AvatarSource | null;
}): Promise<UserProfile> {
  return invoke<UserProfile>("save_user_profile", { input });
}

export async function signOutUser(): Promise<void> {
  return invoke<void>("sign_out_user");
}

export async function saveUploadedAvatar(input: {
  imageBase64: string;
  mime: string;
}): Promise<AvatarSource> {
  return invoke<AvatarSource>("save_uploaded_avatar", { input });
}

export async function startCloudAuth(): Promise<
  import("./types").DeviceStartResponse
> {
  return invoke<import("./types").DeviceStartResponse>("cloud_auth_start");
}

export async function pollCloudAuth(
  deviceCode: string
): Promise<import("./types").DevicePollResponse> {
  return invoke<import("./types").DevicePollResponse>("cloud_auth_poll", {
    deviceCode,
  });
}

export async function emailLoginCloud(input: {
  email: string;
  password: string;
}): Promise<UserProfile> {
  return invoke<UserProfile>("cloud_auth_email_login", input);
}

export async function emailRegisterCloud(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<UserProfile> {
  return invoke<UserProfile>("cloud_auth_email_register", input);
}

export async function patchCloudProfile(input: {
  occupation?: string;
  field?: string;
  completeOnboarding?: boolean;
}): Promise<UserProfile> {
  return invoke<UserProfile>("cloud_patch_profile", {
    occupation: input.occupation,
    field: input.field,
    completeOnboarding: input.completeOnboarding,
  });
}

export async function refreshCloudToken(): Promise<void> {
  return invoke<void>("cloud_refresh_token");
}

export async function signOutCloud(): Promise<void> {
  return invoke<void>("cloud_sign_out");
}

export async function getCloudProfile(): Promise<UserProfile | null> {
  return invoke<UserProfile | null>("cloud_get_profile");
}

export async function getCloudEntitlement(): Promise<
  import("./types").EntitlementResponse
> {
  return invoke<import("./types").EntitlementResponse>("cloud_get_entitlement");
}

export async function createCloudCheckout(
  plan: "starter" | "pro"
): Promise<import("./types").CheckoutResponse> {
  return invoke<import("./types").CheckoutResponse>("cloud_create_checkout", {
    plan,
  });
}

/** Open the public website pricing page in the system browser. */
export async function openCloudPricing(): Promise<void> {
  return invoke<void>("cloud_open_pricing");
}

/** Open the website billing dashboard in the system browser. */
export async function openCloudBilling(): Promise<void> {
  return invoke<void>("cloud_open_billing");
}

/** Confirm latest Razorpay payment and activate Premium entitlement. */
export async function confirmCloudCheckout(): Promise<{
  ok: boolean;
  activated: boolean;
  paidCloud?: boolean;
  isPremium?: boolean;
  displayPlan?: string;
  plan?: string;
}> {
  return invoke("cloud_confirm_checkout");
}

export async function cloudCompleteChat(
  request: import("./types").CloudChatRequest
): Promise<string> {
  return invoke<string>("cloud_chat_complete", { request });
}

/**
 * Start streaming cloud chat. Emits "cloud-chat-stream" Tauri events.
 * Frontend should `listen("cloud-chat-stream", handler)` before calling this.
 */
export async function cloudStreamChat(
  request: import("./types").CloudChatRequest
): Promise<void> {
  return invoke<void>("cloud_chat_stream", { request });
}

function convertFileSrc(filePath: string): string {
  return tauriConvertFileSrc(filePath);
}

