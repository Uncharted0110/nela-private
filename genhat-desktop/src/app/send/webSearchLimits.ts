/** Shared caps for desktop-hosted web_search tool use. */

/** Max agentic tool rounds (chat + cloud artifact research). */
export const MAX_WEB_SEARCH_TOOL_ROUNDS = 20;

/** Host-formulated queries when the model isn't driving tools. */
export const MAX_ARTIFACT_HOST_QUERIES = 12;

/** Results per search call for artifact grounding. */
export const ARTIFACT_WEB_MAX_RESULTS = 5;

/** Abort a cloud stream if no tokens arrive for this long (ms). */
export const CLOUD_STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Hard cap for a single cloud stream (ms) — prevents forever-stuck PPT UI. */
export const CLOUD_STREAM_ABSOLUTE_TIMEOUT_MS = 8 * 60_000;
