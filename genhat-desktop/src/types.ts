export interface ModelFile {
  name: string;
  path: string;
  is_downloaded?: boolean;
  gdrive_id?: string | null;
  /** True when the model can be downloaded from Google Drive or Hugging Face. */
  downloadable?: boolean;
  memory_mb?: number;
}

export interface DiscoveredModelUnit {
  key: string;
  category: string;
  repo_id: string;
  container_rel_path: string;
  llm_rel_path: string;
  llm_abs_path: string;
  llm_file_name: string;
  mmproj_rel_path?: string;
  supports_vision: boolean;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  nela_path: string | null;
  cache_dir: string;
  created_at: number;
  last_opened_at: number;
}

export interface WorkspaceOpenResult {
  workspace: WorkspaceRecord;
  frontend_state_json: string | null;
}

export interface ChatMessage {
  /** Stable id for list keys / memoization (assigned on create or normalize). */
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Optional image attached to a user message in vision mode. */
  visionImage?: {
    path: string;
    name: string;
  };
  /** Optional files attached directly to a user message (non-RAG document grounding). */
  directDocuments?: DirectDocumentAttachment[];
  generateTime?: number;
  firstTokenTime?: number;
  /** Optional audio output URL for assistant messages (audio mode, podcasts, etc). */
  audioUrl?: string;
  /** Whether this audio is saved in the sidebar (true), unsaved (false), or not applicable (undefined). */
  audioSaved?: boolean;
  /** Optional thinking/reasoning content for assistant messages (from reasoning models). */
  thinking?: string;
  /** Optional web search sources attached to an assistant message. */
  webSearchResult?: WebSearchResult;
  /** Optional artifact path if this message generated one */
  artifactPath?: string | null;
  /** Optional artifact stage if this message is generating one */
  artifactStage?: string | null;
  /** Prefer side-panel chip UI instead of inline preview (Smart/Deep freeform). */
  artifactUseSidePanel?: boolean;
  /** Title shown on the artifact chip / panel. */
  artifactTitle?: string;
  /** Follow-up prose shown after the artifact chip (Claude-style). */
  artifactFollowup?: string;
  streamingArtifactHtml?: string;
  streamingArtifactCsv?: string;
  streamingArtifactType?: "text/html" | "text/csv";
  streamingArtifactTitle?: string;
  /** OpenRouter / local model id that produced this assistant turn. */
  generatedByModel?: string;
  /**
   * Spendable credit balance after this cloud turn (free-plan trial / packs).
   * Shown next to the model hover label for free-plan accounts.
   */
  creditsRemainingAfter?: number;
}

export interface ChatContextMessage {
  role: ChatMessage["role"];
  content: string;
}

/** Internal LLM API message (may include tool roles not shown in the chat UI). */
export type LlmMessageRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
  /** OpenAI-style tool call id when role is tool. */
  tool_call_id?: string;
  /** Tool name when role is tool or for assistant tool requests. */
  name?: string;
}

export interface ChatContextUsage {
  contextWindowTokens: number;
  usedTokens: number;
  reservedOutputTokens: number;
  projectedTokens: number;
  remainingTokens: number;
  remainingAfterReserveTokens: number;
  usedPercent: number;
  projectedPercent: number;
  thresholdPercent: number;
}

export interface ChatContextCompactionRequest {
  messages: ChatContextMessage[];
  contextWindowTokens?: number | null;
  reservedOutputTokens?: number | null;
  thresholdPercent?: number | null;
  allowAutoCompaction?: boolean | null;
  forceCompaction?: boolean | null;
  preserveRecentMessages?: number | null;
  modelOverride?: string | null;
}

export interface ChatContextCompactionResult {
  messages: ChatContextMessage[];
  usage: ChatContextUsage;
  compacted: boolean;
  summaryApplied: boolean;
  droppedMessages: number;
  reason: string;
  keptIndices: number[];
  summaryInsertIndex: number | null;
}

