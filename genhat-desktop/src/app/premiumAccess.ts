import type { DisplayPlan, EntitlementResponse, UserProfile } from "../types";

/**
 * Premium is per-user and must come from the cloud entitlement/profile signals.
 * Never invent Premium from a stale local plan string alone when the server
 * explicitly says the account is free.
 */
export function isPremiumAccount(input: {
  profile?: Pick<UserProfile, "plan" | "displayPlan" | "isPremium" | "entitlementStatus"> | null;
  entitlement?: Pick<
    EntitlementResponse,
    "plan" | "displayPlan" | "isPremium" | "paidCloud" | "status"
  > | null;
}): boolean {
  const { profile, entitlement } = input;

  if (entitlement?.paidCloud === true) return true;
  if (entitlement?.isPremium === true) return true;
  if (entitlement?.displayPlan === "premium") return true;

  // Explicit free from entitlement wins over stale profile chrome.
  if (entitlement) {
    if (entitlement.isPremium === false || entitlement.displayPlan === "free") {
      return false;
    }
    if (entitlement.plan === "free") return false;
  }

  if (profile?.isPremium === true) return true;
  if (profile?.displayPlan === "premium") return true;
  if (profile?.isPremium === false || profile?.displayPlan === "free") {
    return false;
  }

  // Legacy fallback only when server premium fields are missing entirely.
  const plan = (entitlement?.plan ?? profile?.plan ?? "free").toLowerCase();
  const status = (
    entitlement?.status ??
    profile?.entitlementStatus ??
    ""
  ).toLowerCase();
  if (plan !== "starter" && plan !== "pro") return false;
  if (status === "inactive" || status === "cancelled") return false;
  // If we got here with no isPremium/displayPlan fields, treat paid plan as premium.
  if (
    entitlement?.isPremium === undefined &&
    entitlement?.displayPlan === undefined &&
    profile?.isPremium === undefined &&
    profile?.displayPlan === undefined
  ) {
    return true;
  }
  return false;
}

export function displayPlanLabel(input: {
  profile?: Pick<UserProfile, "plan" | "displayPlan" | "isPremium" | "entitlementStatus"> | null;
  entitlement?: Pick<
    EntitlementResponse,
    "plan" | "displayPlan" | "isPremium" | "paidCloud" | "status"
  > | null;
}): DisplayPlan {
  return isPremiumAccount(input) ? "premium" : "free";
}
