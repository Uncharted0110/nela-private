/**
 * Fill ArtifactChartPool from file-backed aggregation (Rust), not LLM-invented numbers.
 */

import { Api } from "../api";
import { ArtifactChartPool, type ChartPoolEntry } from "./artifactChartPool";
import {
  suggestChartBindings,
  type SheetProfile,
  type SpreadsheetData,
} from "./htmlChartData";

export async function buildFileBackedChartPool(opts: {
  data: SpreadsheetData;
  profile: SheetProfile;
  prompt: string;
  theme?: string;
}): Promise<ChartPoolEntry[]> {
  const bindings = suggestChartBindings(opts.profile, opts.prompt);
  if (!bindings.length) return [];

  const pool = new ArtifactChartPool(4);
  for (const binding of bindings) {
    try {
      const points = await Api.aggregateSpreadsheetChart({
        headers: opts.data.headers,
        rows: opts.data.rows,
        labelColumn: binding.label_column,
        valueColumn: binding.value_column ?? null,
        aggregation: binding.aggregation,
        maxPoints: binding.max_points ?? 48,
      });
      if (!points.length) continue;
      const rendered = pool.render({
        chart_type: binding.chart_type,
        title: binding.title,
        labels: points.map((p) => p.label),
        values: points.map((p) => p.value),
        theme: opts.theme ?? "aurora",
      });
      if (!rendered.ok) break;
    } catch (err) {
      console.warn("File-backed chart aggregate failed:", err);
    }
  }
  return pool.list();
}
