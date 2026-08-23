import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { Copy, Download, BarChart3 } from "lucide-react";
import "./ChartViewer.css";

export interface ChartViewerProps {
  /** Apache ECharts option object */
  option: Record<string, unknown>;
  title?: string;
  /** Default: '400px' */
  height?: string;
  theme?: "light" | "dark";
}

type BoundaryState = { error: string | null };

class ChartErrorBoundary extends Component<
  { children: ReactNode; title?: string },
  BoundaryState
> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error: error?.message || "Invalid chart configuration" };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("[ChartViewer] render failed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="chart-viewer chart-viewer--error" role="alert">
          <div className="chart-viewer__fallback">
            <BarChart3 size={20} strokeWidth={2} aria-hidden />
            <div>
              <div className="chart-viewer__fallback-title">
                {this.props.title
                  ? `Couldn’t render “${this.props.title}”`
                  : "Couldn’t render this chart"}
              </div>
              <div className="chart-viewer__fallback-body">
                The chart config looks invalid. Ask NELA to regenerate it, or
                copy the JSON and fix the ECharts option.
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function resolveTheme(explicit?: "light" | "dark"): "light" | "dark" {
  if (explicit) return explicit;
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" ? "light" : "dark";
}

function sanitizeOption(option: Record<string, unknown>): EChartsOption {
  const next: Record<string, unknown> = { ...option };
  if (!next.grid) {
    next.grid = { containLabel: true, left: "3%", right: "4%", bottom: "3%" };
  } else if (
    typeof next.grid === "object" &&
    next.grid !== null &&
    !Array.isArray(next.grid)
  ) {
    next.grid = {
      containLabel: true,
      ...(next.grid as Record<string, unknown>),
    };
  }
  if (next.tooltip === undefined) {
    next.tooltip = { trigger: "item" };
  }
  return next as EChartsOption;
}

const ChartInner: React.FC<ChartViewerProps> = ({
  option,
  title,
  height = "400px",
  theme,
}) => {
  const chartRef = React.useRef<ReactECharts>(null);
  const [copied, setCopied] = React.useState(false);
  const resolvedTheme = resolveTheme(theme);
  const safeOption = React.useMemo(() => sanitizeOption(option), [option]);

  const downloadImage = () => {
    const instance = chartRef.current?.getEchartsInstance();
    if (!instance) return;
    const url = instance.getDataURL({
      type: "png",
      pixelRatio: 2,
      backgroundColor: resolvedTheme === "light" ? "#ffffff" : "#0a0a10",
    });
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(title || "chart").replace(/[^\w-]+/g, "_").slice(0, 60)}.png`;
    a.click();
  };

  const copyJson = async () => {
    const payload = JSON.stringify(
      { type: "chart", title: title || undefined, option },
      null,
      2
    );
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = payload;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className={`chart-viewer chart-viewer--${resolvedTheme}`}
      data-chart-theme={resolvedTheme}
    >
      <div className="chart-viewer__header">
        <div className="chart-viewer__title">
          <BarChart3 size={14} strokeWidth={2} aria-hidden />
          <span>{title?.trim() || "Chart"}</span>
        </div>
        <div className="chart-viewer__actions">
          <button
            type="button"
            className="chart-viewer__btn"
            onClick={() => void copyJson()}
            title="Copy JSON config"
          >
            <Copy size={12} strokeWidth={2} aria-hidden />
            {copied ? "Copied" : "Copy JSON"}
          </button>
          <button
            type="button"
            className="chart-viewer__btn"
            onClick={downloadImage}
            title="Download chart as PNG"
          >
            <Download size={12} strokeWidth={2} aria-hidden />
            Download Image
          </button>
        </div>
      </div>
      <div className="chart-viewer__body" style={{ height }}>
        <ReactECharts
          ref={chartRef}
          option={safeOption}
          theme={resolvedTheme === "dark" ? "dark" : undefined}
          opts={{ renderer: "svg" }}
          style={{ height: "100%", width: "100%" }}
          notMerge
          lazyUpdate
          autoResize
        />
      </div>
    </div>
  );
};

/**
 * Reusable ECharts viewer for chat / artifact surfaces.
 * Invalid LLM-generated options fail inside an ErrorBoundary.
 */
export const ChartViewer: React.FC<ChartViewerProps> = (props) => (
  <ChartErrorBoundary title={props.title}>
    <ChartInner {...props} />
  </ChartErrorBoundary>
);

export default ChartViewer;
