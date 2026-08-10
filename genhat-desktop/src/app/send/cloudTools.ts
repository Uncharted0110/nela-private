/**
 * OpenAI-compatible tool definitions for NELA Cloud.
 * Desktop is the tool host — the API only forwards these to OpenRouter.
 */

import type { CloudToolDefinition } from "../../types";

export const WEB_SEARCH_TOOL: CloudToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live public web (Tavily). Call this ONLY when you need current or external facts (news, prices, sports, flights, docs, travel). " +
      "Do not call it for the user's local files — use search_knowledge_base instead. " +
      "Pass a short keyword query (never the full user prompt) and a depth that matches how thorough the answer needs to be. " +
      "Follow-ups must stay on the prior topic (include place/product/entity from earlier turns).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Concise search query (keywords, not a full sentence)",
        },
        depth: {
          type: "string",
          enum: ["snippet", "full", "standard", "deep"],
          description:
            "snippet = quick factual lookup (titles/snippets); " +
            "full = single search with fuller page content; " +
            "standard = multi-facet research gather for composite questions; " +
            "deep = broader multi-facet research for exhaustive answers",
        },
      },
      required: ["query", "depth"],
    },
  },
};

export const WEB_EXTRACT_TOOL: CloudToolDefinition = {
  type: "function",
  function: {
    name: "web_extract",
    description:
      "Read the full content of specific web pages (Tavily Extract). Use AFTER web_search when a result looks promising but its excerpt is not enough — pass the exact URLs you want to read in depth. " +
      "Up to 5 URLs per call. Use depth 'advanced' when the page likely contains data tables or embedded content you need.",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "Up to 5 http(s) URLs to read in full",
        },
        query: {
          type: "string",
          description:
            "Optional: what you are looking for — extracted content is reranked against this",
        },
        depth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "advanced = retrieves tables and embedded content",
        },
      },
      required: ["urls"],
    },
  },
};

/** Local Doc Graph / knowledge-base search (structural + hybrid BM25/vector). */
export const SEARCH_KNOWLEDGE_BASE_TOOL: CloudToolDefinition = {
  type: "function",
  function: {
    name: "search_knowledge_base",
    description:
      "Searches the user's indexed local document graph (doc_graph) for relevant slides, sections, spreadsheets, notes, and files. " +
      "Uses hybrid BM25 + dense vector embeddings over a structural knowledge graph, then expands hits into Markdown chunk windows with source file paths. " +
      "Prefer a higher top_k (20–40) so graph/vector retrieval can surface multiple related chunks before expansion — low top_k under-uses the embedding graph. " +
      "Call this for the user's own files, resumes, notes, PDFs, slides, or on-device documents. Do NOT use this for live public-web facts. " +
      "After results, cite matched files with inline [n] markers (clickable in the UI).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search query, keyphrase, or document type (e.g., 'Q3 ARR growth', 'resume', 'system architecture', 'tax statement').",
        },
        top_k: {
          type: "integer",
          description:
            "Candidate hits before graph expansion. Default 25. Prefer 25–40 for synthesis/multi-doc answers (graph + vector embeddings benefit from a wider pool). Use 10–15 only for pinpoint lookups. Max 50.",
          default: 25,
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["query"],
    },
  },
};

/** @deprecated Use SEARCH_KNOWLEDGE_BASE_TOOL */
export const FILE_SEARCH_TOOL = SEARCH_KNOWLEDGE_BASE_TOOL;

/** MCP / native artifact writers exposed as OpenAI tools (executed on desktop). */
export const MCP_SPREADSHEET_TOOL: CloudToolDefinition = {
  type: "function",
  function: {
    name: "generate_spreadsheet",
    description:
      "Create an Excel spreadsheet (.xlsx) on the user's device from a structured plan. Prefer this when the user asks for a spreadsheet, workbook, or tables to edit in Excel.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        sheets: {
          type: "array",
          description: "Sheet definitions with headers and rows",
          items: { type: "object" },
        },
      },
      required: ["sheets"],
      additionalProperties: true,
    },
  },
};