export interface RegisteredModel {
  id: string;
  name: string;
  backend?: string;
  tasks: string[];
  status: string;
  instance_count: number;
  memory_mb: number;
  priority: number;
  is_downloaded: boolean;
  model_file?: string;
  gdrive_id?: string | null;
  model_source?: string;
  model_profile?: string | null;
  engine_adapter?: string | null;
  params?: Record<string, string>;
}

export type ImportModelProfile = "llm" | "vlm";

export interface ImportDownloadedModelRequest {
  folder: string;
  filename: string;
  profile: ImportModelProfile;
  display_name?: string;
  mmproj_file?: string;
  engine_adapter?: string;
}

export interface IngestionStatus {
  doc_id: number;
  title: string;
  file_path: string;
  total_chunks: number;
  embedded_chunks: number;
  enriched_chunks: number;
  phase: string;
}

/// Directory/file entry returned by the custom RAG source selector.
export interface FsEntry {
  path: string;
  name: string;
  is_dir: boolean;
  size: number;
  mtime: number;
}

export interface SourceChunk {
  chunk_id: number;
  doc_title: string;
  text: string;
  score: number;
  /** Optional relevance grade (1-5) from the backend. */
  grade?: number | null;
  /** Page/slide provenance from the original document (e.g. "page:3", "slide:2"). */
  page_info?: string;
}

export interface RagResult {
  answer: string;
  sources: SourceChunk[];
}

export interface SearchHit {
  title: string;
  snippet: string;
  url: string;
  image_url?: string | null;
  /** Favicon URL for the source site (Gemini-style source cards). */
  favicon?: string | null;
  /** Tavily relevance score (0..1). */
  score?: number | null;
  /** Publish date for news results. */
  published_date?: string | null;
}

export type WebSearchProfile = "simple" | "news" | "research";

/** Tool-loop web depth (auto-router chooses; deep research uses the facet planner). */
export type WebDepth = "snippets" | "full";

export interface WebSearchResult {
  query: string;
  /** Distinct queries used across one or more tool rounds (for disclosure UI). */
  queries?: string[];
  results: SearchHit[];
  formatted_context: string;
  extracted_tables?: ExtractedWebTable[];
  /** Tavily answer seed (extra model context, not user-facing). */
  answer?: string | null;
  /** Query-level images for the UI gallery. */
  images?: string[];
}

export interface ExtractedPage {
  url: string;
  content: string;
  images?: string[];
}

export interface WebExtractResult {
  results: ExtractedPage[];
  formatted_context: string;
  extracted_tables?: ExtractedWebTable[];
  failed?: string[];
}

export interface ExtractedWebTable {
  headers: string[];
  rows: string[][];
  source_url: string;
  source_title: string;
}

export interface RagStreamSetup {
  sources: SourceChunk[];
  prompt: string;
  llama_port: number;
  no_retrieval: boolean;
}

export interface DirectDocumentAttachment {
  path: string;
  name: string;
}

export interface DirectDocumentUsed {
  file_path: string;
  title: string;
  chars_used: number;
  truncated: boolean;
}

export interface DirectDocumentPromptSetup {
  prompt: string;
  documents: DirectDocumentUsed[];
  warnings: string[];
  truncated: boolean;
}

/** A media asset (image or table) extracted from an ingested document. */
export interface MediaAsset {
  id: number;
  doc_id: number;
  /** "image" or "table" */
  asset_type: string;
  /** Absolute path to the extracted PNG file on disk. */
  file_path: string;
  /** Context-aware caption derived from surrounding document text. */
  caption: string;
  /** Source metadata (e.g. "page:3:image:2"). */
  metadata: string;
  caption_hash: string | null;
}

export interface MindMapNode {
  id: string;
  label: string;
  children: MindMapNode[];
}

export interface MindMapGraph {
  id: string;
  title: string;
  query: string;
  generatedFrom: "documents" | "model";
  sourceCount: number;
  root: MindMapNode;
  createdAt: number;
}

// ── Watched Paths / Auto-discovery ───────────────────────────────────────────

export interface WatchedPath {
  id: number;
  workspace_id: string;
  path: string;
  added_at: string;
}

export interface ScanProgress {
  status: string;
  found: number;
  ingested: number;
  skipped: number;
  errors: number;
  done: boolean;
}

