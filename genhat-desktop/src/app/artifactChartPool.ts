/**
 * Host-built ECharts fragments for freeform HTML/PPT artifacts.
 * Parallel to artifactImagePool: LLM places nela-chart:N markers; we inject markup.
 */

export type ChartKind =
  | "bar"
  | "pie"
  | "line"
  | "timeline"
  | "dual_line"
  | "grouped_bar";

export type ChartSeries = { name: string; values: number[] };

export type ChartPoolEntry = {
  index: number;
  token: string;
  title: string;
  chart_type: ChartKind;
  labels: string[];
  values: number[];
  series?: ChartSeries[];
  theme: string;
  option: Record<string, unknown>;
  /** Self-contained mount markup (no CDN / boot — added once at embed time). */
  fragment: string;
};

export type RenderChartInput = {
  chart_type?: string;
  title?: string;
  labels?: unknown;
  values?: unknown;
  series?: ChartSeries[] | unknown;
  theme?: string;
};

const MAX_POINTS = 48;
const MAX_CHARTS = 4;

const ECHARTS_CDN =
  '<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>';

const CHART_BOOT_JS = `(function(){
  function boot(){
    if(typeof echarts==='undefined')return;
    document.querySelectorAll('.echarts-host').forEach(function(el){
      if(el.getAttribute('data-echarts-ready'))return;
      var optEl=document.getElementById(el.id+'-option');
      if(!optEl)return;
      try{
        var option=JSON.parse(optEl.textContent||'{}');
        var chart=echarts.init(el,null,{renderer:'svg'});
        chart.setOption(option);
        el.setAttribute('data-echarts-ready','1');
        window.addEventListener('resize',function(){chart.resize();});
      }catch(err){console.warn('ECharts init failed',el.id,err);}
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);
  else boot();
})();`;

function chartPalette(theme: string): string[] {
  switch (theme) {
    case "sunset":
      return ["#f43f5e", "#fb923c", "#fbbf24", "#f472b6", "#fb7185", "#fdba74"];
    case "minimal":
      return ["#2563eb", "#0ea5e9", "#6366f1", "#14b8a6", "#f59e0b", "#ef4444"];
    case "corporate":
      return ["#2563eb", "#38bdf8", "#60a5fa", "#818cf8", "#22d3ee", "#34d399"];
    case "forest":
      return ["#22c55e", "#a3e635", "#4ade80", "#86efac", "#14b8a6", "#10b981"];
    case "rose":
      return ["#e11d48", "#fbbf24", "#f472b6", "#fb7185", "#f59e0b", "#ec4899"];
    case "cyber":
      return ["#22d3ee", "#10b981", "#34d399", "#06b6d4", "#2dd4bf", "#4ade80"];
    case "ocean":
      return ["#38bdf8", "#0284c7", "#0ea5e9", "#22d3ee", "#60a5fa", "#14b8a6"];
    case "aurora":
      return ["#22d3ee", "#a78bfa", "#34d399", "#818cf8", "#2dd4bf", "#c084fc"];
    default:
      return ["#6366f1", "#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#f472b6"];
  }
}

function parseChartType(raw: string | undefined): ChartKind {
  const t = (raw || "bar").toLowerCase().replace(/-/g, "_");
  if (t === "pie") return "pie";
  if (t === "line") return "line";
  if (t === "timeline") return "timeline";
  if (t === "dual_line" || t === "dualline" || t === "double_line") return "dual_line";
  if (t === "grouped_bar" || t === "grouped") return "grouped_bar";
  return "bar";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "").trim()).filter(Boolean).slice(0, MAX_POINTS);
}

function asNumberArray(value: unknown, len: number): number[] {
  if (!Array.isArray(value)) return [];
  const nums = value
    .map((v) => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      const n = Number(String(v ?? "").replace(/,/g, "").trim());
      return Number.isFinite(n) ? n : NaN;
    })
    .filter((n) => Number.isFinite(n))
    .slice(0, MAX_POINTS);
  if (len > 0 && nums.length > len) return nums.slice(0, len);
  return nums;
}

