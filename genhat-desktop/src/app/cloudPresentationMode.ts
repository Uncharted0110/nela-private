/**
 * Shared cloud freeform mode for HTML / PPT / spreadsheet artifacts.
 * Local mode stays on grammar/JSON plans; any cloud intelligence mode streams freeform.
 */

import type { IntelligenceMode } from "./intelligenceModes";
import type { CloudPresentationMode } from "./presentationPlanPrompt";
import { useCloudStore } from "../stores/cloudStore";

export type CloudArtifactMode = CloudPresentationMode | "csv";

/**
 * @deprecated Prefer resolveCloudArtifactMode — kept for existing PPT/HTML imports.
 */
export function resolveCloudPresentationMode(options?: {
  useCloud: boolean;
  intelligenceMode?: IntelligenceMode | null;
  plan?: string | null;
}): CloudPresentationMode {
  const mode = resolveCloudArtifactMode({
    useCloud: Boolean(options?.useCloud),
    intelligenceMode: options?.intelligenceMode,
    plan: options?.plan,
    kind: "html",
  });
  return mode === "csv" ? "json" : mode;
}

export function resolveCloudArtifactMode(options?: {
  useCloud?: boolean;
  intelligenceMode?: IntelligenceMode | null;
  plan?: string | null;
  /** Spreadsheet freeform uses csv; HTML/PPT use html. */
  kind?: "html" | "presentation" | "spreadsheet";
}): CloudArtifactMode {
  if (!options?.useCloud) return "local";

  // Cloud (including Fast): freeform streaming. Grammar/JSON plans are local-only.
  if (options.kind === "spreadsheet") return "csv";
  return "html";
}

/** True when cloud chat should allow auto nela-artifact tags (not local-only routing). */
export function canAutoStreamArtifacts(): boolean {
  const { preferredMode, entitlement } = useCloudStore.getState();
  if (preferredMode === "local") return false;
  if (!entitlement?.cloudEnabled) return false;

  // Need cloud routing attempt; unpaid Smart/Deep will error at stream time unless auto→local.
  return preferredMode === "cloud" || preferredMode === "auto"
    ? Boolean(entitlement.paidCloud || preferredMode === "auto")
    : false;
}