export interface ScanResult {
  ingested: number;
  skipped: number;
  errors: number;
  total_files: number;
}

export type ChatMode = "text" | "vision" | "audio" | "rag" | "podcast" | "mindmap" | "playground";

// ── Multi-Chat Session ────────────────────────────────────────────────────────

/** Represents a single, independent chat session (tab). */
export interface ChatSession {
  /** Unique session identifier (UUID). */
  id: string;
  /** Display title for the tab — derived from the first user message. */
  title: string;
  /** All messages in this session. */
  messages: ChatMessage[];
  /** Partial content currently being streamed for this session. */
  streamingContent: string;
  /** Whether this session is waiting for an LLM response. */
  loading: boolean;
  /** Audio data URLs for all TTS outputs in this session. */
  audioOutputs: string[];
  /** (Deprecated) Last TTS output for backward compatibility. */
  audioOutput?: string;
  /** Set to true when user manually cancels generation. */
  cancelled: boolean;
  /** Latest RAG result (sources + answer) for this session. */
  ragResult: RagResult | null;
  /** Media assets keyed by message index. */
  mediaAssets: Record<number, MediaAsset[]>;
  /** Unix timestamp when this session was created (ms). */
  createdAt: number;
  /** Absolute path to the generated artifact on disk. */
  artifactPath?: string | null;
  /** The current pipeline stage of the generating artifact. */
  artifactStage?: string | null;
  /** True while a Claude-style artifact body is streaming into the side panel. */
  artifactStreamActive?: boolean;
  /** User-toggled visibility of the artifact side panel (content kept when closed). */
  artifactPanelOpen?: boolean;
  /** Live HTML/PPT body for the side panel. */
  streamingArtifactHtml?: string;
  /** Live CSV body for the side panel. */
  streamingArtifactCsv?: string;
  streamingArtifactType?: "text/html" | "text/csv";
  streamingArtifactTitle?: string;
}

/** Available KittenTTS voice names. */
export const KITTEN_TTS_VOICES = [
  "Bella",
  "Jasper",
  "Luna",
  "Bruno",
  "Rosie",
  "Hugo",
  "Kiki",
  "Leo",
] as const;

export type KittenTtsVoice = (typeof KITTEN_TTS_VOICES)[number];

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

// ── Podcast Types ─────────────────────────────────────────────────────────────

export interface PodcastRequest {
  query: string;
  voice_a: string;
  voice_b: string;
  speaker_a_name: string;
  speaker_b_name: string;
  max_turns: number;
  top_k?: number;
}

export interface PodcastLine {
  speaker: string;
  voice: string;
  text: string;
  index: number;
}

export interface PodcastScript {
  title: string;
  lines: PodcastLine[];
  source_chunks: string[];
}

export interface PodcastSegment {
  line: PodcastLine;
  audio_data_url: string;
}

export interface PodcastResult {
  script: PodcastScript;
  segments: PodcastSegment[];
  combined_audio_data_url: string;
}

export interface PodcastProgress {
  stage: "rag" | "scripting" | "tts" | "merging" | "done";
  detail: string;
  progress: number;
}

/** User preferences for RAG pipeline model selection. */
export interface RagModelPreferences {
  /** Preferred embedding model ID for vector similarity search. */
  embed_model_id: string | null;
  /** Preferred LLM model ID for enrichment and chat tasks. */
  llm_model_id: string | null;
}

// ── Revamp Artifact Types ──────────────────────────────────────────────────

export type IntentKind =
  | { kind: "Chat" }
  | { kind: "FileSearch" }
  | { kind: "Artifact"; tool: string; schema_id: string }
  | { kind: "Patch"; artifact_path: string }
  | { kind: "Summarize" };

export interface IntentDecision {
  kind: IntentKind;
  tier: number;
  confidence: number;
}

