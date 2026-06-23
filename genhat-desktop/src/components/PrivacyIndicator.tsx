import React from "react";
import { ShieldCheck, Globe } from "lucide-react";
import { COPY } from "../app/copy";

interface PrivacyIndicatorProps {
  /** True only while a model download (the sole outbound activity) is running. */
  networkActive?: boolean;
  /** True when web search/generation is enabled for chat. */
  webEnabled?: boolean;
}

/**
 * Always-visible trust indicator. Default = fully private/offline.
 * Flips to "Downloading model…" only during an explicit model download.
 */
const PrivacyIndicator: React.FC<PrivacyIndicatorProps> = ({
  networkActive = false,
  webEnabled = false,
}) => {
  const publicActive = !networkActive && webEnabled;
  const label = networkActive
    ? COPY.privacyNetwork
    : publicActive
      ? COPY.privacyPublic
      : COPY.privacyPrivate;
  const tooltip = networkActive
    ? COPY.privacyNetworkTooltip
    : publicActive
      ? COPY.privacyPublicTooltip
      : COPY.privacyPrivateTooltip;

  return (
    <div
      role="status"
      aria-label={label}
      title={tooltip}
      tabIndex={0}
      data-tour="privacy-indicator"
      className={[
        "inline-flex items-center gap-1.5 py-1 px-2.5 rounded-full border text-[0.78rem] font-medium select-none",
        "transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-0",
        networkActive
          ? "border-amber-400/40 bg-amber-400/10 text-txt focus-visible:ring-amber-300/50"
          : publicActive
            ? "border-sky-400/40 bg-sky-400/10 text-txt focus-visible:ring-sky-300/50"
            : "border-emerald-400/40 bg-emerald-400/10 text-txt focus-visible:ring-emerald-300/50",
      ].join(" ")}
    >
      {networkActive ? (
        <>
          <Globe size={13} className="shrink-0" />
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-amber-300 opacity-75 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-300" />
          </span>
        </>
      ) : publicActive ? (
        <Globe size={13} className="shrink-0" />
      ) : (
        <ShieldCheck size={13} className="shrink-0" />
      )}
      <span className="leading-none">{label}</span>
    </div>
  );
};

export default PrivacyIndicator;
