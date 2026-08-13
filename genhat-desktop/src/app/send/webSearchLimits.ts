/** Shared caps for desktop-hosted web_search tool use. */

/** Max agentic tool rounds (chat + cloud artifact research). */
export const MAX_WEB_SEARCH_TOOL_ROUNDS = 8;

/** Artifact prelude: keep research short so generation can start. */
export const MAX_ARTIFACT_WEB_RESEARCH_ROUNDS = 4;

/** Host-formulated queries when the model isn't driving tools. */
export const MAX_ARTIFACT_HOST_QUERIES = 4;

/** Results per search call for artifact grounding. */
export const ARTIFACT_WEB_MAX_RESULTS = 5;

/** Abort a cloud stream if no tokens arrive for this long (ms). */
export const CLOUD_STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Hard cap for a single cloud stream (ms) — prevents forever-stuck PPT UI. */
export const CLOUD_STREAM_ABSOLUTE_TIMEOUT_MS = 8 * 60_000;
