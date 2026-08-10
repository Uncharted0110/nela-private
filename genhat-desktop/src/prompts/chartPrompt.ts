/**
 * Prompt + schema helpers for LLM-generated Apache ECharts charts.
 *
 * Models should emit a fenced JSON block the UI can detect and render with
 * {@link ChartViewer}. Supported payload shapes:
 *
 * ```json
 * {
 *   "type": "chart",
 *   "title": "Optional title",
 *   "option": { ...ECharts option... }
 * }
 * ```
 *
 * or `"type": "echarts"` with the same structure. The `option` object may also
 * be flattened beside `type` / `title` (series/xAxis/… at the top level).
 */

/** OpenAI-compatible tool schema for requesting a chart config. */
export const GENERATE_CHART_TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "generate_chart",
    description:
      "Produce an Apache ECharts option JSON for a static dataset (line, bar, pie, scatter, radar, gauge, or treemap). " +
      "Return the chart as a JSON object with type 'chart' or 'echarts' plus an ECharts option. " +
      "Do not invent live APIs — use only the numbers/categories supplied in the conversation.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["chart", "echarts"],
          description: "Discriminator so the NELA UI renders an interactive chart",
        },
        title: {
          type: "string",
          description: "Short human-readable chart title",
        },
        chartKind: {
          type: "string",
          enum: ["line", "bar", "pie", "scatter", "radar", "gauge", "treemap"],
          description: "Primary series / chart family",
        },
        option: {
          type: "object",
          description:
            "Valid Apache ECharts option object (title, tooltip, legend, grid, xAxis/yAxis or radar, series, color, …)",
        },
      },
      required: ["type", "option"],
    },
  },
};

/**
 * System / tool instruction telling the model how to emit charts in chat.
 * Safe to append as a dynamic system message (keep identity prompt unchanged).
 */
export const CHART_SYSTEM_INSTRUCTION = `When a chart or dashboard visualization helps answer the user, emit ONE fenced JSON block (language tag json) with this shape:

\`\`\`json
{
  "type": "chart",
  "title": "Short descriptive title",
  "option": { /* Apache ECharts option */ }
}
\`\`\`

Rules:
- "type" must be "chart" or "echarts".
- "option" must be a valid ECharts option for one of: line, bar, pie, scatter, radar, gauge, treemap.
- Always include responsive tooltips (tooltip.trigger = "axis" for cartesian, "item" for pie/radar/treemap/gauge).
- Always set grid: { containLabel: true } for cartesian charts (and sensible left/right/top/bottom margins).
- Include a readable legend when there are multiple series; keep legend text short.
- Use an accessible color palette with sufficient contrast (avoid low-contrast yellow-on-white / gray-on-gray). Prefer a clear categorical palette such as ["#2563eb","#059669","#d97706","#dc2626","#7c3aed","#0891b2","#ca8a04"].
- Prefer static data already present in the conversation — do not invent live endpoints.
- You may briefly explain the chart in prose BEFORE or AFTER the JSON block; do not wrap the JSON in a Sources list.
- Prefer \`\`\`json fences (not \`\`\`echarts) so the block stays valid JSON.`;

/** Compact one-liner for capability lists. */
export const CHART_CAPABILITY_LINE =
  "render interactive Apache ECharts charts (line, bar, pie, scatter, radar, gauge, treemap) from JSON option blocks";

/**
 * Build a user-facing prompt that asks for a chart of a given kind.
 */
export function buildChartRequestPrompt(input: {
  question: string;
  chartKind?:
    | "line"
    | "bar"
    | "pie"
    | "scatter"
    | "radar"
    | "gauge"
    | "treemap";
  dataNotes?: string;
}): string {
  const kind = input.chartKind ?? "bar";
  const notes = input.dataNotes?.trim()
    ? `\n\nData / constraints:\n${input.dataNotes.trim()}`
    : "";
  return (
    `Create an interactive ${kind} chart that answers:\n${input.question.trim()}` +
    notes +
    `\n\nRespond with a single \`\`\`json block using "type":"chart" and a complete ECharts "option" ` +
    `(tooltip, legend when needed, grid.containLabel for cartesian charts, accessible colors).`
  );
}

export type ParsedChartPayload = {
  option: Record<string, unknown>;
  title?: string;
};

/**
 * Detect + parse a chart payload from a JSON string (fenced code body).
 * Returns null when the payload is not a chart / echarts document.
 */
export function tryParseChartPayload(raw: string): ParsedChartPayload | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const obj = data as Record<string, unknown>;
  const type = String(obj.type ?? "")
    .trim()
    .toLowerCase();
  if (type !== "chart" && type !== "echarts") return null;

  let option: Record<string, unknown>;
  if (obj.option && typeof obj.option === "object" && !Array.isArray(obj.option)) {
    option = { ...(obj.option as Record<string, unknown>) };
  } else {
    option = { ...obj };
    delete option.type;
    delete option.title;
    delete option.chartKind;
  }

  if (!Object.keys(option).length) return null;

  const title =
    typeof obj.title === "string" && obj.title.trim()
      ? obj.title.trim()
      : typeof (option.title as { text?: string } | undefined)?.text === "string"
        ? String((option.title as { text: string }).text)
        : undefined;

  return { option, title };
}
