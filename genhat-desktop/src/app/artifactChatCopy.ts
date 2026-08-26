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
  return `The first pass was cut off mid-file, so I continued and assembled the full ${kind}. Open the panel to preview. Tell me if you want anything changed.`;
}

/** Used when the HTML is still truncated after continuation attempts. */
export function truncatedArtifactFollowup(options: {
  asPresentation?: boolean;
  type?: "text/html" | "text/csv" | string;
}): string {
  if (options.type === "text/csv") {
    return (
      "Generation stopped before the spreadsheet was finished. Preview what's ready in the panel, " +
      "then ask me to **continue**, or try a simpler sheet (fewer columns or one tab)."
    );
  }
  if (options.asPresentation) {
    return (
      "Generation stopped before the deck was finished. Preview what's ready in the panel, " +
      "then ask me to **continue**, or try a shorter version (for example 5 slides)."
    );
  }
  return (
    "Generation stopped before the file was finished. Preview what's ready in the panel, " +
    "then ask me to **continue**, or try a shorter report with fewer sections."
  );
}

/** Preview is in the panel but save/validation failed. */
export function failedArtifactSaveFollowup(options: {
  asPresentation?: boolean;
  type?: "text/html" | "text/csv" | string;
}): string {
  const kind = artifactKindLabel(options.type, options.asPresentation);
  return (
    `You can still review the ${kind} preview in the panel. ` +
    `Ask me to **continue** from here, or retry with a shorter brief ` +
    `(fewer slides, a simpler sheet, or a one-page summary).`
  );
}

/**
 * Soft success: interactive preview works in the panel even if disk save had a hiccup.
 * Keeps the reply looking successful (intro + chip + follow-up) instead of Error.
 */
export function previewReadySoftFollowup(options: {
  asPresentation?: boolean;
  type?: "text/html" | "text/csv" | string;
  saved?: boolean;
}): string {
  const kind = artifactKindLabel(options.type, options.asPresentation);
  if (options.saved) {
    return `Open the panel to preview or download the ${kind}. Tell me if you want anything changed.`;
  }
  return (
    `The ${kind} preview is ready in the panel — use the Artifact chip if you need to reopen it. ` +
    `Tell me if you want any edits, or ask me to save/download a fresh copy.`
  );
}
