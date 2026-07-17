import { Api } from "../../api";
import type { ChatMessage, WebSearchResult } from "../../types";
import {
  applyCompactionResultToSession,
  CONTEXT_COMPACTION_KEEP_RECENT,
  CONTEXT_COMPACTION_THRESHOLD,
  AMBIENT_FOUND_PREFIX,
  normalizeMessagesForLlm,
  resolveReservedOutputTokens,
  toContextMessages,
} from "../contextCompaction";
import {
  extractAmbientSearchQuery,
  hasDocumentFileIntent,
  hasSearchKeywords,
  selectAmbientResultsForInjection,
  shouldRunAmbientFileSearch,
} from "../ambientSearch";
import {
  formatAmbientFileSection,
  hasLocalFilePathReference,
  loadAmbientFileBody,
} from "../ambientFileContent";
import { extractWebSearchQuery } from "../webSearchQuery";
import { parseCSV } from "./csvParse";
import type { SendHandlerContext } from "./types";

export async function handleSendTextChat(
  text: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  session: import("../../types").ChatSession,
  newMsg: ChatMessage,
  effectiveWebEnabled: boolean,
  resolvedIntentKind: string,
  slashFileSearch: boolean
): Promise<void> {
  const sid = ctx.activeSessionId;
  
  // ── Web search context injection ───────────────────────────────────────
  let webSearchResult: WebSearchResult | null = null;
  if (effectiveWebEnabled) {
    try {
      const searchQuery = extractWebSearchQuery(text);
      const fetchContent = ctx.webDepth === "full";
      const maxResults = fetchContent ? 4 : 5;
      const result = await Api.webSearch(searchQuery, maxResults, fetchContent);
      if (result.results.length > 0) {
        webSearchResult = result;
      }
    } catch (e) {
      console.warn("[web_search] Failed, continuing without web context:", e);
    }
  }

  // ── Ambient FTS5 file search context injection (Revamp P4 grounding) ───
  let ambientFileContext = "";
  let attachedFile = ctx.directDocumentPaths.length > 0 ? ctx.directDocumentPaths[0] : null;
  let discoveryMsg: ChatMessage | null = null;

  // Decide whether to run the ambient OS file search. Two tiers:
  //  - explicit: a clear file request (search/find/get the file, a locality cue like
  //    "from my system", a filename with extension) OR a deterministic FileSearch
  //    intent. These trigger the search AND, on a miss, a "couldn't find it" notice.
  //  - soft: a likely file reference ("get form 1a", "what does X say", "contents of X").
  //    These trigger the search too, but on a miss they silently continue so general
  //    questions are not hijacked into a false "I couldn't find the file" answer.
  // When web search already supplied context and the request wasn't an explicit file
  // request, skip ambient search to avoid the two grounding sources clashing.
  const explicitFileSearch =
    resolvedIntentKind === "FileSearch" ||
    slashFileSearch ||
    hasSearchKeywords(text) ||
    hasDocumentFileIntent(text) ||
    hasLocalFilePathReference(text);
  const wantsFileSearch = shouldRunAmbientFileSearch(text, {
    forceFileSearch: resolvedIntentKind === "FileSearch" || slashFileSearch,
  });
  const skipForWebSearch = !!webSearchResult && !explicitFileSearch;

  if (!attachedFile && wantsFileSearch && !skipForWebSearch) {
    {
      const searchQuery = extractAmbientSearchQuery(text);
      try {
        const results = await Api.searchAmbientFiles(searchQuery);
        const top = selectAmbientResultsForInjection(results ?? []);
        if (top.length > 0) {
          const sections: string[] = [];

          for (const rec of top) {
            const filename = rec.path.split(/[/\\]/).pop() ?? "file";
            if (rec.path.endsWith(".csv") || rec.path.endsWith(".tsv")) {
              try {
                const fileContent = await Api.readFileText(rec.path);
                const parsed = parseCSV(fileContent);
                if (parsed.headers.length > 0) {
                  sections.push(
                    `File: "${filename}" (Path: ${rec.path})\n` +
                    `Columns: [${parsed.headers.join(", ")}]\n` +
                    `First rows:\n${parsed.rows.slice(0, 10).map(r => r.join(", ")).join("\n")}`
                  );
                  continue;
                }
              } catch (err) { console.warn("CSV read failed:", err); }
            } else if (rec.path.endsWith(".xlsx") || rec.path.endsWith(".xls") || rec.path.endsWith(".ods")) {
              try {
                const cached = await Api.getAmbientFileContent(rec.path);
                if (cached) {
                  sections.push(`File: "${filename}" (Path: ${rec.path})\nSchema:\n${cached}`);
                  continue;
                }
              } catch (err) { console.warn("Excel schema read failed:", err); }
            }
            const body = await loadAmbientFileBody(rec.path);
            sections.push(formatAmbientFileSection(rec.path, body));
          }

          if (sections.length > 0) {
            // Surface the best match in the chat UI only (not sent to the LLM — see
            // fullSessionMessages below and isDiscoveryNotice in contextCompaction).
            const bestName = top[0].path.split(/[/\\]/).pop() ?? "file";
            attachedFile = top[0].path;
            const normalizedPath = top[0].path.replace(/\\/g, "/");
            const fileUrl = normalizedPath.startsWith("/")
              ? `file://${normalizedPath}`
              : `file:///${normalizedPath}`;
            discoveryMsg = {
              role: "assistant" as const,
              content: `${AMBIENT_FOUND_PREFIX} ${top.length} matching file(s). Top match: **${bestName}**\nPath: [${top[0].path}](${fileUrl})`,
            };
            ctx.updateSession(sid, (prev) => ({ messages: [...prev.messages, discoveryMsg!] }));
            ambientFileContext =
              `The following local files were retrieved (most relevant first):\n\n${sections.join("\n\n---\n\n")}`;
          }
        }
      } catch (err) {
        console.warn("Ambient search in standard chat failed:", err);
      }

      // If an EXPLICIT file request found nothing, tell the model the file is missing
      // so it doesn't hallucinate file contents. For a soft reference that missed, we
      // leave the context empty and let the model answer the query normally.
      if (!ambientFileContext && !attachedFile && explicitFileSearch) {
        ambientFileContext = "FILE_SEARCH_NO_RESULTS";
      }
    }
  }

  ctx.setGeneralGenerating(true);
  ctx.setGeneralElapsedTime(0);
  ctx.setGeneralGenerationTime(null);
  const chatStartTime = Date.now();

  if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
  ctx.generalIntervalRef.current = setInterval(() => {
    const elapsed = Math.floor((Date.now() - chatStartTime) / 100) / 10;
    ctx.setGeneralElapsedTime(elapsed);
  }, 100);

  let fullResponse = "";
  let fullThinking = "";
  let textFirstTokenTimeMs: number | null = null;

  const sessionMessages = session.messages;
  const fullSessionMessages: ChatMessage[] = [
    ...sessionMessages,
    newMsg,
    // discoveryMsg is UI-only; omit it here so the LLM sees user as the last turn.
  ];
  let apiMessages = toContextMessages(fullSessionMessages);

  // Inject ambient file search results. The retrieved document text goes into the
  // FINAL USER message (not a system message): small local models weight the current
  // user turn far more heavily, and wording like "you have access to local files"
  // tends to trip their "I can't access your files" guardrail. The document text is
  // presented inline as the source of truth — mirroring the direct-document path.
  if (ambientFileContext === "FILE_SEARCH_NO_RESULTS") {
    apiMessages = [
      {
        role: "system",
        content:
          "The user asked about a specific local file, but it could not be located in Documents, Desktop, Downloads, or indexed workspaces. " +
          "Tell them you could not find that file on their system. Do NOT claim you lack the ability to access local files — this app can search them, but this particular file was not found. " +
          "Suggest they verify the path, wait for indexing to finish after restart, or attach the file directly.",
      },
      ...apiMessages,
    ];
  } else if (ambientFileContext) {
    apiMessages = [
      {
        role: "system",
        content:
          "You are NELA, a local desktop assistant. The user's message includes text retrieved from their computer. " +
          "You ALREADY have the file contents below — answer directly from that text. " +
          "NEVER say you cannot access local files, paths, or the user's system. " +
          "Summarize or explain the document in clear prose. If the excerpt is incomplete, say what you can from the provided text.",
      },
      ...apiMessages,
    ];
    // Fold the document text into the last user message so the model reads it as part
    // of the current request rather than as background context it might ignore.
    for (let i = apiMessages.length - 1; i >= 0; i--) {
      if (apiMessages[i].role === "user") {
        apiMessages[i] = {
          ...apiMessages[i],
          content:
            `${apiMessages[i].content}\n\n` +
            `--- Retrieved document text (source of truth) ---\n${ambientFileContext}\n--- End of document text ---`,
        };
        break;
      }
    }
  }

  // Prepend web search context as a system message so the model can cite it
  if (webSearchResult && webSearchResult.formatted_context) {
    apiMessages = [
      { role: "system", content: webSearchResult.formatted_context },
      ...apiMessages,
    ];
  }

  const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

  try {
    const compaction = await Api.compactChatContext({
      messages: apiMessages,
      contextWindowTokens: ctx.getContextWindowTokens(ctx.selectedModel),
      reservedOutputTokens: resolveReservedOutputTokens(generationOptions.maxTokens),
      thresholdPercent: CONTEXT_COMPACTION_THRESHOLD,
      allowAutoCompaction: true,
      forceCompaction: false,
      preserveRecentMessages: CONTEXT_COMPACTION_KEEP_RECENT,
      modelOverride: ctx.selectedModel || null,
    });

    ctx.setContextUsageForSession(sid, compaction.usage);
    apiMessages = compaction.messages;

    if (compaction.compacted) {
      const rebuilt = applyCompactionResultToSession(
        fullSessionMessages,
        session.mediaAssets ?? {},
        compaction
      );
      ctx.updateSession(sid, {
        messages: rebuilt.messages,
        mediaAssets: rebuilt.mediaAssets,
      });
    }
  } catch (err) {
    console.warn("Context compaction failed; continuing with original context:", err);
  }

  // Collapse every injected `system` message (web search, ambient file context,
  // auto-compaction summary) into a single leading system message and strip the
  // UI-only discovery notice. This prevents llama-server's strict chat template
  // from rejecting the request with "System message must be at the beginning".
  apiMessages = normalizeMessagesForLlm(apiMessages);

  Api.streamChat(
    apiMessages,
    (chunk) => {
      if (textFirstTokenTimeMs === null) {
        textFirstTokenTimeMs = Date.now();
      }
      ctx.updateSession(sid, (prev) => ({
        streamingContent: prev.streamingContent + chunk,
      }));
      fullResponse += chunk;
    },
    (thinkingChunk) => {
      fullThinking += thinkingChunk;
      ctx.setStreamingThinking(fullThinking);
    },
    () => {
      if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
      const totalTime = Math.floor((Date.now() - chatStartTime) / 100) / 10;
      const timeToFirstToken =
        textFirstTokenTimeMs
          ? Math.floor((textFirstTokenTimeMs - chatStartTime) / 100) / 10
          : null;

      ctx.setGeneralGenerating(false);
      ctx.setGeneralElapsedTime(totalTime);
      ctx.setGeneralGenerationTime(totalTime);
      ctx.setStreamingThinking("");

      if (fullResponse) {
        ctx.updateSession(sid, (prev) => ({
          messages: [
            ...prev.messages,
            {
              role: "assistant" as const,
              content: fullResponse,
              thinking: fullThinking || undefined,
              webSearchResult: webSearchResult ?? undefined,
              generateTime: totalTime,
              firstTokenTime:
                timeToFirstToken !== null ? timeToFirstToken : undefined,
            },
          ],
          streamingContent: "",
          loading: false,
        }));
      } else {
        ctx.updateSession(sid, { loading: false });
      }
    },
    (err) => {
      if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
      ctx.setGeneralGenerating(false);
      ctx.setStreamingThinking("");
      console.error("Stream error", err);
      ctx.updateSession(sid, (prev) => ({
        messages: [
          ...prev.messages,
          { role: "assistant" as const, content: `Error: ${err}` },
        ],
        loading: false,
      }));
    },
    undefined,
    ctx.selectedModel || undefined,
    ctrl.signal,
    !ctx.thinkingEnabled,
    generationOptions
  );
}