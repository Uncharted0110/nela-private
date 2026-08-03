/**
 * Shared cloud freeform mode for HTML / PPT / spreadsheet artifacts.
 * Free/fast models stay on JSON plans; Smart/Deep (+ credits) use streamed tags.
 */

import type { UserPlan } from "../types";
import type { IntelligenceMode } from "./intelligenceModes";
import type { CloudPresentationMode } from "./presentationPlanPrompt";
import { useCloudStore } from "../stores/cloudStore";
import { useModelStore } from "../stores/modelStore";
import { useAuthStore } from "../stores/authStore";

export type CloudArtifactMode = CloudPresentationMode | "csv";

function normalizePlan(plan: string | null | undefined): UserPlan {
  const p = (plan ?? "free").toLowerCase();
  if (p === "starter" || p === "pro") return p;
  return "free";
}

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

  const intelligenceMode =
    options.intelligenceMode ??
    useModelStore.getState().intelligenceMode ??
    "fast";

  const entitlement = useCloudStore.getState().entitlement;
  const entitlementPlan = entitlement?.plan;
  const profilePlan = useAuthStore.getState().profile?.plan;
  const plan = normalizePlan(options.plan ?? entitlementPlan ?? profilePlan);
  const paidCloud = Boolean(entitlement?.paidCloud);

  if (intelligenceMode === "fast") return "json";
  if (plan === "free" && !paidCloud) return "json";

  if (
    intelligenceMode === "smart" ||
    intelligenceMode === "deep" ||
    intelligenceMode === "auto"
  ) {
    if (options.kind === "spreadsheet") return "csv";
    return "html";
  }

  return "json";
}

/** True when Smart/Deep/Auto cloud chat should allow auto nela-artifact tags. */
export function canAutoStreamArtifacts(): boolean {
  const { preferredMode, entitlement } = useCloudStore.getState();
  if (preferredMode === "local") return false;
  if (!entitlement?.cloudEnabled) return false;
  if (!entitlement.paidCloud && preferredMode === "cloud") {
    // Still allow auto tags on auto routing when paid; unpaid cloud deep is blocked elsewhere.
  }
  const intelligenceMode = useModelStore.getState().intelligenceMode ?? "fast";
  if (intelligenceMode === "fast") return false;
  if (
    intelligenceMode !== "smart" &&
    intelligenceMode !== "deep" &&
    intelligenceMode !== "auto"
  ) {
    return false;
  }
  // Need cloud routing attempt; unpaid Smart/Deep will error at stream time unless auto→local.
  return preferredMode === "cloud" || preferredMode === "auto"
    ? Boolean(entitlement.paidCloud || preferredMode === "auto")
    : false;
}
