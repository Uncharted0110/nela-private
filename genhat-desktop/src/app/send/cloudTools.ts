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
      "Search the live public web. ALWAYS call this for current events, news, prices, sports scores, product details, documentation, or any factual question that benefits from up-to-date information. Do not answer those from memory alone when this tool is available. Pass a short, specific query.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Concise search query (keywords, not a full sentence)",
        },
        depth: {
          type: "string",
          enum: ["snippets", "full"],
          description: "snippets = titles/snippets only; full = fetch page text",
        },
      },
      required: ["query"],
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
  if (options?.webEnabled) tools.push(WEB_SEARCH_TOOL);
  if (options?.mcpEnabled !== false) tools.push(...MCP_CLOUD_TOOLS);
  return tools;
}

export function cloudToolsWebOnly(): CloudToolDefinition[] {
  return [WEB_SEARCH_TOOL];
}

export function cloudToolsWebAndMcp(): CloudToolDefinition[] {
  return [WEB_SEARCH_TOOL, ...MCP_CLOUD_TOOLS];
}
