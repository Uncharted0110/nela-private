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
      "Search the live public web (Tavily). Call this for current events, news, prices, sports, flights, travel facts, documentation, or any question that needs up-to-date information. " +
      "Break complex questions into multiple focused queries instead of one long query. Pass short, specific keyword queries — never the full user prompt. " +
      "Follow-ups must stay on the prior topic: include the destination, product, or entity from earlier turns (e.g. after a Spain itinerary, search 'flights Spain 1 week' not just 'flights'). " +
      "Profiles: 'simple' for quick factual lookups (default); 'news' for current events and anything time-sensitive; 'research' for comparisons, summaries, or multi-facet questions (returns full page content). " +
      "Results include titles, URLs, relevant excerpts, relevance scores, and images.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Concise search query (keywords, not a full sentence)",
        },
        profile: {
          type: "string",
          enum: ["simple", "news", "research"],
          description:
            "simple = quick lookup; news = time-sensitive/current events; research = deep content for analysis",
        },
        site: {
          type: "string",
          description:
            "Optional: restrict results to one domain, e.g. 'booking.com' or 'wikipedia.org'",
        },
        time_range: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Optional recency filter (use with news profile)",
        },
      },
      required: ["query"],
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

export const MCP_CLOUD_TOOLS: CloudToolDefinition[] = [
  MCP_SPREADSHEET_TOOL,
  MCP_PRESENTATION_TOOL,
  MCP_HTML_TOOL,
];

export function cloudToolsForChat(options?: {
  webEnabled?: boolean;
  mcpEnabled?: boolean;
}): CloudToolDefinition[] {
  const tools: CloudToolDefinition[] = [];
  if (options?.webEnabled !== false) {
    // caller decides; default include when building web loop
  }
  if (options?.webEnabled) tools.push(WEB_SEARCH_TOOL, WEB_EXTRACT_TOOL);
  if (options?.mcpEnabled !== false) tools.push(...MCP_CLOUD_TOOLS);
  return tools;
}

export function cloudToolsWebOnly(): CloudToolDefinition[] {
  return [WEB_SEARCH_TOOL, WEB_EXTRACT_TOOL];
}

export function cloudToolsWebAndMcp(): CloudToolDefinition[] {
  return [WEB_SEARCH_TOOL, WEB_EXTRACT_TOOL, ...MCP_CLOUD_TOOLS];
}
