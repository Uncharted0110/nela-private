import { Api } from "../../api";
import { extractTaskText, parseMindMapGraph } from "../mindmapUtils";
import type { SendHandlerContext } from "./types";

export async function handleSendMindmap(
  text: string,
  ctx: SendHandlerContext
): Promise<void> {
  const sid = ctx.activeSessionId;
  
  try {
    ctx.setActiveMindmapOverlay({
      sessionId: sid,
      mindmapId: null,
      isGenerating: true,
      query: text,
    });
    ctx.setGeneralGenerating(true);
    ctx.setGeneralElapsedTime(0);
    ctx.setGeneralGenerationTime(null);
    const startTime = Date.now();

    if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
    ctx.generalIntervalRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 100) / 10;
      ctx.setGeneralElapsedTime(elapsed);
    }, 500);

    let generatedFrom: "documents" | "model" = "model";
    let sourceCount = 0;
    let sourceContext = "";

    if (ctx.ragDocs.length > 0) {
      try {
        const setup = await Api.queryRagStream(text);
        ctx.updateSession(sid, { ragResult: { answer: "", sources: setup.sources } });
        if (!setup.no_retrieval && setup.sources.length > 0) {
          generatedFrom = "documents";
          sourceCount = setup.sources.length;
          sourceContext = setup.sources
            .map((source, index) => `Source ${index + 1} (${source.doc_title}):\n${source.text}`)
            .join("\n\n");
        }
      } catch (e) {
        console.warn("Mindmap RAG grounding failed; using model knowledge.", e);
      }
    }

    const prompt = generatedFrom === "documents"
      ? [
          `User query: ${text}`,
          "Build a concise mindmap grounded ONLY in the provided sources.",
          "Return ONLY valid JSON and no markdown/code fences.",
          "Schema:",
          '{"title":"string","root":{"label":"string","children":[{"label":"string","children":[...]}]}}',
          "Rules:",
          "- 3 to 6 first-level branches.",
          "- Keep labels short (2 to 8 words).",
          "- Depth max 3.",
          "- Do not invent unsupported facts.",
          "Sources:",
          sourceContext,
        ].join("\n")
      : [
          `User query: ${text}`,
          "Create a concise conceptual mindmap from your own knowledge.",
          "Return ONLY valid JSON and no markdown/code fences.",
          "Schema:",
          '{"title":"string","root":{"label":"string","children":[{"label":"string","children":[...]}]}}',
          "Rules:",
          "- 3 to 6 first-level branches.",
          "- Keep labels short (2 to 8 words).",
          "- Depth max 3.",
        ].join("\n");

    let graph: import("../../types").MindMapGraph | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const raw = await Api.routeRequest("mindmap", prompt, ctx.selectedModel || undefined);
        const modelText = extractTaskText(raw);
        graph = parseMindMapGraph(modelText, text, generatedFrom, sourceCount);
        break;
      } catch (e) {
        console.warn(`Mindmap generation attempt ${attempt} failed:`, e);
        lastError = e;
      }
    }

    if (!graph) {
      throw lastError;
    }

    ctx.setMindmapsBySession((prev) => ({
      ...prev,
      [sid]: [...(prev[sid] ?? []), graph],
    }));

    ctx.setActiveMindmapOverlay({
      sessionId: sid,
      mindmapId: graph.id,
      isGenerating: false,
      query: text,
    });

    if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
    const totalTime = Math.floor((Date.now() - startTime) / 100) / 10;
    ctx.setGeneralGenerating(false);
    ctx.setGeneralElapsedTime(totalTime);
    ctx.setGeneralGenerationTime(totalTime);

    ctx.updateSession(sid, (prev) => ({
      messages: [
        ...prev.messages,
        {
          role: "assistant" as const,
          content:
            generatedFrom === "documents"
              ? `Mindmap generated from ${sourceCount} retrieved document source${sourceCount === 1 ? "" : "s"}.`
              : "Mindmap generated from model knowledge.",
          generateTime: totalTime,
        },
      ],
      streamingContent: "",
      loading: false,
    }));
  } catch (e) {
    ctx.setActiveMindmapOverlay(null);
    if (ctx.generalIntervalRef.current) clearInterval(ctx.generalIntervalRef.current);
    ctx.setGeneralGenerating(false);
    console.error("Mindmap generation failed:", e);
    ctx.updateSession(sid, (prev) => ({
      messages: [
        ...prev.messages,
        {
          role: "assistant" as const,
          content:
            "Mindmap generation failed. The model produced malformed data. Try selecting a larger model or rewording your input.",
        },
      ],
      loading: false,
    }));
  }
}