function normalizeSeries(input: {
  title: string;
  labels: string[];
  values: number[];
  series?: ChartSeries[];
}): ChartSeries[] {
  const n = input.labels.length;
  if (input.series && input.series.length >= 2) {
    return input.series.map((s) => ({
      name: s.name,
      values: s.values.slice(0, n),
    }));
  }
  return [{ name: input.title || "Series", values: input.values.slice(0, n) }];
}

export function buildEchartsOption(input: {
  chart_type: ChartKind;
  title: string;
  labels: string[];
  values: number[];
  theme: string;
  series?: ChartSeries[];
}): Record<string, unknown> {
  const palette = chartPalette(input.theme);
  const seriesIn = normalizeSeries(input);
  const n = Math.min(
    input.labels.length,
    ...seriesIn.map((s) => s.values.length),
    input.values.length || input.labels.length
  );
  const labels = input.labels.slice(0, n);
  const values = (seriesIn[0]?.values ?? input.values).slice(0, n);
  const series = seriesIn.map((s) => ({
    name: s.name,
    values: s.values.slice(0, n),
  }));
  const colors = labels.map((_, i) => palette[i % palette.length]!);
  const title = input.title || "Chart";
  const rotate = labels.length > 8 ? 35 : 0;
  const multi = series.length >= 2;

  if (input.chart_type === "pie") {
    return {
      color: colors,
      tooltip: { trigger: "item" },
      legend: { orient: "horizontal", bottom: 0 },
      series: [
        {
          name: title,
          type: "pie",
          radius: ["36%", "68%"],
          itemStyle: { borderRadius: 6 },
          data: labels.map((name, i) => ({ name, value: values[i]! })),
        },
      ],
    };
  }

  if (
    input.chart_type === "line" ||
    input.chart_type === "timeline" ||
    input.chart_type === "dual_line"
  ) {
    const area = input.chart_type !== "dual_line";
    return {
      color: palette,
      tooltip: { trigger: "axis" },
      grid: {
        containLabel: true,
        left: "3%",
        right: "4%",
        bottom: "10%",
        top: "14%",
      },
      legend: { show: multi, top: 0 },
      xAxis: {
        type: "category",
        data: labels,
        boundaryGap: false,
        axisLabel: { rotate },
      },
      yAxis: { type: "value" },
      series: series.map((s) => ({
        name: s.name,
        type: "line",
        smooth: true,
        areaStyle: area && !multi ? { opacity: 0.12 } : undefined,
        data: s.values,
      })),
    };
  }

  if (input.chart_type === "grouped_bar" && multi) {
    return {
      color: palette,
      tooltip: { trigger: "axis" },
      grid: {
        containLabel: true,
        left: "3%",
        right: "4%",
        bottom: "10%",
        top: "14%",
      },
      legend: { show: true, top: 0 },
      xAxis: { type: "category", data: labels, axisLabel: { rotate } },
      yAxis: { type: "value" },
      series: series.map((s) => ({
        name: s.name,
        type: "bar",
        barMaxWidth: 28,
        itemStyle: { borderRadius: [4, 4, 0, 0] },
        data: s.values,
      })),
    };
  }

  return {
    color: palette,
    tooltip: { trigger: "axis" },
    grid: {
      containLabel: true,
      left: "3%",
      right: "4%",
      bottom: "8%",
      top: "12%",
    },
    legend: { show: false },
    xAxis: { type: "category", data: labels, axisLabel: { rotate } },
    yAxis: { type: "value" },
    series: [
      {
        name: title,
        type: "bar",
        barMaxWidth: 48,
        itemStyle: { borderRadius: [6, 6, 0, 0] },
        data: values.map((v, i) => ({
          value: v,
          itemStyle: { color: colors[i % colors.length] },
        })),
      },
    ],
  };
}