export type SpreadsheetOp =
  | { op: "SUM_COLUMN"; col: string; label?: string }
  | { op: "AVERAGE_BY_GROUP"; value_col: string; group_col: string }
  | { op: "PIVOT"; row_col: string; col_col: string; value_col: string }
  | { op: "SORT_DESC"; col: string }
  | { op: "SORT_ASC"; col: string }
  | { op: "FILTER_ROWS"; col: string; value: string }
  | { op: "COUNT_BY_GROUP"; group_col: string }
  | { op: "ADD_COLUMN"; name: string; formula: string }
  | { op: "WRITE_DATA"; headers: string[]; rows: string[][] }
  | { op: "RENAME_SHEET"; name: string }
  | {
      op: "ADD_CHART";
      chart_type?: "column" | "bar" | "line" | "pie" | string;
      category_col: string;
      value_col?: string;
      title?: string;
    };

/** One worksheet inside a workbook. */
export interface SpreadsheetSheet {
  name: string;
  headers?: string[];
  rows?: string[][];
  /** Optional per-sheet ops (WRITE_DATA, charts, etc.). */
  ops?: SpreadsheetOp[];
}

export interface SpreadsheetPlan {
  /** Legacy single-sheet ops (used when `sheets` is absent/empty). */
  ops: SpreadsheetOp[];
  /** Multi-sheet workbook. When present and non-empty, each entry becomes a worksheet. */
  sheets?: SpreadsheetSheet[];
  source_rows?: string[][];
  headers?: string[];
  output_name?: string;
}

export type SlideLayout =
  | "TITLE"
  | "BULLET"
  | "TWO_COLUMN"
  | "IMAGE_LEFT"
  | "BLANK"
  | "SECTION"
  | "STAT"
  | "QUOTE"
  | "CARDS"
  | "COMPARISON"
  | "CENTERED";

export interface ArtifactImageAsset {
  data_uri: string;
  caption?: string;
  alt?: string;
  source?: string;
}

export interface PresentationSlide {
  title: string;
  layout: SlideLayout;
  bullets?: string[];
  notes?: string;
  image_index?: number;
  left_title?: string;
  right_title?: string;
}

export interface PresentationPlan {
  slides: PresentationSlide[];
  theme?: string;
  output_name?: string;
  images?: ArtifactImageAsset[];
}

export type HtmlSectionKind =
  | "HERO"
  | "INFO_BAR"
  | "GRID"
  | "SPLIT"
  | "STATS"
  | "QUOTES"
  | "FAQ"
  | "CTA"
  | "TEXT"
  | "CHART"
  | "IMAGE";

export interface HtmlSectionItem {
  label: string;
  detail?: string;
  meta?: string;
}

export interface HtmlSection {
  kind: HtmlSectionKind;
  title: string;
  subtitle?: string;
  body?: string;
  items?: HtmlSectionItem[];
  chart_type?: "bar" | "pie" | "line" | "timeline" | "dual_line" | "grouped_bar";
  label_column?: string;
  value_column?: string;
  value_columns?: string[];
  aggregation?: "sum" | "count" | "avg" | "min" | "max";
  sort?: "value" | "label";
  chart_series?: { name: string; values: number[] }[];
  image_index?: number;
}

export interface HtmlPlan {
  title: string;
  tagline?: string;
  archetype: string;
  sections: HtmlSection[];
  theme?: string;
  output_name?: string;
  /** Legacy raw HTML (used only when sections are empty). */
  html?: string;
  /** Column headers for attached spreadsheet data. */
  headers?: string[];
  /** Data rows (no header row) for file-backed charts. */
  source_rows?: string[][];
  /** Embedded images referenced by section image_index. */
  images?: ArtifactImageAsset[];
}

export interface ArtifactResult {
  path: string;
  kind: string;
  warning?: string;
}

export interface FileRecord {
  path: string;
  filename: string;
  is_dir: boolean;
  size: number;
  mtime: number;
  score?: number;
  snippet?: string;
}

// ── User profile / NELA Cloud auth ───────────────────────────────────────────

export type UserPlan = "free" | "starter" | "pro";

export type DisplayPlan = "free" | "premium";

export type EntitlementStatus =
  | "inactive"
  | "active"
  | "past_due"
  | "cancelled"
  | "quota_exhausted";

export type AuthProvider = "google" | "local";
export type AvatarKind = "google" | "upload" | "preset";

