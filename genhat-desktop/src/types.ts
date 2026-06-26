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
}

export interface ChatContextMessage {
  role: ChatMessage["role"];
  content: string;
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
}

export interface WebSearchResult {
  query: string;
  results: SearchHit[];
  formatted_context: string;
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
  /** Whether the artifact sandbox is currently visible for this session. */
  artifactVisible?: boolean;
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
  | { op: "RENAME_SHEET"; name: string };

export interface SpreadsheetPlan {
  ops: SpreadsheetOp[];
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

export interface PresentationSlide {
  title: string;
  layout: SlideLayout;
  bullets?: string[];
  notes?: string;
}

export interface PresentationPlan {
  slides: PresentationSlide[];
  theme?: string;
  output_name?: string;
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
  | "TEXT";

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

