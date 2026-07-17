import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import type { ArtifactResult } from "../../types";
import { parseArtifactPlanJson, parseHtmlPlanJson } from "../artifactPlanJson";
import { normalizePresentationPlan } from "../artifactPlanNormalize";
import { fitArtifactPlanPrompt } from "../artifactContextBudget";
import {
  buildSpreadsheetDataContext,
  buildSpreadsheetFallbackPlan,
  buildSpreadsheetSystemPrompt,
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
  buildHtmlArtifactSystemPrompt,
  defaultThemeForArchetype,
  htmlPlanRequest,
  inferHtmlPageStructure,
  mapHtmlRendererTheme,
} from "../htmlArtifactPrompt";
import {
  webArtifactGroundingPreamble,
  webContextCharLimit,
  webSearchOptionsForArtifact,
} from "../webSearchQuery";
import { formulateArtifactWebQueries, mergeWebSearchResults } from "./webSearchToolLoop";
import {
  extractAmbientSearchQuery,
  selectAmbientResultsForInjection,
  shouldRunAmbientFileSearch,
} from "../ambientSearch";
import {
  formatAmbientFileSection,
  loadAmbientFileBody,
  MAX_ARTIFACT_SOURCE_CHARS,
} from "../ambientFileContent";
import { DISCOVERY_NOTICE_PREFIX } from "../contextCompaction";
import { extractSlideCount, inferPresentationTheme } from "./presentationTheme";
import { repairNestedKeys } from "./repairNestedKeys";
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
  ctx.updateSession(sid, (prev) => ({
    loading: true,
    artifactStage: "IntentLocked",
    artifactPath: null,
    messages: [
      ...prev.messages,
      {
        role: "assistant",
        content: `Generating artifact for: "${text}"`,
        artifactStage: "IntentLocked",
        artifactPath: null,
      }
    ]
  }));

  const updateArtifactMsg = (stage: PipelineStageKind, path: string | null = null, contentOverride?: string) => {
    ctx.updateSession(sid, (prev) => {
      const updated = [...prev.messages];
      const idx = updated.map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === "assistant" && m.artifactStage !== undefined)?.i;
      if (idx !== undefined && updated[idx]) {
        updated[idx] = {
          ...updated[idx],
          artifactStage: stage,
          ...(path !== null ? { artifactPath: path } : {}),
          ...(contentOverride !== undefined ? { content: contentOverride } : {}),
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
    const grammar = await Api.getSchemaGrammar(schemaId);

    let headers: string[] | undefined;
    let rows: string[][] | undefined;
    let spreadsheetData: SpreadsheetData | null = null;
    let ambientFileContent = "";

    let attachedFile = ctx.directDocumentPaths.length > 0 ? ctx.directDocumentPaths[0] : null;

    const wantsAmbientFileSearch = shouldRunAmbientFileSearch(text, {
      forceFileSearch: options?.forceFileSearch,
    });

    // Proactive ambient FTS5 search if no file is attached but query references a file
    if (!attachedFile && wantsAmbientFileSearch) {
      updateArtifactMsg("SearchingDisk");
      const searchQuery = extractAmbientSearchQuery(text);
      try {
        const results = await Api.searchAmbientFiles(searchQuery);
        const top = selectAmbientResultsForInjection(results ?? []);
        if (top.length > 0) {
          const best = top[0];
          attachedFile = best.path;
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
      } catch (err) {
        console.warn("Ambient search failed:", err);
      }
    }

    if (attachedFile) {
      updateArtifactMsg("SearchingDisk");
      const isSpreadsheet =
        attachedFile.endsWith(".csv") ||
        attachedFile.endsWith(".tsv") ||
        attachedFile.endsWith(".xlsx") ||
        attachedFile.endsWith(".xls") ||
        attachedFile.endsWith(".ods");

      if (isSpreadsheet) {
        try {
          const parsed = await Api.parseSpreadsheetData(attachedFile);
          const sheet = spreadsheetFromParsed(parsed.rows);
          if (sheet) {
            headers = sheet.headers;
            rows = sheet.rows;
            spreadsheetData = sheet;
          }
        } catch (err) {
          console.warn("Failed to parse spreadsheet file:", err);
        }
        if (!spreadsheetData) {
          try {
            const cached = await Api.getAmbientFileContent(attachedFile);
            if (cached) {
              ambientFileContent = formatAmbientFileSection(attachedFile, cached);
            }
          } catch (err) {
            console.warn("Failed to query Excel metadata cache:", err);
          }
        }
      } else {
        // Documents (PDF, DOCX, resume, etc.): cache first, then on-demand parse.
        const contentLimit =
          schemaId === "spreadsheet_synthesis"
            ? 20480
            : MAX_ARTIFACT_SOURCE_CHARS;
        const body = await loadAmbientFileBody(attachedFile, contentLimit);
        ambientFileContent = formatAmbientFileSection(attachedFile, body);
      }
    }

    // Ensure document text is loaded for PDF/DOC paths (index cache or search snippet may be incomplete).
    if (
      attachedFile &&
      !headers?.length &&
      !ambientFileContent &&
      /\.(pdf|docx|pptx|doc|ppt)$/i.test(attachedFile)
    ) {
      try {
        const fileContent = await Api.readFileText(attachedFile);
        const contentLimit =
          schemaId === "spreadsheet_synthesis" ? 20480 : 10240;
        ambientFileContent = fileContent.substring(0, contentLimit);
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
        const queries = await formulateArtifactWebQueries(text, {
          modelId: ctx.selectedModel || undefined,
          maxQueries: 3,
        });
        let merged = null as import("../../types").WebSearchResult | null;
        // Cap total hits across queries so context stays within budget.
        const perQuery = Math.max(1, Math.ceil(maxResults / Math.max(queries.length, 1)));
        for (const searchQuery of queries) {
          if (!searchQuery.trim()) continue;
          try {
            const result = await Api.webSearch(searchQuery, perQuery, fetchContent);
            merged = mergeWebSearchResults(merged, result);
          } catch (err) {
            console.warn("Web search query failed:", searchQuery, err);
          }
        }
        if (merged) {
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
            supplementalContext +=
              webArtifactGroundingPreamble() + `${trimmedWeb}\n\n`;
          }
          webHitsForImages = merged.results ?? [];
        }
      } catch (err) {
        console.warn("Web grounding for artifact generation failed:", err);
      }
    }

    // When web grounding is active, cap document text so prompts fit 4k models.
    if (webActive && ambientFileContent) {
      const docCap = contextWindowTokens <= 4096 ? 3000 : 8000;
      ambientFileContent = ambientFileContent.substring(0, docCap);
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
    const slideCountInstruction = slidePlan.explicit
      ? `Produce EXACTLY ${slidePlan.count} slides, as the user explicitly requested.`
      : `Produce a complete multi-slide deck of about ${slidePlan.count} slides (add or remove a few only if the topic clearly needs it).`;
    const themeHint = inferPresentationTheme(text);
    const htmlThemeHint = inferHtmlTheme(text);
    const htmlArchetype =
      schemaId === "html_synthesis" ? inferHtmlPageStructure(text) : "landing";
    const htmlHasSourceData =
      schemaId === "html_synthesis" && spreadsheetData !== null;

    const systemPrompt =
      schemaId === "html_synthesis"
        ? buildHtmlArtifactSystemPrompt(htmlArchetype, {
            hasSourceData: htmlHasSourceData,
            hasImages: imagePool.length > 0,
          })
        : schemaId === "spreadsheet_synthesis"
        ? buildSpreadsheetSystemPrompt(hasSourceData, rowPlan.count)
        : `You generate ONLY a JSON presentation plan. No markdown, no code fences, no commentary.

Schema:
{"slides":[{"title":"string","layout":"TITLE"|"SECTION"|"BULLET"|"TWO_COLUMN"|"IMAGE_LEFT"|"STAT"|"QUOTE"|"CARDS"|"COMPARISON"|"CENTERED","bullets":["string"],"notes":"string","left_title":"string","right_title":"string"}],"theme":"midnight"|"corporate"|"sunset"|"minimal"|"academic"|"cyber"|"ocean"|"forest"|"lavender"|"neon"|"rose"|"slate"}

Layouts (pick to fit content):
- TITLE: cover. bullets = subtitle + 1–2 concrete taglines.
- SECTION: section divider with 1–3 real intro lines.
- BULLET: 4–6 bullets, each 15–40 words with a claim + brief explanation or example.
- TWO_COLUMN / IMAGE_LEFT: 4–6 concrete points.
- STAT: bullets[0] = headline metric/fact; then 2–3 supporting specifics.
- QUOTE: takeaway + attribution/context.
- CARDS: 3–4 items as "Label: 1–2 sentence specifics".
- COMPARISON: 3–5 points per side; left_title/right_title must be real domain terms (e.g. Classical vs Quantum), never "Primary approach".
- CENTERED: 2–4 short paragraphs of real takeaways.

Content rules:
- ${slideCountInstruction}
- First slide TITLE; last slide CENTERED with a concrete takeaway about THIS topic.
- Slide 1–2 must DEFINE the topic (what it is / how it works). Later slides need named examples (algorithms, products, people, events, case studies — whatever fits).
- Every bullet must be specifically about the user's topic. No vague fluff ("transformative potential", "continuous innovation") unless tied to a fact.
- Use ≥4 different layouts. Avoid Q&A / References / Final Thoughts unless asked.
- Theme must match the topic.${sourceDocumentRules}`;

    const themeSuffix = ` Theme: "${themeHint}".`;
    const rowCountSuffix =
      schemaId === "spreadsheet_synthesis" &&
      rowPlan.explicit &&
      rowPlan.count
        ? ` WRITE_DATA must contain EXACTLY ${rowPlan.count} data rows (not counting headers).`
        : "";
    const planRequest =
      schemaId === "presentation_synthesis"
        ? hasSourceDocument
          ? `Using the ATTACHED SOURCE DOCUMENT, create a ${slidePlan.count}-slide deck. User request: "${text}". Use only real details from the source — no placeholders.${themeSuffix}`
          : `Create a ${slidePlan.count}-slide deck about: "${text}".` +
            ` Define the topic early; include concrete examples and named concepts on later slides.` +
            ` Do not repeat the topic phrase as filler.${themeSuffix}`
        : schemaId === "html_synthesis"
        ? htmlPlanRequest(text, htmlArchetype, { hasSourceData: htmlHasSourceData })
        : `Generate a plan for the user request: "${text}".${rowCountSuffix}`;
    const spreadsheetContext =
      schemaId === "html_synthesis" && spreadsheetData
        ? buildHtmlDataContext(spreadsheetData)
        : "";
    const dataContextBody = `${dataContext}${spreadsheetContext}${imageCatalog}`;
    const planRequestText = planRequest;

    // Presentations need far more output room than a single artifact plan: budget
    // roughly per-slide so larger decks aren't truncated mid-array.
    const desiredPlanMaxTokens =
      schemaId === "presentation_synthesis"
        ? Math.min(
            8192,
            900 + slidePlan.count * 420 + (hasSourceDocument ? 1400 : 0)
          )
        : schemaId === "html_synthesis"
        ? HTML_PLAN_MAX_TOKENS
        : schemaId === "spreadsheet_synthesis"
        ? spreadsheetPlanMaxTokens(hasSourceData, ambientFileContent, rowPlan.count)
        : 500;

    const fitted = fitArtifactPlanPrompt({
      contextWindowTokens,
      systemPrompt,
      dataContext: dataContextBody,
      planRequest: planRequestText,
      desiredMaxOutputTokens: desiredPlanMaxTokens,
    });

    const planMaxTokens = fitted.maxOutputTokens;
    const planTemperature =
      schemaId === "html_synthesis"
        ? 0.4
        : schemaId === "presentation_synthesis"
          ? 0.35
          : 0.1;

    let planJson = "";
    const generationOptions = ctx.getChatGenerationOptions(ctx.selectedModel);

    await Api.streamChat(
      [
        { role: "system", content: fitted.systemPrompt },
        { role: "user", content: fitted.userPrompt }
      ],
      (chunk) => {
        planJson += chunk;
      },
      () => {},
      async () => {
        updateArtifactMsg("WritingCode");
        try {
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
              console.warn("Failed to parse artifact plan JSON:", jsonErr);
              throw jsonErr;
            }
          }

          planObj = repairNestedKeys(planObj);

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

          // The theme is decided directly from the prompt and is authoritative:
          // the same prompt always yields the same theme, chosen among all 12.
          if (schemaId === "presentation_synthesis") {
            planObj.theme = themeHint;
            planObj = normalizePresentationPlan(planObj, text, {
              targetSlideCount: slidePlan.count,
            });
            // Name the deck file after its title slide (falls back to the first
            // slide's title) instead of the generic "nela_presentation".
            if (!planObj.output_name) {
              const slides = Array.isArray(planObj.slides) ? planObj.slides : [];
              const titleSlide =
                slides.find((s: { layout?: string; title?: string }) => s?.layout === "TITLE") ??
                slides[0];
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

          ctx.updateSession(sid, {
            loading: false,
          });

          const filename = result.path.split(/[/\\]/).pop();
          updateArtifactMsg("LivePreview", result.path, `Generated artifact successfully: **${filename}**\nPath: \`${result.path}\``);

        } catch (execErr: unknown) {
          console.error("Artifact generation execution failed:", execErr);
          ctx.updateSession(sid, {
            loading: false,
          });
          const msg = execErr instanceof Error ? execErr.message : String(execErr);
          updateArtifactMsg("Error", null, `Failed to compile/execute artifact plan: ${msg}`);
        }
      },
      (err) => {
        console.error("Artifact plan generation failed:", err);
        ctx.updateSession(sid, {
          loading: false,
        });
        updateArtifactMsg("Error", null, `Failed to generate artifact plan: ${err}`);
      },
      undefined,
      ctx.selectedModel || undefined,
      ctrl.signal,
      true,
      {
        ...generationOptions,
        maxTokens: planMaxTokens,
        temperature: planTemperature,
        grammar,
      }
    );

  } catch (err: unknown) {
    console.error("Artifact setup failed:", err);
    ctx.updateSession(sid, {
      loading: false,
    });
    const msg = err instanceof Error ? err.message : String(err);
    updateArtifactMsg("Error", null, `Failed to initialize artifact creation: ${msg}`);
  }
}