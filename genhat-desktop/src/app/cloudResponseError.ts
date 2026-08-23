import { COPY } from "./copy";
import { friendlyError, friendlyErrorFromUnknown } from "./friendlyError";
import { useCloudStore } from "../stores/cloudStore";

/** True when the toolbar is in explicit Cloud mode. */
export function isExplicitCloudMode(): boolean {
  return useCloudStore.getState().preferredMode === "cloud";
}

/** Checklist shown for any failed Cloud response. */
export function cloudUnableToRespondMessage(): string {
  return COPY.errorCloudUnableToRespond;
}

/** Map a chat/stream failure to user-visible text (Cloud checklist when in Cloud). */
export function chatResponseError(err: unknown): string {
  if (isExplicitCloudMode()) return COPY.errorCloudUnableToRespond;
  return friendlyErrorFromUnknown(err);
}

export function chatResponseErrorText(raw: string | undefined | null): string {
  if (isExplicitCloudMode()) return COPY.errorCloudUnableToRespond;
  return friendlyError(raw);
}
