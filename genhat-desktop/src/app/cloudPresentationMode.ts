/**
 * Decide how cloud PPT generation should work for the current user/model.
 *
 * Free/fast OpenRouter models routinely truncate freeform HTML mid-CSS and
 * produce blank black pages. Those paths use structured JSON → NELA renderer.
 * HTML freeform is reserved for stronger Smart/Deep runs on paid plans.
 */

import type { UserPlan } from "../types";
import type { IntelligenceMode } from "./intelligenceModes";
import type { CloudPresentationMode } from "./presentationPlanPrompt";
import { useCloudStore } from "../stores/cloudStore";
import { useModelStore } from "../stores/modelStore";
import { useAuthStore } from "../stores/authStore";

function normalizePlan(plan: string | null | undefined): UserPlan {
  const p = (plan ?? "free").toLowerCase();
  if (p === "starter" || p === "pro") return p;
  return "free";
}

export function resolveCloudPresentationMode(options?: {
  useCloud: boolean;
  intelligenceMode?: IntelligenceMode | null;
  plan?: string | null;
}): CloudPresentationMode {
  if (!options?.useCloud) return "local";

  const intelligenceMode =
    options.intelligenceMode ??
    useModelStore.getState().intelligenceMode ??
    "fast";

  const entitlementPlan = useCloudStore.getState().entitlement?.plan;
  const profilePlan = useAuthStore.getState().profile?.plan;
  const plan = normalizePlan(options.plan ?? entitlementPlan ?? profilePlan);

  // Free plan / Fast tier: JSON slide plan (reliable on weak models).
  if (plan === "free") return "json";
  if (intelligenceMode === "fast") return "json";

  // Paid + Smart/Deep/Auto: allow freeform HTML.
  if (
    intelligenceMode === "smart" ||
    intelligenceMode === "deep" ||
    intelligenceMode === "auto"
  ) {
    return "html";
  }

  return "json";
}
