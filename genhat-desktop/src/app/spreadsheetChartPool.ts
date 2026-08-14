/**
 * Fill ArtifactChartPool from file-backed aggregation (Rust), not LLM-invented numbers.
 */

import { Api } from "../api";
import { ArtifactChartPool, type ChartPoolEntry, type ChartSeries } from "./artifactChartPool";
import {
  suggestChartBindings,
  type ChartBinding,
  type SheetProfile,
  type SpreadsheetData,
} from "./htmlChartData";

async function aggregateOne(
  data: SpreadsheetData,
  binding: ChartBinding,
  valueColumn: string | undefined
): Promise<Array<{ label: string; value: number }>> {
  return Api.aggregateSpreadsheetChart({
    headers: data.headers,
    rows: data.rows,
    labelColumn: binding.label_column,
    valueColumn: valueColumn ?? null,
    aggregation: binding.aggregation,
    maxPoints: binding.max_points ?? 48,
    sort: binding.sort ?? "value",
  });
}

function alignSeries(
  primary: Array<{ label: string; value: number }>,
  others: Array<Array<{ label: string; value: number }>>,
  names: string[]
): { labels: string[]; values: number[]; series: ChartSeries[] } {
  const labels = primary.map((p) => p.label);
  const series: ChartSeries[] = [
    { name: names[0] ?? "Series 1", values: primary.map((p) => p.value) },
  ];
  for (let i = 0; i < others.length; i++) {
    const map = new Map(others[i]!.map((p) => [p.label, p.value]));
    series.push({
      name: names[i + 1] ?? `Series ${i + 2}`,
      values: labels.map((l) => map.get(l) ?? 0),
    });
  }
  return { labels, values: series[0]!.values, series };
}

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
      const cols =
        binding.value_columns?.filter((c) => c.trim()) ??
        (binding.value_column ? [binding.value_column] : []);
      const multi =
        (binding.chart_type === "dual_line" ||
          binding.chart_type === "grouped_bar") &&
        cols.length >= 2;

      let labels: string[] = [];
      let values: number[] = [];
      let series: ChartSeries[] | undefined;

      if (multi) {
        const parts = await Promise.all(
          cols.map((col) => aggregateOne(opts.data, binding, col))
        );
        if (!parts[0]?.length) continue;
        const aligned = alignSeries(parts[0], parts.slice(1), cols);
        labels = aligned.labels;
        values = aligned.values;
        series = aligned.series;
      } else {
        const points = await aggregateOne(opts.data, binding, cols[0]);
        if (!points.length) continue;
        labels = points.map((p) => p.label);
        values = points.map((p) => p.value);
      }

      const rendered = pool.render({
        chart_type: binding.chart_type,
        title: binding.title,
        labels,
        values,
        series,
        theme: opts.theme ?? "aurora",
      });
      if (!rendered.ok) break;
    } catch (err) {
      console.warn("File-backed chart aggregate failed:", err);
    }
  }
  return pool.list();
}