export interface AvatarSource {
  kind: AvatarKind;
  value: string;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  avatar: AvatarSource | null;
  plan: UserPlan;
  displayPlan?: DisplayPlan;
  isPremium?: boolean;
  entitlementStatus?: EntitlementStatus;
  authProvider: AuthProvider;
  updatedAt: string;
  occupation?: string | null;
  field?: string | null;
  onboardingCompleted?: boolean;
}

/** Where to run inference: private local, NELA Cloud, or prefer-cloud auto. */
export type CloudRoutingPreference = "local" | "cloud" | "auto";

/** @deprecated Use CloudRoutingPreference */
export type CloudMode = CloudRoutingPreference;

/** OpenRouter quality tier (matches API CloudMode). */
export type CloudQualityMode = "fast" | "smart" | "deep" | "auto";

export type CloudIntent =
  | "quick_chat"
  | "summarize"
  | "rag_answer"
  | "artifact_plan"
  | "deep_reasoning"
  | "vision"
  | "cheap_background";

export interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export interface DevicePollPendingResponse {
  status: "pending";
}

export interface DevicePollApprovedResponse {
  status: "approved";
  profile: UserProfile;
}

export type DevicePollResponse =
  | DevicePollPendingResponse
  | DevicePollApprovedResponse;

export interface EntitlementResponse {
  cloudEnabled: boolean;
  plan: UserPlan;
  status: EntitlementStatus;
  displayPlan?: DisplayPlan;
  isPremium?: boolean;
  paidCloud?: boolean;
  credits?: {
    balance: number;
    packCredits: number;
    monthlyGrant: number;
    trialCredits?: number;
    trialExpiresAt?: string | null;
  };
  quota: {
    includedUsd: number;
    usedUsd: number;
    remainingUsd: number;
  };
  fastFree?: {
    limit: number;
    used: number;
    remaining: number;
    windowHours?: number;
    resetsAt?: string | null;
  };
  limits: {
    maxInputTokens: number;
    maxOutputTokens: number;
    requestsPerMinute: number;
  };
}

export interface CheckoutResponse {
  checkoutUrl: string;
}

export interface CloudToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface CloudToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type CloudToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface CloudChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: CloudToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface CloudChatRequest {
  mode: CloudQualityMode;
  intent?: CloudIntent;
  messages: CloudChatMessage[];
  stream: boolean;
  privacy: {
    containsFileContext: boolean;
    userConfirmedCloudContext: boolean;
    contextSource?: string;
  };
  generation?: {
    maxTokens?: number;
    temperature?: number;
  };
  tools?: CloudToolDefinition[];
  tool_choice?: CloudToolChoice;
  response_format?: { type: "json_object" | "text" };
  /** When true, ask OpenRouter to include streamed reasoning tokens. */
  includeReasoning?: boolean;
  client?: {
    appVersion?: string;
    platform?: string;
    workspaceIdHash?: string;
    /** Sticky OpenRouter session for prompt-cache routing. */
    sessionId?: string;
  };
}

/** Structural knowledge-graph engine stats. */
export interface DocGraphStats {
  nodes: number;
  edges: number;
  chunks: number;
  vectors: number;
}

export interface DocGraphPipelineTiming {
  discoveryMs: number;
  parseMs: number;
  assembleMs: number;
  embedMs: number;
  flushMs: number;
  totalMs: number;
}

export interface DocGraphPipelineReport {
  root: string;
  filesDiscovered: number;
  filesParsed: number;
  filesFailed: number;
  filesDeferred: number;
  chunksIndexed: number;
  nodes: number;
  edges: number;
  vectors: number;
  timing: DocGraphPipelineTiming;
  errors: string[];
  deferredFiles: string[];
}

export interface DocGraphIndexingProgress {
  phase: string;
  filesDiscovered: number;
  filesParsed: number;
  filesFailed: number;
  chunksIndexed: number;
  message: string;
}

export interface DocGraphBackgroundStatus {
  active: boolean;
  remaining: number;
  completed: number;
  failed: number;
  total: number;
}

