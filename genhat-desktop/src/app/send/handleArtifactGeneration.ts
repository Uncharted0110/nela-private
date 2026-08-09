import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import type { ArtifactResult } from "../../types";
import { parseArtifactPlanJson, parseHtmlPlanJson } from "../artifactPlanJson";
import { normalizePresentationPlan } from "../artifactPlanNormalize";
import { fitArtifactPlanPrompt } from "../artifactContextBudget";
import { buildPresentationFallbackPlan } from "../presentationDocumentPlan";
import { streamChatByMode, willRouteToCloud } from "./cloudOrLocalStream";
import { useCloudStore } from "../../stores/cloudStore";
import { useChatModeStore } from "../../stores/chatModeStore";
import {
  buildSpreadsheetDataContext,
  buildSpreadsheetFallbackPlan,
  buildSpreadsheetSystemParts,
  extractSpreadsheetRowCount,
  normalizeSpreadsheetPlan,
  parseSpreadsheetPlanJson,
  spreadsheetPlanMaxTokens,
} from "../spreadsheetPlan";
import { tryBuildDeterministicWebSpreadsheetPlan } from "../spreadsheetWebPlan";
import { inferHtmlTheme } from "../htmlThemeInference";
import {
  attachSpreadsheetToPlan,
  buildHtmlDataContext,
  spreadsheetFromParsed,
  type SpreadsheetData,
} from "../htmlChartData";
import {
  attachImagesToHtmlPlan,
  attachImagesToPresentationPlan,
  buildArtifactImagePool,
  formatImageCatalogForPrompt,
} from "../artifactImagePool";
import {
  HTML_PLAN_MAX_TOKENS,
  HTML_FREEFORM_MAX_TOKENS,
  buildHtmlArtifactSystemParts,
  defaultThemeForArchetype,
  htmlPlanRequest,
  inferHtmlPageStructure,
  mapHtmlRendererTheme,
} from "../htmlArtifactPrompt";
import { buildPresentationSystemParts } from "../presentationPlanPrompt";
import { resolveCloudArtifactMode } from "../cloudPresentationMode";
import {
  parsePresentationHtmlArtifactOutput,
  looksLikeHtmlPageJsonPlan,
  looksLikePresentationJsonPlan,
} from "../artifactHtmlOutput";
import {
  webArtifactGroundingPreamble,
  webPresentationGroundingPreamble,
  webContextCharLimit,
  webSearchOptionsForArtifact,
} from "../webSearchQuery";
import { formulateArtifactWebQueries, mergeWebSearchResults } from "./webSearchToolLoop";
import { MAX_ARTIFACT_HOST_QUERIES } from "./webSearchLimits";
import { runCloudArtifactWebResearch } from "./cloudNativeToolLoop";
import { useModelStore } from "../../stores/modelStore";
import { StreamArtifactParser, looksLikeHtmlContent, stripPartialArtifactTags } from "../streamArtifactParser";
import {
  defaultArtifactFollowup,
  defaultArtifactIntro,
} from "../artifactChatCopy";
import { friendlyErrorFromUnknown } from "../friendlyError";
import { saveStreamedArtifact } from "../streamArtifactSave";
import { sanitizeCsvArtifactBody } from "../sanitizeCsvArtifact";
import { createStreamChunkFlusher } from "../streamUiBatch";
import {
  extractAmbientSearchQuery,
  shouldRunAmbientFileSearch,
} from "../ambientSearch";
import {
  formatAmbientFileSection,
  loadAmbientFileBody,
  MAX_ARTIFACT_SOURCE_CHARS,
} from "../ambientFileContent";
import { DISCOVERY_NOTICE_PREFIX } from "../contextCompaction";
import {
  extractSlideCount,
  inferPresentationTheme,
} from "./presentationTheme";
import { repairNestedKeys } from "./repairNestedKeys";
import type { WebSearchResult } from "../../types";
import type { SendHandlerContext } from "./types";

