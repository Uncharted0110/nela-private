/** Shared caps for desktop-hosted web_search tool use. */

/** Max agentic tool rounds (chat + cloud artifact research). */
export const MAX_WEB_SEARCH_TOOL_ROUNDS = 8;

/** Artifact prelude: keep research short so generation can start. */
export const MAX_ARTIFACT_WEB_RESEARCH_ROUNDS = 4;

/** Host-formulated queries when the model isn't driving tools. */
export const MAX_ARTIFACT_HOST_QUERIES = 4;

/** Results per search call for artifact grounding. */
export const ARTIFACT_WEB_MAX_RESULTS = 5;

/**
 * Abort if no first token arrives within this long (ms).
 * Covers Render cold start + gateway model fallback before SSE begins.
 */
export const CLOUD_STREAM_TTFT_TIMEOUT_MS = 180_000;

/** Abort a cloud stream if tokens pause for this long after the first token (ms). */
export const CLOUD_STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Artifact HTML can pause between large slides/CSS; allow longer mid-stream gaps. */
export const CLOUD_ARTIFACT_STREAM_IDLE_TIMEOUT_MS = 180_000;

/** Artifact plan prelude: model fallback + long JSON plan before first byte. */
export const CLOUD_ARTIFACT_TTFT_TIMEOUT_MS = 240_000;

/** Hard cap for a single cloud stream (ms) — prevents forever-stuck PPT UI. */
export const CLOUD_STREAM_ABSOLUTE_TIMEOUT_MS = 8 * 60_000;