function buildFragment(
  index: number,
  title: string,
  chartType: ChartKind,
  option: Record<string, unknown>
): string {
  const id = `nela-chart-host-${index}`;
  const optionJson = JSON.stringify(option).replace(/</g, "\\u003c");
  const safeTitle = escapeHtml(title);
  return (
    `<figure class="nela-chart-panel echarts-panel" data-chart-id="${id}" data-chart-type="${chartType}" data-nela-chart="nela-chart:${index}" style="margin:1rem 0;padding:1rem;border-radius:16px;border:1px solid rgba(0,0,0,.08);background:rgba(255,255,255,.04)">` +
    (safeTitle
      ? `<figcaption style="margin:0 0 .75rem;font-weight:600">${safeTitle}</figcaption>`
      : "") +
    `<div class="echarts-host" id="${id}" style="width:100%;height:360px;min-height:320px"></div>` +
    `<script type="application/json" class="echarts-option" id="${id}-option">${optionJson}</script>` +
    `</figure>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Mutable pool used during a single artifact / chat turn. */
export class ArtifactChartPool {
  private entries: ChartPoolEntry[] = [];
  readonly maxCharts: number;

  constructor(maxCharts = MAX_CHARTS) {
    this.maxCharts = maxCharts;
  }

  get length(): number {
    return this.entries.length;
  }

  list(): ChartPoolEntry[] {
    return [...this.entries];
  }

  /**
   * Host-side render_chart. Returns compact JSON for the model (no HTML dump).
   */
  render(input: RenderChartInput): { ok: true; index: number; token: string; title: string; chart_type: ChartKind; point_count: number } | { ok: false; error: string } {
    if (this.entries.length >= this.maxCharts) {
      return {
        ok: false,
        error: `Chart limit reached (max ${this.maxCharts}). Embed existing nela-chart:N tokens.`,
      };
    }

    const chart_type = parseChartType(input.chart_type);
    const title = String(input.title ?? "Chart").trim().slice(0, 120) || "Chart";
    const labels = asStringArray(input.labels);
    const seriesIn = Array.isArray(input.series)
      ? input.series
          .map((raw) => {
            const s =
              raw && typeof raw === "object"
                ? (raw as { name?: unknown; values?: unknown })
                : {};
            return {
              name: String(s.name ?? "").trim() || "Series",
              values: asNumberArray(s.values, labels.length),
            };
          })
          .filter((s) => s.values.length > 0)
      : [];
    const values = asNumberArray(
      input.values,
      labels.length
    );
    const primary = seriesIn[0]?.values ?? values;
    const n = Math.min(labels.length, primary.length);
    if (n < 1) {
      return {
        ok: false,
        error: "render_chart requires non-empty labels[] and values[] arrays of matching numbers",
      };
    }

    const theme = String(input.theme ?? "aurora").trim() || "aurora";
    const trimmedLabels = labels.slice(0, n);
    const trimmedValues = primary.slice(0, n);
    const series =
      seriesIn.length >= 2
        ? seriesIn.map((s) => ({
            name: s.name,
            values: s.values.slice(0, n),
          }))
        : undefined;
    const option = buildEchartsOption({
      chart_type,
      title,
      labels: trimmedLabels,
      values: trimmedValues,
      theme,
      series,
    });
    const index = this.entries.length;
    const token = `nela-chart:${index}`;
    const fragment = buildFragment(index, title, chart_type, option);
    this.entries.push({
      index,
      token,
      title,
      chart_type,
      labels: trimmedLabels,
      values: trimmedValues,
      series,
      theme,
      option,
      fragment,
    });

    return {
      ok: true,
      index,
      token,
      title,
      chart_type,
      point_count: n,
    };
  }
}

export function formatChartCatalogForPrompt(pool: ChartPoolEntry[]): string {
  if (!pool.length) return "";
  const lines = pool.map(
    (c) =>
      `[${c.index}] ${c.token} — ${c.title} (${c.chart_type}, ${c.values.length} points)`
  );
  return (
    `AVAILABLE CHARTS — host-rendered ECharts. Place markers in your HTML (do NOT write Chart.js / echarts.init / Plotly):\n` +
    `${lines.join("\n")}\n` +
    `Embed with: <div data-nela-chart="nela-chart:0"></div> (or bare token nela-chart:0).\n` +
    `Use different indices for different plots. The desktop injects the real chart markup on save.\n\n`
  );
}

export function wantsArtifactCharts(text: string, hasSourceData = false): boolean {
  if (hasSourceData) return true;
  return /\b(dashboard|chart|charts|graph|graphs|plot|plots|visuali[sz]e|visuali[sz]ation|stats|statistics|kpi|analytics)\b/i.test(
    text
  );
}

/**
 * Replace nela-chart markers with host fragments; inject CDN + boot once.
 * Strips Chart.js CDNs when we have a pool (avoids double libraries).
 *
 * Matching strategy:
 * 1) Exact token (`nela-chart:N`) on data-nela-chart attributes / bare tokens
 * 2) Remaining empty marker slots filled in document order from unused pool entries
 *    (models often invent indices like :3 when the catalog only has 0..2)
 */
export function embedPoolChartsInHtml(
  html: string,
  pool: ChartPoolEntry[]
): string {
  if (!pool.length || !html.trim()) return html;

  let out = html;
  const usedIndices = new Set<number>();

  const markerAttrRe =
    /<(div|span|section|figure)([^>]*\bdata-nela-chart=["'](nela-chart:\d+)["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  const selfClosingAttrRe =
    /<(div|span|section|figure)([^>]*\bdata-nela-chart=["'](nela-chart:\d+)["'][^>]*)\s*\/>/gi;

  const replaceExact = (token: string, frag: string): boolean => {
    let hit = false;
    const patterns = [
      new RegExp(
        `<(div|span|section|figure)([^>]*\\bdata-nela-chart=["']${escapeRegExp(token)}["'][^>]*)>([\\s\\S]*?)<\\/\\1>`,
        "gi"
      ),
      new RegExp(
        `<(div|span|section|figure)([^>]*\\bdata-nela-chart=["']${escapeRegExp(token)}["'][^>]*)\\s*\\/>`,
        "gi"
      ),
      // Bare token only outside attributes (avoid re-hitting injected fragments).
      new RegExp(`(?<![\\w"'-])${escapeRegExp(token)}(?![\\w"'-])`, "g"),
    ];
    for (const re of patterns) {
      if (!re.test(out)) continue;
      re.lastIndex = 0;
      out = out.replace(re, () => {
        hit = true;
        return frag;
      });
      if (hit) break;
    }
    return hit;
  };

  for (const entry of pool) {
    if (replaceExact(entry.token, entry.fragment)) {
      usedIndices.add(entry.index);
    }
  }

  // Positional fill: leftover empty data-nela-chart nodes ← unused pool entries.
  const unused = pool.filter((e) => !usedIndices.has(e.index));
  if (unused.length) {
    let ui = 0;
    const fillOnce = (match: string, _tag: string, _attrs: string, token: string) => {
      // Skip if this token was already replaced with a real fragment.
      if (/echarts-host|nela-chart-panel/.test(match)) return match;
      const entry = unused[ui++];
      if (!entry) return match;
      usedIndices.add(entry.index);
      return entry.fragment;
    };
    out = out.replace(markerAttrRe, (m, tag, attrs, token) =>
      fillOnce(m, tag, attrs, token)
    );
    out = out.replace(selfClosingAttrRe, (m, tag, attrs, token) =>
      fillOnce(m, tag, attrs, token)
    );
  }

  const used = usedIndices.size > 0;

  // Strip Chart.js when host charts are present.
  out = out.replace(
    /<script[^>]+chart(?:\.umd)?(?:\.min)?\.js[^>]*>\s*<\/script>/gi,
    ""
  );

  if (!used) {
    const block =
      `<section class="nela-host-charts" aria-label="Charts" style="padding:1.5rem 1rem">` +
      pool.map((e) => e.fragment).join("\n") +
      `</section>`;
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, `${block}\n</body>`);
    } else {
      out = `${out}\n${block}`;
    }
  }

  const needsCdn = /echarts-host|nela-chart-panel/.test(out);
  if (needsCdn) {
    if (!/echarts(@|%40|\.min\.js)/i.test(out)) {
      if (/<\/head>/i.test(out)) {
        out = out.replace(/<\/head>/i, `${ECHARTS_CDN}\n</head>`);
      } else if (/<body[\s>]/i.test(out)) {
        out = out.replace(/<body([^>]*)>/i, `<body$1>\n${ECHARTS_CDN}`);
      } else {
        out = `${ECHARTS_CDN}\n${out}`;
      }
    }
    if (!/querySelectorAll\(\s*['"]\.echarts-host['"]\s*\)/.test(out)) {
      const boot = `<script>${CHART_BOOT_JS}</script>`;
      if (/<\/body>/i.test(out)) {
        out = out.replace(/<\/body>/i, `${boot}\n</body>`);
      } else {
        out = `${out}\n${boot}`;
      }
    }
  }

  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}