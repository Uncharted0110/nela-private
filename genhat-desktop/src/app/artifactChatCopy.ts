/** Default chat copy when the model omits intro/follow-up around an artifact. */

export function artifactKindLabel(
  type: "text/html" | "text/csv" | string | undefined,
  asPresentation?: boolean
): string {
  if (type === "text/csv") return "spreadsheet";
  if (asPresentation) return "presentation";
  return "webpage";
}

export function defaultArtifactIntro(options: {
  title?: string;
  type?: "text/html" | "text/csv" | string;
  asPresentation?: boolean;
}): string {
  const title = (options.title || "your artifact").trim() || "your artifact";
  const kind = artifactKindLabel(options.type, options.asPresentation);
  return `I've put together **${title}** as a ${kind}.`;
}

export function defaultArtifactFollowup(options: {
  type?: "text/html" | "text/csv" | string;
  asPresentation?: boolean;
}): string {
  const kind = artifactKindLabel(options.type, options.asPresentation);
  return `Open the panel to preview or download the ${kind}. Tell me if you want anything changed.`;
}