export const MCP_PRESENTATION_TOOL: CloudToolDefinition = {
  type: "function",
  function: {
    name: "generate_presentation",
    description:
      "Create a presentation / slide deck on the user's device. Prefer passing a complete self-contained HTML document in `html` (full creative control over design and dense slide content). " +
      "Alternatively pass structured `slides` for the legacy template renderer. Honor the user's exact topic.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        theme: { type: "string" },
        output_name: { type: "string" },
        html: {
          type: "string",
          description:
            "Full self-contained HTML presentation document (preferred). Includes CSS/JS for slide navigation.",
        },
        slides: {
          type: "array",
          items: { type: "object" },
          description: "Legacy structured slide plan (only if html is omitted)",
        },
      },
      additionalProperties: true,
    },
  },
};

export const MCP_HTML_TOOL: CloudToolDefinition = {
  type: "function",
  function: {
    name: "generate_html",
    description:
      "Create an HTML page or interactive HTML artifact on the user's device from a structured plan.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        theme: { type: "string" },
        pages: {
          type: "array",
          items: { type: "object" },
        },
      },
      additionalProperties: true,
    },
  },
};

/**
 * Host-rendered chart for HTML / PPT artifacts.
 * Pass data only — the desktop builds a reliable ECharts fragment.
 * Embed the returned token (nela-chart:N) in the page; do not invent Chart.js.
 */
export const RENDER_CHART_TOOL: CloudToolDefinition = {
  type: "function",
  function: {
    name: "render_chart",
    description:
      "Generate a reliable interactive ECharts chart on the desktop from structured data. " +
      "Call this for every plot in HTML/PPT dashboards — do NOT write Chart.js, Plotly, or hand-rolled echarts.init. " +
      "Returns a short token like nela-chart:0 to place in your HTML as <div data-nela-chart=\"nela-chart:0\"></div>. " +
      "Use only numbers/categories you already know from the conversation or research.",
    parameters: {
      type: "object",
      properties: {
        chart_type: {
          type: "string",
          enum: ["bar", "pie", "line"],
          description: "bar = comparisons, pie = proportions, line = trends",
        },
        title: {
          type: "string",
          description: "Short chart title",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Category labels (same length as values)",
        },
        values: {
          type: "array",
          items: { type: "number" },
          description: "Numeric series aligned with labels",
        },
        theme: {
          type: "string",
          description: "Optional palette hint (aurora, corporate, midnight, …)",
        },
      },
      required: ["chart_type", "title", "labels", "values"],
    },
  },
};

export const MCP_CLOUD_TOOLS: CloudToolDefinition[] = [
  MCP_SPREADSHEET_TOOL,
  MCP_PRESENTATION_TOOL,
  MCP_HTML_TOOL,
];

export function buildCloudChatTools(options?: {
  webEnabled?: boolean;
  fileSearchEnabled?: boolean;
  mcpEnabled?: boolean;
  /** Host-rendered charts for HTML/PPT (default false). */
  chartEnabled?: boolean;
}): CloudToolDefinition[] {
  const tools: CloudToolDefinition[] = [];
  if (options?.webEnabled) tools.push(WEB_SEARCH_TOOL, WEB_EXTRACT_TOOL);
  if (options?.fileSearchEnabled) tools.push(SEARCH_KNOWLEDGE_BASE_TOOL);
  if (options?.chartEnabled) tools.push(RENDER_CHART_TOOL);
  if (options?.mcpEnabled) tools.push(...MCP_CLOUD_TOOLS);
  return tools;
}

/** @deprecated Prefer buildCloudChatTools — kept for call-site compatibility. */
export function cloudToolsForChat(options?: {
  webEnabled?: boolean;
  mcpEnabled?: boolean;
  fileSearchEnabled?: boolean;
}): CloudToolDefinition[] {
  return buildCloudChatTools({
    webEnabled: Boolean(options?.webEnabled),
    fileSearchEnabled: Boolean(options?.fileSearchEnabled),
    mcpEnabled: options?.mcpEnabled !== false,
  });
}

export function cloudToolsWebOnly(fileSearchEnabled = false): CloudToolDefinition[] {
  return buildCloudChatTools({
    webEnabled: true,
    fileSearchEnabled,
    mcpEnabled: false,
  });
}

export function cloudToolsWebAndMcp(fileSearchEnabled = false): CloudToolDefinition[] {
  return buildCloudChatTools({
    webEnabled: true,
    fileSearchEnabled,
    mcpEnabled: true,
  });
}
