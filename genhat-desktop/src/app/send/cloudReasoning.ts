import { useCloudStore } from "../../stores/cloudStore";

/**
 * Reasoning tokens are requested only for cloud (or auto→cloud) chat.
 * Local preferred mode and local stream fallbacks never enable thinking.
 */
export function shouldStreamCloudReasoning(thinkingEnabled: boolean): boolean {
  if (!thinkingEnabled) return false;
  const preferredMode = useCloudStore.getState().preferredMode;
  return preferredMode === "cloud" || preferredMode === "auto";
}
