/** Default chat copy when the model omits intro/follow-up around an artifact. */

export function artifactKindLabel(
  type: "text/html" | "text/csv" | string | undefined,
  asPresentation?: boolean
): string {
  if (type === "text/csv") return "spreadsheet";
  if (asPresentation) return "presentation";
  if (type === "docx" || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "Word document";
  }
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

/** Used when the first stream died mid-file and we stitched a continuation. */
export function continuedArtifactFollowup(options: {
  asPresentation?: boolean;
}): string {
  const kind = options.asPresentation ? "deck" : "file";
  return `The first pass was cut off mid-file, so I continued the HTML and assembled the full ${kind}. Open the panel to preview. Tell me if you want anything changed.`;
}

/** Used when the HTML is still truncated after continuation attempts. */
export function truncatedArtifactFollowup(options: {
  asPresentation?: boolean;
}): string {
  const kind = options.asPresentation ? "deck" : "file";
  return `Generation stopped before the ${kind} was finished. Preview what's in the panel, then ask me to rebuild so the remaining slides/content can be completed.`;
}
