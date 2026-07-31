import { Api } from "../../api";
import type { ChatMessage, WebSearchResult } from "../../types";
import {
  CONTEXT_COMPACTION_KEEP_RECENT,
  CONTEXT_COMPACTION_THRESHOLD,
  normalizeMessagesForLlm,
  resolveReservedOutputTokens,
  toContextMessages,
} from "../contextCompaction";
import {
  extractAmbientSearchQuery,
  hasDocumentFileIntent,
  hasSearchKeywords,
  selectAmbientResultsForInjection,
} from "../ambientSearch";
import {
  formatAmbientFileSection,
  hasLocalFilePathReference,
  loadAmbientFileBody,
} from "../ambientFileContent";
import { NELA_SYSTEM_PROMPT } from "../nelaSystemPrompt";
import { useFileIndexerStore } from "../../stores/fileIndexerStore";
import { parseCSV } from "./csvParse";
import { streamChatByMode } from "./cloudOrLocalStream";
import type { SendHandlerContext } from "./types";
import { runCloudAwareToolLoop } from "./cloudNativeToolLoop";

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

  // ── Local file search context injection ────────────────────────────────
  let ambientFileContext = "";
  let attachedFile = ctx.directDocumentPaths.length > 0 ? ctx.directDocumentPaths[0] : null;

  // Tools → "Search my files" (or /files): open File search popup + ground reply.
  const explicitFileSearch =
    resolvedIntentKind === "FileSearch" ||
    slashFileSearch ||
    hasSearchKeywords(text) ||
    hasDocumentFileIntent(text) ||
    hasLocalFilePathReference(text);
  const fileSearchEnabled = ctx.fileIndexerEnabled || slashFileSearch;

  if (fileSearchEnabled && !attachedFile && text.trim()) {
    {
      const searchQuery = extractAmbientSearchQuery(text).trim() || text.trim();
      try {
        // Results UI lives in the File search popup (avoids dumping PDF noise into chat).
        useFileIndexerStore.getState().openChatWithQuery(searchQuery);

        let results: import("../../types").FileRecord[] = [];

        try {
          const fiHits = ((await Api.fileindexerSearch(searchQuery)) ?? []).map((h) => ({
            path: h.path,
            score: h.score,
            fields: h.fields ?? [],
          }));
          results = fiHits.map((h) => ({
            path: h.path,
            filename: h.path.split(/[/\\]/).pop() ?? h.path,
            is_dir: false,
            size: 0,
            mtime: 0,
            score: h.score,
          }));
        } catch (fiErr) {
          console.warn("FileIndexer search unavailable, trying ambient:", fiErr);
        }

        if (results.length === 0) {
          results = (await Api.searchAmbientFiles(searchQuery)) ?? [];
        }

        // Light grounding only — do not re-parse every PDF hit (pdf-extract used to
        // println! glyph warnings to stdout and break Tauri IPC).
        const ranked = [...results]
          .filter((r) => !r.is_dir)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const top = ranked.length > 0 ? ranked.slice(0, 5) : selectAmbientResultsForInjection(results);

        if (top.length > 0) {
          const sections: string[] = [];
          let loadedBodies = 0;

          for (const rec of top) {
            const filename = rec.path.split(/[/\\]/).pop() ?? "file";
            const lower = rec.path.toLowerCase();
            const isPdf = lower.endsWith(".pdf");
            const scoreBit =
              typeof rec.score === "number" && Number.isFinite(rec.score)
                ? ` (score ${rec.score.toFixed(3)})`
                : "";

            if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
              try {
                const fileContent = await Api.readFileText(rec.path);
                const parsed = parseCSV(fileContent);
                if (parsed.headers.length > 0) {
                  sections.push(
                    `File: "${filename}" (Path: ${rec.path})${scoreBit}\n` +
                    `Columns: [${parsed.headers.join(", ")}]\n` +
                    `First rows:\n${parsed.rows.slice(0, 10).map((r) => r.join(", ")).join("\n")}`
                  );
                  loadedBodies += 1;
                  continue;
                }
              } catch (err) {
                console.warn("CSV read failed:", err);
              }
            } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".ods")) {
              try {
                const cached = await Api.getAmbientFileContent(rec.path);
                if (cached) {
                  sections.push(
                    `File: "${filename}" (Path: ${rec.path})${scoreBit}\nSchema:\n${cached}`
                  );
                  loadedBodies += 1;
                  continue;
                }
              } catch (err) {
                console.warn("Excel schema read failed:", err);
              }
            }

            if (isPdf) {
              try {
                const cached = await Api.getAmbientFileContent(rec.path);
                if (cached?.trim()) {
                  sections.push(
                    `File: "${filename}" (Path: ${rec.path})${scoreBit}\nContent:\n${cached.substring(0, 4000)}`
                  );
                  loadedBodies += 1;
                  continue;
                }
              } catch {
                /* ignore */
              }
              // At most one on-demand PDF parse for grounding.
              if (loadedBodies === 0) {
                try {
                  const body = await loadAmbientFileBody(rec.path, 4000);
                  sections.push(formatAmbientFileSection(rec.path, body) + scoreBit);
                  if (body.trim()) loadedBodies += 1;
                  continue;
                } catch (err) {
                  console.warn("PDF body load skipped:", err);
                }
              }
              sections.push(
                `File: "${filename}" (Path: ${rec.path})${scoreBit}\n` +
                  `(PDF listed in File search results.)`
              );
              continue;
            }

            if (loadedBodies < 2) {
              const body = await loadAmbientFileBody(rec.path);
              sections.push(formatAmbientFileSection(rec.path, body) + scoreBit);
              if (body.trim()) loadedBodies += 1;
            } else {
              sections.push(`File: "${filename}" (Path: ${rec.path})${scoreBit}`);
            }
          }

          if (sections.length > 0) {
            attachedFile = top[0].path;
            ambientFileContext =
              `The following local files were retrieved for the user's query (most relevant first).\n` +
              `Use these as the primary source of truth when answering.\n\n` +
              sections.join("\n\n---\n\n");
          }
        }
      } catch (err) {
        console.warn("Local file search in standard chat failed:", err);
      }

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
  let webSearchResult: WebSearchResult | null = null;

  const sessionMessages = session.messages;
  const fullSessionMessages: ChatMessage[] = [
    ...sessionMessages,
    newMsg,
  ];
  let apiMessages = [
    { role: "system" as const, content: NELA_SYSTEM_PROMPT },
    ...toContextMessages(fullSessionMessages),
  ];

  // Ambient file instructions AFTER the stable NELA identity so OpenRouter
  // can cache the identity prefix. Document text still goes in the user turn.
  if (ambientFileContext === "FILE_SEARCH_NO_RESULTS") {
    apiMessages = [
      ...apiMessages.slice(0, 1),
      {
        role: "system",
        content:
          "The user asked about a specific local file, but it could not be located in Documents, Desktop, Downloads, or indexed workspaces. " +
          "Tell them you could not find that file on their system. Do NOT claim you lack the ability to access local files — this app can search them, but this particular file was not found. " +
          "Suggest they verify the path, wait for indexing to finish after restart, or attach the file directly.",
      },
      ...apiMessages.slice(1),
    ];
  } else if (ambientFileContext) {
    apiMessages = [
      ...apiMessages.slice(0, 1),
      {
        role: "system",
        content:
          "The user's message includes text retrieved from their computer. " +
          "You ALREADY have the file contents below — answer directly from that text. " +
          "NEVER say you cannot access local files, paths, or the user's system. " +
          "Summarize or explain the document in clear prose. If the excerpt is incomplete, say what you can from the provided text.",
      },
      ...apiMessages.slice(1),
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

    // Do NOT rewrite session.messages from compaction.keptIndices here.
    // Those indices refer to `apiMessages` (NELA system prompt + optional ambient
    // file instructions + turns). Mapping them onto the UI transcript deleted or
    // scrambled real chat responses — especially when "Search my files" injects
    // extra system context and pushes usage over the compaction threshold.
  } catch (err) {
    console.warn("Context compaction failed; continuing with original context:", err);
  }

  // Collapse every injected `system` message (ambient file context,
  // auto-compaction summary) into a single leading system message and strip the
  // UI-only discovery notice. This prevents llama-server's strict chat template
  // from rejecting the request with "System message must be at the beginning".
  apiMessages = normalizeMessagesForLlm(apiMessages);

  const finishOk = (response: string, thinking: string, web: WebSearchResult | null) => {
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

    const content = response.trim()
      ? response
      : undefined;

    // Always clear streaming state; persist whatever we generated (including
    // partial streams that only lived in streamingContent).
    ctx.updateSession(sid, (prev) => {
      const streamed = (prev.streamingContent || "").trim();
      const finalContent = content || streamed;
      if (!finalContent) {
        return { streamingContent: "", loading: false };
      }
      return {
        messages: [
          ...prev.messages,
          {
            role: "assistant" as const,
            content: finalContent,
            thinking: thinking || undefined,
            webSearchResult: web ?? undefined,
            generateTime: totalTime,
            firstTokenTime:
              timeToFirstToken !== null ? timeToFirstToken : undefined,
          },
        ],
        streamingContent: "",
        loading: false,
      };
    });
  };

  const finishErr = (err: unknown) => {
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
  };

  const onChunk = (chunk: string) => {
    if (textFirstTokenTimeMs === null) {
      textFirstTokenTimeMs = Date.now();
    }
    ctx.updateSession(sid, (prev) => ({
      streamingContent: prev.streamingContent + chunk,
    }));
    fullResponse += chunk;
  };

  const onThinking = (thinkingChunk: string) => {
    fullThinking += thinkingChunk;
    ctx.setStreamingThinking(fullThinking);
  };

  if (effectiveWebEnabled) {
    runCloudAwareToolLoop({
      messages: apiMessages,
      webDepth: ctx.webDepth,
      includeMcpTools: true,
      containsFileContext: Boolean(
        ambientFileContext && ambientFileContext !== "FILE_SEARCH_NO_RESULTS"
      ),
      // Tools → "Search my files" (or /files) is explicit consent to ground on local
      // hits — do not force the local-model path when the user is in Cloud mode.
      userConfirmedCloudContext: Boolean(ctx.fileIndexerEnabled || slashFileSearch),
      contextSource:
        ambientFileContext && ambientFileContext !== "FILE_SEARCH_NO_RESULTS"
          ? "ambient_file"
          : undefined,
      modelId: ctx.selectedModel || undefined,
      signal: ctrl.signal,
      disableThinking: !ctx.thinkingEnabled,
      generationOptions,
      onChunk,
      onThinking,
      onArtifact: (artifact) => {
        ctx.updateSession(sid, () => ({
          artifactPath: artifact.path,
          artifactStage: "LivePreview",
        }));
      },
    })
      .then((result) => {
        webSearchResult = result.webSearchResult;
        if (result.thinking && !fullThinking) {
          fullThinking = result.thinking;
        }
        if (result.artifacts[0]) {
          ctx.updateSession(sid, () => ({
            artifactPath: result.artifacts[0]!.path,
            artifactStage: "LivePreview",
          }));
        }
        finishOk(fullResponse || result.content, fullThinking || result.thinking, webSearchResult);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        finishErr(err);
      });
    return;
  }

  const containsFileContext = Boolean(
    ambientFileContext && ambientFileContext !== "FILE_SEARCH_NO_RESULTS"
  );

  streamChatByMode({
    messages: apiMessages,
    intent: "quick_chat",
    containsFileContext,
    userConfirmedCloudContext: Boolean(ctx.fileIndexerEnabled || slashFileSearch),
    contextSource: containsFileContext ? "ambient_file" : undefined,
    modelId: ctx.selectedModel || undefined,
    signal: ctrl.signal,
    disableThinking: !ctx.thinkingEnabled,
    generationOptions,
    onChunk,
    onThinking,
    onFinish: () => finishOk(fullResponse, fullThinking, null),
    onError: finishErr,
  });
}