export async function handleArtifactGeneration(
  text: string,
  _tool: string,
  schemaId: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  options?: {
    webEnabled?: boolean;
    webDepth?: "snippets" | "full";
    ragEnabled?: boolean;
    forceFileSearch?: boolean;
  }
): Promise<void> {
  const preferredModeEarly = useCloudStore.getState().preferredMode;
  const earlyUseCloud = willRouteToCloud({
    containsFileContext: false,
    userConfirmedCloudContext: preferredModeEarly === "cloud",
  });
  const earlyKind =
    schemaId === "presentation_synthesis"
      ? "presentation"
      : schemaId === "spreadsheet_synthesis"
        ? "spreadsheet"
        : schemaId === "html_synthesis"
          ? "html"
          : null;
  const earlyFreeform = Boolean(
    earlyKind &&
      earlyUseCloud &&
      (() => {
        const mode = resolveCloudArtifactMode({
          useCloud: true,
          kind: earlyKind,
        });
        return mode === "html" || mode === "csv";
      })()
  );

  ctx.updateSession(sid, (prev) => ({
    loading: true,
    artifactStage: "IntentLocked",
    artifactPath: null,
    artifactPanelOpen: false,
    artifactStreamActive: false,
    streamingArtifactHtml: undefined,
    streamingArtifactCsv: undefined,
    streamingArtifactType: undefined,
    streamingArtifactTitle: undefined,
    messages: [
      ...prev.messages,
      {
        role: "assistant",
        content: "",
        artifactStage: "IntentLocked",
        artifactPath: null,
        ...(earlyFreeform ? { artifactUseSidePanel: true } : {}),
      }
    ]
  }));

  let artifactWebSearchResult: WebSearchResult | null = null;

  const updateArtifactMsg = (
    stage: PipelineStageKind,
    path: string | null = null,
    contentOverride?: string
  ) => {
    ctx.updateSession(sid, (prev) => {
      const updated = [...prev.messages];
      const idx = updated
        .map((m, i) => ({ m, i }))
        .reverse()
        .find(({ m }) => m.role === "assistant" && m.artifactStage !== undefined)?.i;
      if (idx !== undefined && updated[idx]) {
        const prevMsg = updated[idx]!;
        // Never dump HTML / file paths into the chat bubble for side-panel artifacts.
        let nextContent = prevMsg.content;
        if (contentOverride !== undefined) {
          const looksLikeDump =
            /Generated artifact successfully/i.test(contentOverride) ||
            /<!DOCTYPE\s+html|<html[\s>]/i.test(contentOverride) ||
            contentOverride.includes("/tmp/nela_artifacts");
          if (prevMsg.artifactUseSidePanel && looksLikeDump) {
            // Keep existing short prose; chip carries the file affordance.
            nextContent = prevMsg.content;
          } else {
            nextContent = contentOverride;
          }
        }
        updated[idx] = {
          ...prevMsg,
          artifactStage: stage,
          ...(path !== null ? { artifactPath: path } : {}),
          content: nextContent,
          ...(artifactWebSearchResult
            ? { webSearchResult: artifactWebSearchResult }
            : {}),
        };
      }
      return {
        artifactStage: stage,
        ...(path !== null ? { artifactPath: path } : {}),
        messages: updated,
      };
    });
  };

  try {
    const preferredMode = useCloudStore.getState().preferredMode;
    const cloudConfirmed = preferredMode === "cloud";
    const containsFileContextEarly = false; // refined later after ambient load
    const routeCloud = willRouteToCloud({
      containsFileContext: containsFileContextEarly,
      userConfirmedCloudContext: cloudConfirmed,
    });
    // GBNF is local-only; cloud uses free-form JSON + response_format.
    const grammar = routeCloud ? undefined : await Api.getSchemaGrammar(schemaId);

    let headers: string[] | undefined;
    let rows: string[][] | undefined;
    let spreadsheetData: SpreadsheetData | null = null;
    let ambientFileContent = "";

    const attachedPaths =
      ctx.directDocumentPaths.length > 0 ? [...ctx.directDocumentPaths] : [];
    let attachedFile = attachedPaths[0] ?? null;

    const wantsAmbientFileSearch = shouldRunAmbientFileSearch(text, {
      forceFileSearch: options?.forceFileSearch,
    });

    // Proactive doc-graph search if no file is attached but query references a file
    if (!attachedFile && wantsAmbientFileSearch) {
      updateArtifactMsg("SearchingDisk");
      const searchQuery = extractAmbientSearchQuery(text);
      try {
        const md = await Api.queryKnowledgeBase(searchQuery);
        if (md.trim() && md !== "No relevant structural context found.") {
          ambientFileContent = md;
          const pathMatch = md.match(/\(File:\s*([^)]+)\)/);
          if (pathMatch?.[1]) {
            attachedFile = pathMatch[1].trim();
            attachedPaths.push(attachedFile);
            const filename = attachedFile.split(/[/\\]/).pop() ?? "file";
            ctx.updateSession(sid, (prev) => ({
              messages: [
                ...prev.messages,
                {
                  role: "assistant" as const,
                  content: `${DISCOVERY_NOTICE_PREFIX} **${filename}**\nPath: \`${attachedFile}\`\nReading document content…`,
                },
              ],
            }));
          }
        }
      } catch (err) {
        console.warn("Doc-graph search failed:", err);
      }
    }

    const loadDocumentBody = async (
      path: string,
      contentLimit: number
    ): Promise<string> => {
      const isSpreadsheet =
        path.endsWith(".csv") ||
        path.endsWith(".tsv") ||
        path.endsWith(".xlsx") ||
        path.endsWith(".xls") ||
        path.endsWith(".ods");

      if (isSpreadsheet) {
        try {
          const parsed = await Api.parseSpreadsheetData(path);
          const sheet = spreadsheetFromParsed(parsed.rows);
          if (sheet) {
            // Prefer the first structured spreadsheet for table ops.
            if (!spreadsheetData) {
              headers = sheet.headers;
              rows = sheet.rows;
              spreadsheetData = sheet;
            }
            return formatAmbientFileSection(
              path,
              `Columns: [${sheet.headers.join(", ")}]\nRow count: ${sheet.rows.length}`
            );
          }
        } catch (err) {
          console.warn("Failed to parse spreadsheet file:", err);
        }
        try {
          const fileContent = await Api.readFileText(path);
          if (fileContent) {
            return formatAmbientFileSection(path, fileContent.substring(0, contentLimit));
          }
        } catch (err) {
          console.warn("Failed to read spreadsheet text:", err);
        }
        return "";
      }

      // Documents (PDF, DOCX, resume, etc.): cache first, then on-demand parse.
      const body = await loadAmbientFileBody(path, contentLimit);
      return formatAmbientFileSection(path, body);
    };

    if (attachedPaths.length > 0) {
      updateArtifactMsg("SearchingDisk");
      const perFileLimit =
        schemaId === "spreadsheet_synthesis"
          ? 20480
          : Math.floor(MAX_ARTIFACT_SOURCE_CHARS / Math.max(1, Math.min(attachedPaths.length, 3)));
      const sections: string[] = [];
      for (const path of attachedPaths.slice(0, 3)) {
        const section = await loadDocumentBody(path, perFileLimit);
        if (section.trim()) sections.push(section);
      }
      ambientFileContent = sections.join("\n\n");
    }

    // Ensure document text is loaded for PDF/DOC paths (index cache or search snippet may be incomplete).
    const needsOnDemandParse =
      attachedFile &&
      !headers?.length &&
      (!ambientFileContent ||
        ambientFileContent.includes("(Content could not be extracted")) &&
      /\.(pdf|docx|pptx|doc|ppt)$/i.test(attachedFile);

    if (needsOnDemandParse && attachedFile) {
      try {
        const fileContent = await Api.readFileText(attachedFile);
        const contentLimit =
          schemaId === "spreadsheet_synthesis" ? 20480 : 10240;
        if (fileContent?.trim()) {
          ambientFileContent = formatAmbientFileSection(
            attachedFile,
            fileContent.substring(0, contentLimit)
          );
        }
      } catch (err) {
        console.warn("Failed to read attached document for artifact context:", err);
      }
    }

    updateArtifactMsg("CrunchingMetrics");

    const contextWindowTokens = ctx.getContextWindowTokens(ctx.selectedModel);
    const webActive = Boolean(options?.webEnabled);

    let supplementalContext = "";

    let webHitsForImages: import("../../types").SearchHit[] = [];
    const rowPlan =
      schemaId === "spreadsheet_synthesis"
        ? extractSpreadsheetRowCount(text)
        : { count: null, explicit: false };
    let deterministicWebPlan = null as ReturnType<
      typeof tryBuildDeterministicWebSpreadsheetPlan
    >;

    if (options?.ragEnabled && ctx.ragDocs.length > 0) {
      try {
        const setup = await Api.queryRagStream(text);
        if (setup.sources.length > 0) {
          supplementalContext +=
            "Knowledge base sources:\n" +
            setup.sources
              .map((source, index) => `Source ${index + 1} (${source.doc_title}):\n${source.text}`)
              .join("\n\n") +
            "\n\n";
        }
      } catch (err) {
        console.warn("RAG grounding for artifact generation failed:", err);
      }
    }

    if (options?.webEnabled) {
      try {
        const { fetchContent, maxResults } = webSearchOptionsForArtifact(
          schemaId,
          contextWindowTokens
        );
        let merged = null as WebSearchResult | null;

        const intelligenceMode = useModelStore.getState().intelligenceMode;
        const useCloudWebTools =
          willRouteToCloud({
            containsFileContext: false,
            userConfirmedCloudContext: cloudConfirmed,
          }) &&
          (intelligenceMode === "smart" ||
            intelligenceMode === "deep" ||
            intelligenceMode === "auto");

        if (useCloudWebTools) {
          // Smart/Deep: OpenRouter model issues web_search tool calls with its own queries.
          useChatModeStore
            .getState()
            .setLiveToolStatus("Cloud model choosing web searches…");
          try {
            merged = await runCloudArtifactWebResearch({
              artifactRequest: text,
              schemaId,
              webDepth: fetchContent ? "full" : "snippets",
              signal: ctrl.signal,
              onStatus: (status) =>
                useChatModeStore.getState().setLiveToolStatus(status),
            });
          } catch (cloudWebErr) {
            console.warn(
              "Cloud artifact web research failed; falling back to host queries:",
              cloudWebErr
            );
          }
        }

        if (!merged) {
          useChatModeStore
            .getState()
            .setLiveToolStatus("Choosing web search queries…");
          const queries = await formulateArtifactWebQueries(text, {
            modelId: ctx.selectedModel || undefined,
            maxQueries: MAX_ARTIFACT_HOST_QUERIES,
          });
          const perQuery = Math.max(
            1,
            Math.ceil(maxResults / Math.max(queries.length, 1))
          );
          for (const searchQuery of queries) {
            if (!searchQuery.trim()) continue;
            try {
              useChatModeStore
                .getState()
                .setLiveToolStatus(
                  `Searching the web: ${searchQuery.slice(0, 80)}`
                );
              const result = await Api.webSearch(searchQuery, perQuery, {
                profile: fetchContent ? "research" : "simple",
              });
              merged = mergeWebSearchResults(merged, result);
              if (merged) {
                artifactWebSearchResult = merged;
                updateArtifactMsg("CrunchingMetrics");
              }
            } catch (err) {
              console.warn("Web search query failed:", searchQuery, err);
            }
          }
        }

        if (merged) {
          artifactWebSearchResult = merged;
          updateArtifactMsg("CrunchingMetrics");
          if (
            schemaId === "spreadsheet_synthesis" &&
            merged.extracted_tables &&
            merged.extracted_tables.length > 0
          ) {
            deterministicWebPlan = tryBuildDeterministicWebSpreadsheetPlan(
              merged.extracted_tables,
              text,
              rowPlan.explicit ? rowPlan.count : null
            );
            if (deterministicWebPlan) {
              console.info(
                "Using deterministic web table for spreadsheet:",
                merged.extracted_tables[0]?.source_url
              );
            }
          }
          if (merged.formatted_context) {
            const webLimit = webContextCharLimit(contextWindowTokens);
            const trimmedWeb =
              merged.formatted_context.length > webLimit
                ? merged.formatted_context.slice(0, webLimit) +
                  "\n\n[...web excerpts truncated for context limit]\n--- End of web sources ---\n"
                : merged.formatted_context;
            const grounding =
              schemaId === "presentation_synthesis"
                ? webPresentationGroundingPreamble()
                : webArtifactGroundingPreamble();
            supplementalContext += grounding + `${trimmedWeb}\n\n`;
          }
          webHitsForImages = merged.results ?? [];
          useChatModeStore
            .getState()
            .setLiveToolStatus(
              `Found ${merged.results?.length ?? 0} web sources`
            );
        } else {
          useChatModeStore.getState().setLiveToolStatus(null);
        }
      } catch (err) {
        console.warn("Web grounding for artifact generation failed:", err);
        useChatModeStore.getState().setLiveToolStatus(null);
      }
    }

    // Cap document text so prompts fit the local model's context (prevents llama 500s).
    if (ambientFileContent) {
      const docCap =
        contextWindowTokens <= 4096
          ? webActive
            ? 2500
            : 4500
          : contextWindowTokens <= 8192
            ? webActive
              ? 5000
              : 9000
            : webActive
              ? 8000
              : MAX_ARTIFACT_SOURCE_CHARS;
      if (ambientFileContent.length > docCap) {
        ambientFileContent =
          ambientFileContent.substring(0, docCap) +
          "\n\n[...document truncated to fit model context]\n";
      }
    }

    const hasSourceData = Boolean(headers && headers.length > 0 && rows);

    if (
      schemaId === "spreadsheet_synthesis" &&
      deterministicWebPlan &&
      !hasSourceData
    ) {
      updateArtifactMsg("WritingCode");
      try {
        const result = await Api.generateSpreadsheet(deterministicWebPlan);
        ctx.updateSession(sid, {
          loading: false,
        });
        const filename = result.path.split(/[/\\]/).pop();
        updateArtifactMsg(
          "LivePreview",
          result.path,
          `Generated spreadsheet from verified web data: **${filename}**\nPath: \`${result.path}\``
        );
      } catch (execErr: unknown) {
        const message =
          execErr instanceof Error ? execErr.message : String(execErr);
        console.error("Deterministic web spreadsheet failed:", execErr);
        ctx.updateSession(sid, { loading: false });
        updateArtifactMsg(
          "Error",
          null,
          `Failed to build spreadsheet from web data: ${message}`
        );
      }
      return;
    }

    const imagePool = await buildArtifactImagePool({
      webHits: webHitsForImages,
      documentPath: attachedFile,
    });
    const imageCatalog = formatImageCatalogForPrompt(imagePool);

    let dataContext = supplementalContext;
    const hasSourceDocument =
      !!ambientFileContent &&
      !ambientFileContent.includes("(Content could not be extracted");
    if (schemaId === "spreadsheet_synthesis") {
      dataContext += buildSpreadsheetDataContext({
        headers: hasSourceData ? headers : undefined,
        rows: hasSourceData ? rows : undefined,
        ambientContent: !hasSourceData ? ambientFileContent : undefined,
      });
    } else if (headers && headers.length > 0) {
      if (spreadsheetData) {
        dataContext += buildHtmlDataContext(spreadsheetData, 12);
      } else {
        dataContext +=
          `Source data columns: [${headers.join(", ")}].\n` +
          `Number of rows: ${rows ? rows.length : 0}.\n\n`;
      }
    } else if (ambientFileContent) {
      if (schemaId === "presentation_synthesis" && hasSourceDocument) {
        dataContext +=
          `=== ATTACHED SOURCE DOCUMENT (authoritative — every slide must cite concrete facts from here) ===\n` +
          `${ambientFileContent}\n` +
          `=== END SOURCE DOCUMENT ===\n\n`;
      } else {
        dataContext += `Source data details:\n${ambientFileContent}\n\n`;
      }
    }

    const sourceDocumentRules =
      schemaId === "presentation_synthesis" && hasSourceDocument
        ? `
SOURCE DOCUMENT RULES (mandatory when source is provided in the user message):
- Every slide MUST reflect specific facts from the attached source document.
- Use the person's real name, employers, schools, skills, projects, and achievements from the source.
- Do NOT produce a generic template deck ("Resume Analysis Overview", "Key Skills", "Experience" as empty section headers).
- Do NOT use placeholder names or filler ("John Doe", "Company X", "Skill 1", "Lorem ipsum").
- Structure the deck to present what is actually in the document: introduction → experience → skills → education → highlights/summary.
- Pack each slide with concrete facts — sparse title-only slides are not acceptable when source text is available.
`
        : "";

    const slidePlan = extractSlideCount(text);
    const themeHint = inferPresentationTheme(text);
    const htmlThemeHint = inferHtmlTheme(text);
    const htmlArchetype =
      schemaId === "html_synthesis" ? inferHtmlPageStructure(text) : "landing";
    const htmlHasSourceData =
      schemaId === "html_synthesis" && spreadsheetData !== null;

    const containsFileContext = Boolean(ambientFileContent?.trim());
    const useCloud = willRouteToCloud({
      containsFileContext,
      userConfirmedCloudContext: cloudConfirmed,
    });
    // Free/fast models can't finish freeform HTML (truncate mid-CSS → blank page).
    // Use structured JSON → NELA renderer for those; freeform streaming for Smart/Deep.
    const artifactKind =
      schemaId === "presentation_synthesis"
        ? "presentation"
        : schemaId === "spreadsheet_synthesis"
          ? "spreadsheet"
          : schemaId === "html_synthesis"
            ? "html"
            : null;
    const cloudArtifactMode = artifactKind
      ? useCloud
        ? resolveCloudArtifactMode({ useCloud: true, kind: artifactKind })
        : "local"
      : null;
    const cloudPresentationMode =
      schemaId === "presentation_synthesis"
        ? cloudArtifactMode === "csv"
          ? "json"
          : cloudArtifactMode
        : null;
    const cloudHtmlMode =
      schemaId === "html_synthesis"
        ? cloudArtifactMode === "csv"
          ? "json"
          : cloudArtifactMode
        : null;
    const cloudSpreadsheetMode =
      schemaId === "spreadsheet_synthesis"
        ? cloudArtifactMode === "html"
          ? "csv"
          : cloudArtifactMode === "csv" ||
              cloudArtifactMode === "json" ||
              cloudArtifactMode === "local"
            ? cloudArtifactMode
            : "local"
        : null;
    const cloudPresentationFreeform = cloudPresentationMode === "html";
    const cloudPresentationJson = cloudPresentationMode === "json";
    const cloudHtmlFreeform = cloudHtmlMode === "html";
    const cloudSpreadsheetFreeform = cloudSpreadsheetMode === "csv";
    const cloudAnyFreeform =
      cloudPresentationFreeform || cloudHtmlFreeform || cloudSpreadsheetFreeform;

    if (cloudAnyFreeform) {
      ctx.updateSession(sid, (prev) => {
        const updated = [...prev.messages];
        const idx = updated
          .map((m, i) => ({ m, i }))
          .reverse()
          .find(({ m }) => m.role === "assistant" && m.artifactStage !== undefined)?.i;
        if (idx !== undefined && updated[idx]) {
          updated[idx] = {
            ...updated[idx]!,
            artifactUseSidePanel: true,
            content: "",
          };
        }
        return { messages: updated };
      });
    }

    const slideCountInstruction = cloudPresentationFreeform
      ? slidePlan.explicit
        ? `Produce EXACTLY ${slidePlan.count} slides, as the user explicitly requested. Each slide must carry substantial real content (not sparse titles).`
        : `Produce a rich multi-slide deck of about ${Math.max(slidePlan.count, 6)}–10 slides with substantial content on each slide (paragraphs + specifics), unless the topic clearly needs fewer.`
      : cloudPresentationJson
        ? slidePlan.explicit
          ? `Produce EXACTLY ${slidePlan.count} slides, as the user explicitly requested. Each bullet must be concrete (15–40 words when possible).`
          : `Produce about ${Math.max(slidePlan.count, 6)}–10 content-rich slides with concrete facts (names, dates, places).`
        : slidePlan.explicit
          ? `Produce EXACTLY ${slidePlan.count} slides, as the user explicitly requested.`
          : `Produce a complete multi-slide deck of about ${slidePlan.count} slides (add or remove a few only if the topic clearly needs it).`;

    const systemParts =
      schemaId === "html_synthesis"
        ? buildHtmlArtifactSystemParts(htmlArchetype, {
            hasSourceData: htmlHasSourceData,
            hasImages: imagePool.length > 0,
            cloudMode: cloudHtmlMode ?? "local",
          })
        : schemaId === "spreadsheet_synthesis"
        ? buildSpreadsheetSystemParts(hasSourceData, rowPlan.count, {
            cloudMode:
              cloudSpreadsheetMode === "csv"
                ? "csv"
                : cloudSpreadsheetMode === "json"
                  ? "json"
                  : "local",
          })
        : schemaId === "presentation_synthesis"
        ? buildPresentationSystemParts({
            slideCountInstruction,
            sourceDocumentRules,
            cloudMode: cloudPresentationMode ?? "local",
          })
        : null;

    const systemPrompt =
      systemParts != null
        ? systemParts.dynamic
          ? `${systemParts.cacheable}\n\n${systemParts.dynamic}`
          : systemParts.cacheable
        : "You generate ONLY a JSON plan. Return valid JSON only.";

    // Local / cloud-JSON decks use the theme-aware renderer.
    // Cloud HTML freeform invents its own design.
    const themeSuffix = cloudAnyFreeform
      ? ""
      : ` Theme: "${themeHint}".`;
    const rowCountSuffix =
      schemaId === "spreadsheet_synthesis" &&
      rowPlan.explicit &&
      rowPlan.count
        ? ` WRITE_DATA must contain EXACTLY ${rowPlan.count} data rows (not counting headers).`
        : "";
    const planRequest =
      schemaId === "presentation_synthesis"
        ? cloudPresentationFreeform
          ? hasSourceDocument
            ? `Write a complete HTML presentation deck for: "${text}". Use only real details from the ATTACHED SOURCE DOCUMENT. Wrap in <nela-artifact type="text/html" title="...">. Put ALL slide body content BEFORE CSS.`
            : `Write a complete HTML presentation deck about: "${text}". ` +
              `Stay on this exact subject — do not pivot to worksheets, crafts, or unrelated products. ` +
              `Wrap in <nela-artifact type="text/html" title="...">. Put ALL slide body content BEFORE CSS.`
          : hasSourceDocument
            ? `Using the ATTACHED SOURCE DOCUMENT, create a ${slidePlan.count}-slide deck. User request: "${text}". Use only real details from the source — no placeholders.${themeSuffix}`
            : `Create a ${slidePlan.count}-slide JSON deck about: "${text}".` +
              ` Stay on this exact subject — do not pivot to worksheets, crafts, or unrelated products.` +
              ` Define the topic early; include concrete examples and named concepts on later slides.` +
              ` Do not repeat the topic phrase as filler.${themeSuffix}` +
              (cloudPresentationJson
                ? ` Reply with ONLY a single JSON object starting with { and ending with }. No HTML, no markdown fences, no commentary.`
                : "")
        : schemaId === "html_synthesis"
        ? htmlPlanRequest(text, htmlArchetype, {
            hasSourceData: htmlHasSourceData,
            cloudMode: cloudHtmlMode ?? "local",
          })
        : schemaId === "spreadsheet_synthesis" && cloudSpreadsheetFreeform
          ? `Create a spreadsheet as CSV for: "${text}".` +
            (rowPlan.explicit && rowPlan.count
              ? ` Include EXACTLY ${rowPlan.count} data rows.`
              : "") +
            ` Wrap it in <nela-artifact type="text/csv" title="...">...</nela-artifact>.`
          : `Generate a plan for the user request: "${text}".${rowCountSuffix}`;
    const spreadsheetContext =
      schemaId === "html_synthesis" && spreadsheetData
        ? buildHtmlDataContext(spreadsheetData)
        : "";
    const dataContextBody = `${dataContext}${spreadsheetContext}${imageCatalog}`;
    const planRequestText = planRequest;

    // Presentations need far more output room than a single artifact plan: budget
    // roughly per-slide so larger decks aren't truncated mid-array.
    // Keep budgets conservative when a source document is attached — oversized
    // max_tokens + long prompts frequently crash llama-server (proxy 500).
    const desiredPlanMaxTokens =
      schemaId === "presentation_synthesis"
        ? cloudPresentationFreeform
          ? Math.min(16000, Math.max(10000, 2000 + slidePlan.count * 900))
          : cloudPresentationJson
            ? Math.min(
                8192,
                900 + slidePlan.count * 380 + (hasSourceDocument ? 600 : 0)
              )
            : Math.min(
                contextWindowTokens <= 4096
                  ? 1800
                  : contextWindowTokens <= 8192
                    ? 3200
                    : 8192,
                700 +
                  slidePlan.count * (hasSourceDocument ? 280 : 420) +
                  (hasSourceDocument ? 600 : 0)
              )
        : schemaId === "html_synthesis"
        ? cloudHtmlFreeform
          ? HTML_FREEFORM_MAX_TOKENS
          : HTML_PLAN_MAX_TOKENS
        : schemaId === "spreadsheet_synthesis"
        ? cloudSpreadsheetFreeform
          ? Math.min(12_000, Math.max(4096, 800 + (rowPlan.count ?? 20) * 40))
          : spreadsheetPlanMaxTokens(hasSourceData, ambientFileContent, rowPlan.count)
        : 500;

    // Cloud freeform / JSON must not be crushed by local model context sizes.
    const promptContextWindowTokens =
      cloudAnyFreeform || cloudPresentationJson
        ? Math.max(contextWindowTokens, 128_000)
        : contextWindowTokens;

    const fitted = fitArtifactPlanPrompt({
      contextWindowTokens: promptContextWindowTokens,
      systemPrompt,
      dataContext: dataContextBody,
      planRequest: planRequestText,
      desiredMaxOutputTokens: desiredPlanMaxTokens,
    });

    const planMaxTokens =
      cloudAnyFreeform || cloudPresentationJson
        ? Math.max(fitted.maxOutputTokens, desiredPlanMaxTokens)
        : fitted.maxOutputTokens;
    const planTemperature =
      schemaId === "html_synthesis"
        ? cloudHtmlFreeform
          ? 0.55
          : 0.4
        : schemaId === "presentation_synthesis"
          ? cloudPresentationFreeform
            ? 0.55
            : cloudPresentationJson
              ? 0.4
              : 0.35
          : schemaId === "spreadsheet_synthesis" && cloudSpreadsheetFreeform
            ? 0.3
            : 0.1;

    let planJson = "";
    const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

    const executePlanObj = async (planObjIn: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let planObj: any = repairNestedKeys(planObjIn);

      if (schemaId === "html_synthesis") {
        planObj.archetype = htmlArchetype;
        planObj.theme = mapHtmlRendererTheme(
          planObj.theme || htmlThemeHint || defaultThemeForArchetype(htmlArchetype)
        );
        if (!planObj.title || String(planObj.title).trim() === "") {
          planObj.title = text.trim().slice(0, 120) || "Generated Page";
        }
        if (!Array.isArray(planObj.sections)) {
          planObj.sections = [];
        }
        if (spreadsheetData) {
          planObj = attachSpreadsheetToPlan(planObj, spreadsheetData);
        }
        if (imagePool.length) {
          planObj = attachImagesToHtmlPlan(planObj, imagePool);
        }
      }

      if (schemaId === "presentation_synthesis" && imagePool.length) {
        planObj = attachImagesToPresentationPlan(planObj, imagePool);
      }

      if (headers && rows && schemaId === "spreadsheet_synthesis") {
        planObj.headers = headers;
        planObj.source_rows = rows;
      }

      if (schemaId === "presentation_synthesis") {
        // Cloud HTML freeform never enters this path.
        planObj.theme = themeHint;
        planObj = normalizePresentationPlan(planObj, text, {
          targetSlideCount: slidePlan.count,
          lightRepair: cloudPresentationJson,
        });
        if (!planObj.output_name) {
          const slides = Array.isArray(planObj.slides) ? planObj.slides : [];
          const titleSlide =
            slides.find(
              (s: { layout?: string; title?: string }) => s?.layout === "TITLE"
            ) ?? slides[0];
          const deckTitle = (titleSlide?.title ?? "").toString().trim();
          const slug = deckTitle
            .replace(/[\\/:*?"<>|]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
          if (slug) planObj.output_name = slug;
        }
      }

      let result: ArtifactResult;
      if (schemaId === "spreadsheet_synthesis") {
        result = await Api.generateSpreadsheet(
          normalizeSpreadsheetPlan(planObj, {
            prompt: text,
            hasSourceData: Boolean(headers && headers.length > 0 && rows),
            expectedRowCount: rowPlan.count,
          })
        );
      } else if (schemaId === "presentation_synthesis") {
        result = await Api.generatePresentation(planObj);
      } else {
        result = await Api.generateHtml(planObj);
      }

      ctx.updateSession(sid, { loading: false });
      useChatModeStore.getState().setLiveToolStatus(null);
      const filename = result.path.split(/[/\\]/).pop();
      updateArtifactMsg(
        "LivePreview",
        result.path,
        `Generated artifact successfully: **${filename}**\nPath: \`${result.path}\``
      );
    };

    /** When the LLM fails, still produce PPT/Excel from attached document text. */
    const tryDocumentFallback = async (reason: unknown): Promise<boolean> => {
      if (schemaId === "presentation_synthesis" && hasSourceDocument) {
        const fallback = buildPresentationFallbackPlan({
          userPrompt: text,
          ambientContent: ambientFileContent,
          theme: themeHint,
          targetSlideCount: slidePlan.count,
        });
        if (fallback) {
          console.warn("Using document fallback for presentation:", reason);
          updateArtifactMsg("WritingCode");
          await executePlanObj(fallback);
          return true;
        }
      }
      if (schemaId === "spreadsheet_synthesis") {
        const sheetFallback = {
          prompt: text,
          hasSourceData: Boolean(headers && headers.length > 0 && rows),
          ambientContent: ambientFileContent || undefined,
        };
        const fallback = buildSpreadsheetFallbackPlan(sheetFallback);
        if (fallback) {
          console.warn("Using document fallback for spreadsheet:", reason);
          updateArtifactMsg("WritingCode");
          await executePlanObj(fallback);
          return true;
        }
      }
      return false;
    };

    const planMessages =
      useCloud && systemParts
        ? [
            { role: "system" as const, content: systemParts.cacheable },
            ...(systemParts.dynamic
              ? [{ role: "system" as const, content: systemParts.dynamic }]
              : []),
            { role: "user" as const, content: fitted.userPrompt },
          ]
        : [
            { role: "system" as const, content: fitted.systemPrompt },
            { role: "user" as const, content: fitted.userPrompt },
          ];

    if (options?.webEnabled && artifactWebSearchResult) {
      useChatModeStore
        .getState()
        .setLiveToolStatus(
          cloudPresentationFreeform
            ? "Writing presentation HTML…"
            : cloudHtmlFreeform
              ? "Writing webpage HTML…"
              : cloudSpreadsheetFreeform
                ? "Writing spreadsheet CSV…"
                : schemaId === "presentation_synthesis"
                  ? "Writing presentation plan…"
                  : "Writing artifact plan…"
        );
    } else if (!options?.webEnabled) {
      useChatModeStore.getState().setLiveToolStatus(null);
    }

    const streamParser = cloudAnyFreeform ? new StreamArtifactParser() : null;
    let streamedArtifactBody = "";
    let streamedArtifactType: "text/html" | "text/csv" =
      cloudSpreadsheetFreeform ? "text/csv" : "text/html";
    let streamedArtifactTitle = "";

    const artifactUiFlusher = createStreamChunkFlusher(() => {
      const displayBody =
        streamedArtifactType === "text/csv"
          ? sanitizeCsvArtifactBody(streamedArtifactBody)
          : streamedArtifactBody;
      ctx.updateSession(sid, (prev) => {
        const updated = [...prev.messages];
        const idx = updated
          .map((m, i) => ({ m, i }))
          .reverse()
          .find(({ m }) => m.role === "assistant" && m.artifactStage !== undefined)?.i;
        if (idx !== undefined && updated[idx]) {
          const prevContent = updated[idx]!.content || "";
          const cleaned = stripPartialArtifactTags(prevContent).trim();
          updated[idx] = {
            ...updated[idx]!,
            content:
              cleaned &&
              !looksLikeHtmlContent(cleaned) &&
              !/<nela-artifact\b/i.test(cleaned)
                ? cleaned
                : "",
            artifactUseSidePanel: true,
            artifactTitle: streamedArtifactTitle || updated[idx]!.artifactTitle,
            streamingArtifactType: streamedArtifactType,
          };
        }
        return {
          artifactStreamActive: true,
          artifactPanelOpen: true,
          streamingArtifactType: streamedArtifactType,
          streamingArtifactTitle: streamedArtifactTitle || undefined,
          messages: updated,
          ...(streamedArtifactType === "text/csv"
            ? { streamingArtifactCsv: displayBody }
            : { streamingArtifactHtml: displayBody }),
        };
      });
    });

    const applyStreamEmit = (emit: {
      chatDelta: string;
      artifactDelta: string;
      meta?: { type: "text/html" | "text/csv"; title: string };
      closed?: boolean;
    }) => {
      if (emit.chatDelta) planJson += emit.chatDelta;
      if (emit.meta) {
        streamedArtifactType = emit.meta.type;
        streamedArtifactTitle = emit.meta.title;
      }
      if (emit.artifactDelta) {
        streamedArtifactBody += emit.artifactDelta;
        updateArtifactMsg("WritingCode");
        // Batch panel updates to one paint/frame — avoids freezing the UI.
        artifactUiFlusher.push("1");
      } else if (emit.chatDelta.trim() && streamParser) {
        const intro = stripPartialArtifactTags(
          streamParser.chatBeforeArtifact
        ).trim();
        const followup = stripPartialArtifactTags(
          streamParser.chatAfterArtifact
        ).trim();
        if (
          (intro && !looksLikeHtmlContent(intro)) ||
          (followup && !looksLikeHtmlContent(followup))
        ) {
          ctx.updateSession(sid, (prev) => {
            const updated = [...prev.messages];
            const idx = updated
              .map((m, i) => ({ m, i }))
              .reverse()
              .find(({ m }) => m.role === "assistant" && m.artifactStage !== undefined)?.i;
            if (idx !== undefined && updated[idx]) {
              updated[idx] = {
                ...updated[idx]!,
                ...(intro && !looksLikeHtmlContent(intro)
                  ? { content: intro }
                  : {}),
                ...(followup && !looksLikeHtmlContent(followup)
                  ? { artifactFollowup: followup }
                  : {}),
              };
            }
            return { messages: updated };
          });
        }
      }
    };

    streamChatByMode({
      messages: planMessages,
      intent: "artifact_plan",
      containsFileContext,
      userConfirmedCloudContext: cloudConfirmed,
      contextSource: containsFileContext ? "artifact_source_document" : undefined,
      modelId: ctx.selectedModel || undefined,
      signal: ctrl.signal,
      disableThinking: true,
      disableLocalFallback: cloudConfirmed,
      // Freeform streaming must not use json_object; cloud JSON / other schemas should.
      response_format:
        useCloud && !cloudAnyFreeform
          ? { type: "json_object" }
          : undefined,
      generationOptions: {
        ...generationOptions,
        maxTokens: planMaxTokens,
        temperature: planTemperature,
        // grammar is local-only; cloud path relies on JSON/HTML repair parsers
        grammar: useCloud ? undefined : grammar,
      },
      onChunk: (chunk) => {
        if (streamParser) {
          applyStreamEmit(streamParser.push(chunk));
        } else {
          planJson += chunk;
        }
      },
      onThinking: () => {},
      onFinish: () => {
        void (async () => {
          useChatModeStore.getState().setLiveToolStatus(null);
          updateArtifactMsg("WritingCode");
          try {
            if (cloudAnyFreeform && streamParser) {
              applyStreamEmit(streamParser.finalize());
              artifactUiFlusher.flushNow();
              const body =
                streamedArtifactType === "text/csv"
                  ? sanitizeCsvArtifactBody(
                      streamedArtifactBody.trim() || planJson.trim()
                    )
                  : streamedArtifactBody.trim() || planJson.trim();
              const parserIntro = stripPartialArtifactTags(
                streamParser.chatBeforeArtifact || ""
              ).trim();
              const parserFollowup = stripPartialArtifactTags(
                streamParser.chatAfterArtifact || ""
              ).trim();
              const safeIntro =
                parserIntro && !looksLikeHtmlContent(parserIntro)
                  ? parserIntro
                  : "";
              const safeFollowup =
                parserFollowup && !looksLikeHtmlContent(parserFollowup)
                  ? parserFollowup
                  : "";
              try {
                const result = await saveStreamedArtifact({
                  type: streamedArtifactType,
                  rawBody: body,
                  topic: text,
                  title: streamedArtifactTitle || undefined,
                  asPresentation: schemaId === "presentation_synthesis",
                });
                const filename = result.path.split(/[/\\]/).pop() ?? "artifact";
                const title =
                  streamedArtifactTitle ||
                  filename.replace(/\.(html?|xlsx|csv)$/i, "");
                const asPresentation = schemaId === "presentation_synthesis";
                const prose =
                  safeIntro ||
                  defaultArtifactIntro({
                    title,
                    type: streamedArtifactType,
                    asPresentation,
                  });
                const followup =
                  safeFollowup ||
                  defaultArtifactFollowup({
                    type: streamedArtifactType,
                    asPresentation,
                  });
                // Panel must show the actual HTML/CSV body (may have lived in planJson).
                if (!streamedArtifactBody.trim() && body) {
                  streamedArtifactBody = body;
                }
                ctx.updateSession(sid, (prev) => {
                  const updated = [...prev.messages];
                  const idx = updated
                    .map((m, i) => ({ m, i }))
                    .reverse()
                    .find(
                      ({ m }) =>
                        m.role === "assistant" && m.artifactStage !== undefined
                    )?.i;
                  if (idx !== undefined && updated[idx]) {
                    updated[idx] = {
                      ...updated[idx]!,
                      content: prose,
                      artifactFollowup: followup,
                      artifactStage: "LivePreview",
                      artifactPath: result.path,
                      artifactUseSidePanel: true,
                      artifactTitle: title,
                      streamingArtifactType: streamedArtifactType,
                    };
                  }
                  return {
                    loading: false,
                    artifactStreamActive: true,
                    artifactPanelOpen: true,
                    artifactStage: "LivePreview",
                    artifactPath: result.path,
                    streamingArtifactType: streamedArtifactType,
                    streamingArtifactTitle: title,
                    messages: updated,
                    ...(streamedArtifactType === "text/csv"
                      ? { streamingArtifactCsv: streamedArtifactBody }
                      : { streamingArtifactHtml: streamedArtifactBody }),
                  };
                });
                useChatModeStore.getState().setLiveToolStatus(null);
                return;
              } catch (streamErr) {
                const msg =
                  streamErr instanceof Error
                    ? streamErr.message
                    : String(streamErr);
                // Fall back to JSON plan parsers when the model ignored tags.
                if (
                  msg === "MODEL_RETURNED_JSON_SLIDE_PLAN" ||
                  msg === "MODEL_RETURNED_JSON_HTML_PLAN" ||
                  looksLikePresentationJsonPlan(body) ||
                  looksLikeHtmlPageJsonPlan(body)
                ) {
                  console.warn(
                    "Freeform stream returned JSON plan; using structured renderer fallback"
                  );
                  // fall through to JSON path below with planJson/body
                  planJson = body || planJson;
                } else if (body.trim()) {
                  // Keep preview in the side panel even when disk save fails.
                  if (!streamedArtifactBody.trim()) {
                    streamedArtifactBody = body;
                  }
                  console.error("Streamed artifact save failed:", streamErr);
                  ctx.updateSession(sid, {
                    loading: false,
                    artifactStreamActive: true,
                    artifactPanelOpen: true,
                    ...(streamedArtifactType === "text/csv"
                      ? { streamingArtifactCsv: streamedArtifactBody }
                      : { streamingArtifactHtml: streamedArtifactBody }),
                    streamingArtifactType: streamedArtifactType,
                    streamingArtifactTitle: streamedArtifactTitle || undefined,
                  });
                  updateArtifactMsg(
                    "Error",
                    null,
                    friendlyErrorFromUnknown(
                      msg ? `Preview is ready but saving failed: ${msg}` : streamErr
                    )
                  );
                  return;
                } else {
                  throw streamErr;
                }
              }
            }

            // LLM plan JSON — shape varies by schemaId
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let planObj: any;
            if (schemaId === "html_synthesis") {
              planObj = parseHtmlPlanJson(planJson, {
                prompt: text,
                archetype: htmlArchetype,
                theme: defaultThemeForArchetype(htmlArchetype),
              });
            } else if (schemaId === "spreadsheet_synthesis") {
              const sheetFallback = {
                prompt: text,
                hasSourceData: Boolean(headers && headers.length > 0 && rows),
                ambientContent: ambientFileContent || undefined,
              };
              try {
                planObj = parseSpreadsheetPlanJson(planJson, sheetFallback);
              } catch (parseErr) {
                const docFallback = buildSpreadsheetFallbackPlan(sheetFallback);
                if (docFallback) {
                  console.warn(
                    "Spreadsheet parse failed; using document fallback:",
                    parseErr
                  );
                  planObj = docFallback;
                } else {
                  throw parseErr;
                }
              }
            } else {
              try {
                planObj = parseArtifactPlanJson(planJson, {
                  userPrompt: text,
                  schemaId,
                });
              } catch (jsonErr) {
                // Free models often ignore JSON mode and emit HTML (or truncate it).
                if (
                  cloudPresentationJson &&
                  /<!DOCTYPE\s+html|<html[\s>]|<body[\s>]|<div[\s>]/i.test(
                    planJson
                  )
                ) {
                  try {
                    const parsedHtml = parsePresentationHtmlArtifactOutput(
                      planJson,
                      text
                    );
                    const result = await Api.generateHtml({
                      title: parsedHtml.title,
                      archetype: "landing",
                      sections: [],
                      html: parsedHtml.html,
                      output_name: parsedHtml.output_name,
                    });
                    ctx.updateSession(sid, { loading: false });
                    useChatModeStore.getState().setLiveToolStatus(null);
                    const filename = result.path.split(/[/\\]/).pop();
                    updateArtifactMsg(
                      "LivePreview",
                      result.path,
                      `Generated artifact successfully: **${filename}**\nPath: \`${result.path}\``
                    );
                    return;
                  } catch (htmlSalvageErr) {
                    console.warn(
                      "Cloud PPT JSON parse failed; HTML salvage also failed:",
                      htmlSalvageErr
                    );
                  }
                }

                const docFallback = buildPresentationFallbackPlan({
                  userPrompt: text,
                  ambientContent: ambientFileContent,
                  theme: themeHint,
                  targetSlideCount: slidePlan.count,
                });
                if (docFallback) {
                  console.warn(
                    "Presentation parse failed; using document fallback:",
                    jsonErr
                  );
                  planObj = docFallback;
                } else {
                  console.warn("Failed to parse artifact plan JSON:", jsonErr);
                  const preview = planJson.trim().slice(0, 180).replace(/\s+/g, " ");
                  throw new Error(
                    preview
                      ? `Model did not return valid slide JSON (got: "${preview}${planJson.trim().length > 180 ? "…" : ""}"). Try again.`
                      : "Model returned an empty presentation plan. Try again."
                  );
                }
              }
            }

            await executePlanObj(planObj);
          } catch (execErr: unknown) {
            try {
              if (await tryDocumentFallback(execErr)) return;
            } catch (fallbackErr) {
              console.error("Document fallback also failed:", fallbackErr);
            }
            console.error("Artifact generation execution failed:", execErr);
            useChatModeStore.getState().setLiveToolStatus(null);
            ctx.updateSession(sid, { loading: false });
            updateArtifactMsg("Error", null, friendlyErrorFromUnknown(execErr));
          }
        })();
      },
      onError: (err) => {
        void (async () => {
          console.error("Artifact plan generation failed:", err);
          try {
            if (await tryDocumentFallback(err)) return;
          } catch (fallbackErr) {
            console.error("Document fallback after LLM error failed:", fallbackErr);
          }
          useChatModeStore.getState().setLiveToolStatus(null);
          ctx.updateSession(sid, { loading: false });
          updateArtifactMsg("Error", null, friendlyErrorFromUnknown(err));
        })();
      },
    });

  } catch (err: unknown) {
    console.error("Artifact setup failed:", err);
    useChatModeStore.getState().setLiveToolStatus(null);
    ctx.updateSession(sid, {
      loading: false,
    });
    updateArtifactMsg("Error", null, friendlyErrorFromUnknown(err));
  }
}