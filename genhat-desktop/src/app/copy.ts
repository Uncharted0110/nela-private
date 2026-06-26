/**
 * Central user-facing copy. Non-technical "simple mode" wording lives here so
 * we never scatter jargon across components. Code identifiers keep their
 * original technical names; only the DISPLAYED text comes from this file.
 */
export const COPY = {
  // Tools menu (was: RAG / Web search / Thinking)
  toolSearchDocs: "Search my documents",
  toolSearchDocsHint: "Look through documents you've added to answer your question.",
  toolSearchWeb: "Search the web",
  toolSearchWebHint: "Allow looking things up online for this question.",
  toolShowReasoning: "Show reasoning", // advanced-only; see Task 12
  toolShowReasoningHint: "Show the assistant's step-by-step thinking.",

  // Attach menu (was: Add Files / Ingest / direct)
  addDocumentsTitle: "Add documents",
  addDocumentsHint: "PDF, Word, PowerPoint, text, and more.",
  addFolderTitle: "Add a folder",
  addFolderHint: "Add every supported file in a folder.",
  uploadImageTitle: "Upload an image",
  uploadImageHint: "JPG, PNG, WEBP, GIF, or BMP.",

  // Knowledge base (was: Knowledge Base / chunks / phaseN / ingesting)
  libraryTitle: "Document Library",
  libraryEmpty: "No documents yet. Use \u201CAdd documents\u201D to get started.",
  docStateAdding: "Adding\u2026",
  docStateReady: "Ready",
  docStateEnhanced: "Enhanced",
  processing: "Processing\u2026",

  // Sources (was: score: 0.0473)
  sourcesTitle: "Sources",
  relevanceHigh: "High relevance",
  relevanceMedium: "Medium relevance",
  relevanceLow: "Low relevance",

  // Auto-scan (was: Auto-scan Folders / watched paths)
  syncFolderTitle: "Keep a folder in sync",
  syncFolderReassure: "Files are read and indexed on this device only.",
  syncFolderEmpty: "No folders yet. Add one to keep it in sync automatically.",

  // Privacy indicator (Task 1)
  privacyPrivate: "Private \u00B7 on this device",
  privacyPrivateTooltip:
    "Everything you do stays on this computer. Nothing is sent anywhere. The only time NELA uses the internet is when you choose to download a model.",
  privacyPublic: "Public \u00B7 uses the web",
  privacyPublicTooltip:
    "Web search is enabled. NELA may fetch pages from the internet to help answer your question.",
  privacyNetwork: "Downloading model\u2026",
  privacyNetworkTooltip:
    "NELA is downloading a model from the internet right now. This is the only time it goes online. Your documents and chats are never uploaded.",

  // Response style (Task 4)
  responseStyleLabel: "Response style",
  responseStylePrecise: "Precise",
  responseStylePreciseHint:
    "Focused, consistent answers. Best for facts and analysis. (Lower temperature.)",
  responseStyleBalanced: "Balanced",
  responseStyleBalancedHint:
    "A mix of accuracy and flexibility. Good default. (Medium temperature.)",
  responseStyleCreative: "Creative",
  responseStyleCreativeHint:
    "More varied, imaginative answers. (Higher temperature and sampling.)",

  // Intelligence tiers (model mode)
  intelligenceFast: "Fast",
  intelligenceFastHint: "Quick answers with the smallest model.",
  intelligenceSmart: "Smart",
  intelligenceSmartHint: "Balanced reasoning for everyday questions.",
  intelligenceDeep: "Deep",
  intelligenceDeepHint: "Best quality — may take longer to load.",
  intelligenceCustom: "Custom",
  intelligenceCustomHint: "A specific model you chose manually.",
  intelligenceChooseModel: "Choose specific model\u2026",
  intelligenceBackToTiers: "Back to Fast / Smart / Deep",
  intelligenceDeepLoadWarning:
    "Deep mode uses a large model and may take 1\u20132 minutes to load the first time. Continue?",
  intelligenceDownloadPrompt: (name: string, sizeLabel: string) =>
    `${name} is not installed yet${sizeLabel ? ` (${sizeLabel})` : ""}. Download it now?`,

  // Generic errors (Task 10)
  errorNotReady: "NELA is still getting ready. Please try again in a moment.",
  errorGeneric: "Something went wrong. Please try again.",
  retry: "Try again",

  // Slash commands
  slashCommandsHint: "Type / for commands (ppt, excel, html, web, rag, files)",
} as const;

export type CopyKey = keyof typeof COPY;
