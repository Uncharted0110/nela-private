//! Chart data resolution and SVG rendering for dashboard HTML pages.

use std::collections::HashMap;

use crate::grammar::schema::{HtmlPlan, HtmlSection, HtmlSectionItem, HtmlSectionKind};

#[derive(Clone, Debug, serde::Serialize)]
pub struct ChartPoint {
    pub label: String,
    pub value: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChartType {
    Bar,
    Pie,
    Line,
}

impl ChartType {
    fn parse(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "pie" => Self::Pie,
            "line" => Self::Line,
            _ => Self::Bar,
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Aggregation {
    Sum,
    Count,
    Avg,
    Min,
    Max,
}

impl Aggregation {
    fn parse(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "count" => Self::Count,
            "avg" | "average" | "mean" => Self::Avg,
            "min" => Self::Min,
            "max" => Self::Max,
            _ => Self::Sum,
        }
    }

    fn apply(self, values: &[f64]) -> f64 {
        if values.is_empty() {
            return 0.0;
        }
        match self {
            Self::Count => values.len() as f64,
            Self::Sum => values.iter().sum(),
            Self::Avg => values.iter().sum::<f64>() / values.len() as f64,
            Self::Min => values.iter().copied().fold(f64::INFINITY, f64::min),
            Self::Max => values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        }
    }
}

/// Resolve CHART sections from attached tabular data. When source data exists,
/// numeric values are always computed from the file — never from model-provided items.
pub fn resolve_plan_charts(plan: &mut HtmlPlan) {
    let Some(rows) = plan.source_rows.clone() else {
        return;
    };
    let headers = plan
        .headers
        .clone()
        .or_else(|| rows.first().cloned())
        .unwrap_or_default();
    if headers.is_empty() {
        return;
    }

    let data_rows: Vec<Vec<String>> = if plan.headers.is_some() {
        rows
    } else if rows.len() > 1 {
        rows[1..].to_vec()
    } else {
        vec![]
    };

    resolve_stats_from_data(plan, &headers, &data_rows);

    for section in &mut plan.sections {
        if section.kind != HtmlSectionKind::Chart {
            continue;
        }
        let label_col = section.label_column.as_deref().unwrap_or("");
        let value_col = section.value_column.as_deref().unwrap_or("");
        if label_col.is_empty() {
            continue;
        }
        let agg = Aggregation::parse(section.aggregation.as_deref().unwrap_or("sum"));
        let points = if value_col.is_empty() {
            aggregate_count_by_label(&headers, &data_rows, label_col)
        } else {
            aggregate_numeric(&headers, &data_rows, label_col, value_col, agg)
        };
        section.items = points
            .into_iter()
            .map(|p| HtmlSectionItem {
                label: p.label,
                detail: None,
                meta: Some(format_chart_number(p.value)),
            })
            .collect();
    }
}

fn resolve_stats_from_data(plan: &mut HtmlPlan, headers: &[String], rows: &[Vec<String>]) {
    let numeric_cols: Vec<(usize, String)> = headers
        .iter()
        .enumerate()
        .filter_map(|(i, h)| {
            let has_num = rows.iter().any(|r| {
                r.get(i).and_then(|s| parse_number(s)).is_some()
            });
            if has_num {
                Some((i, h.clone()))
            } else {
                None
            }
        })
        .collect();

    for section in &mut plan.sections {
        if section.kind != HtmlSectionKind::Stats {
            continue;
        }
        let mut items = vec![HtmlSectionItem {
            label: format!("{}", rows.len()),
            detail: Some("Data rows".to_string()),
            meta: None,
        }];
        for (i, name) in numeric_cols.iter().take(3) {
            let vals: Vec<f64> = rows
                .iter()
                .filter_map(|r| r.get(*i).and_then(|s| parse_number(s)))
                .collect();
            if vals.is_empty() {
                continue;
            }
            let total = vals.iter().sum::<f64>();
            items.push(HtmlSectionItem {
                label: format_chart_number(total),
                detail: Some(format!("Total {name}")),
                meta: None,
            });
        }
        section.items = items;
    }
}

fn column_index(headers: &[String], name: &str) -> Option<usize> {
    let target = name.trim().to_lowercase();
    headers
        .iter()
        .position(|h| h.trim().to_lowercase() == target)
}

fn parse_number(s: &str) -> Option<f64> {
    let cleaned = s.trim().replace(',', "");
    cleaned.parse::<f64>().ok()
}

fn aggregate_numeric(
    headers: &[String],
    rows: &[Vec<String>],
    label_col: &str,
    value_col: &str,
    agg: Aggregation,
) -> Vec<ChartPoint> {
    let li = match column_index(headers, label_col) {
        Some(i) => i,
        None => return vec![],
    };
    let vi = match column_index(headers, value_col) {
        Some(i) => i,
        None => return vec![],
    };

    let mut buckets: HashMap<String, Vec<f64>> = HashMap::new();
    for row in rows {
        let label = row.get(li).cloned().unwrap_or_default();
        if label.trim().is_empty() {
            continue;
        }
        let val = row
            .get(vi)
            .and_then(|s| parse_number(s))
            .unwrap_or(0.0);
        buckets.entry(label).or_default().push(val);
    }

    let mut points: Vec<ChartPoint> = buckets
        .into_iter()
        .map(|(label, vals)| ChartPoint {
            label,
            value: agg.apply(&vals),
        })
        .collect();
    points.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));
    points
}

fn aggregate_count_by_label(
    headers: &[String],
    rows: &[Vec<String>],
    label_col: &str,
) -> Vec<ChartPoint> {
    let li = match column_index(headers, label_col) {
        Some(i) => i,
        None => return vec![],
    };
    let mut counts: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let label = row.get(li).cloned().unwrap_or_default();
        if label.trim().is_empty() {
            continue;
        }
        *counts.entry(label).or_default() += 1;
    }
    let mut points: Vec<ChartPoint> = counts
        .into_iter()
        .map(|(label, n)| ChartPoint {
            label,
            value: n as f64,
        })
        .collect();
    points.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));
    points
}

fn format_chart_number(v: f64) -> String {
    if (v.fract()).abs() < f64::EPSILON {
        format!("{:.0}", v)
    } else {
        format!("{:.2}", v)
    }
}

pub fn chart_points(section: &HtmlSection) -> Vec<ChartPoint> {
    section
        .items
        .iter()
        .filter_map(|it| {
            let value = it
                .meta
                .as_deref()
                .and_then(parse_number)
                .or_else(|| it.detail.as_deref().and_then(parse_number))?;
            Some(ChartPoint {
                label: it.label.clone(),
                value,
            })
        })
        .collect()
}

pub fn render_chart_section(
    section: &HtmlSection,
    index: usize,
    theme: &str,
) -> String {
    let chart_type = ChartType::parse(section.chart_type.as_deref().unwrap_or("bar"));
    let points = chart_points(section);
    let id = format!("chart-{index}");
    let title = super::render::escape_html(&section.title);
    let subtitle = section
        .subtitle
        .as_deref()
        .map(|s| format!(r#"<p class="section-sub">{}</p>"#, super::render::escape_html(s)))
        .unwrap_or_default();

    if points.is_empty() {
        return format!(
            r#"<section class="section chart-section" id="sec-{index}">
  <div class="container">
    <h2 class="section-title">{title}</h2>
    {subtitle}
    <div class="chart-panel chart-empty"><p class="muted">No chart data available.</p></div>
  </div>
</section>"#
        );
    }

    let series_json = serde_json::to_string(&points)
        .unwrap_or_else(|_| "[]".to_string())
        .replace('<', "\\u003c");
    let palette = chart_palette(theme);
    let svg = match chart_type {
        ChartType::Bar => render_bar_svg(&id, &points, &palette),
        ChartType::Pie => render_pie_svg(&id, &points, &palette),
        ChartType::Line => render_line_svg(&id, &points, &palette),
    };

    let legend = render_legend(&id, &points, &palette);
    let type_name = match chart_type {
        ChartType::Bar => "bar",
        ChartType::Pie => "pie",
        ChartType::Line => "line",
    };

    format!(
        r#"<section class="section chart-section" id="sec-{index}">
  <div class="container">
    <h2 class="section-title">{title}</h2>
    {subtitle}
    <div class="chart-panel" data-chart-id="{id}" data-chart-type="{type_name}" data-series='{series_json}'>
      <div class="chart-svg-wrap">{svg}</div>
      {legend}
      <div class="chart-tooltip" id="{id}-tooltip" role="tooltip" hidden></div>
    </div>
  </div>
</section>"#
    )
}

fn chart_palette(theme: &str) -> Vec<&'static str> {
    match theme {
        "sunset" => vec!["#f43f5e", "#fb923c", "#fbbf24", "#f472b6", "#fb7185", "#fdba74"],
        "minimal" => vec!["#2563eb", "#0ea5e9", "#6366f1", "#14b8a6", "#f59e0b", "#ef4444"],
        "corporate" => vec!["#2563eb", "#38bdf8", "#60a5fa", "#818cf8", "#22d3ee", "#34d399"],
        "forest" => vec!["#22c55e", "#a3e635", "#4ade80", "#86efac", "#14b8a6", "#10b981"],
        "rose" => vec!["#e11d48", "#fbbf24", "#f472b6", "#fb7185", "#f59e0b", "#ec4899"],
        "cyber" => vec!["#22d3ee", "#10b981", "#34d399", "#06b6d4", "#2dd4bf", "#4ade80"],
        "ocean" => vec!["#38bdf8", "#0284c7", "#0ea5e9", "#22d3ee", "#60a5fa", "#14b8a6"],
        "academic" => vec!["#991b1b", "#b45309", "#1d4ed8", "#15803d", "#7c2d12", "#4338ca"],
        "lavender" => vec!["#a78bfa", "#c084fc", "#e879f9", "#818cf8", "#f472b6", "#38bdf8"],
        "neon" => vec!["#f0abfc", "#22d3ee", "#a3e635", "#facc15", "#fb7185", "#34d399"],
        "slate" => vec!["#94a3b8", "#64748b", "#475569", "#cbd5e1", "#78716c", "#a8a29e"],
        "aurora" => vec!["#22d3ee", "#a78bfa", "#34d399", "#818cf8", "#2dd4bf", "#c084fc"],
        "paper" => vec!["#1c1917", "#b45309", "#1d4ed8", "#15803d", "#7c2d12", "#57534e"],
        _ => vec!["#6366f1", "#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#f472b6"],
    }
}

fn render_bar_svg(id: &str, points: &[ChartPoint], palette: &[&str]) -> String {
    let w = 640.0;
    let h = 320.0;
    let pad_l = 48.0;
    let pad_b = 40.0;
    let pad_t = 16.0;
    let pad_r = 16.0;
    let chart_w = w - pad_l - pad_r;
    let chart_h = h - pad_b - pad_t;
    let max_val = points
        .iter()
        .map(|p| p.value)
        .fold(0.0_f64, f64::max)
        .max(1.0);
    let bar_gap = 12.0;
    let bar_w = (chart_w - bar_gap * (points.len() as f64 + 1.0)) / points.len().max(1) as f64;

    let mut bars = String::new();
    for (i, p) in points.iter().enumerate() {
        let color = palette[i % palette.len()];
        let bh = (p.value / max_val) * chart_h;
        let x = pad_l + bar_gap + i as f64 * (bar_w + bar_gap);
        let y = pad_t + chart_h - bh;
        let label = super::render::escape_html(&p.label);
        let val = format_chart_number(p.value);
        bars.push_str(&format!(
            r#"<rect class="chart-bar" data-label="{label}" data-value="{val}" x="{x:.1}" y="{y:.1}" width="{bar_w:.1}" height="{bh:.1}" fill="{color}" rx="4" />"#,
        ));
        bars.push_str(&format!(
            r#"<text class="chart-axis-label" x="{:.1}" y="{:.0}" text-anchor="middle" fill="currentColor" font-size="11">{label}</text>"#,
            x + bar_w / 2.0,
            h - 12.0,
        ));
    }

    format!(
        r#"<svg class="chart-svg" id="{id}-svg" viewBox="0 0 {:.0} {:.0}" role="img" aria-label="Bar chart">
  <line x1="{pad_l:.0}" y1="{pad_t:.0}" x2="{pad_l:.0}" y2="{:.0}" stroke="currentColor" stroke-opacity="0.2" />
  <line x1="{pad_l:.0}" y1="{:.0}" x2="{:.0}" y2="{:.0}" stroke="currentColor" stroke-opacity="0.2" />
  {bars}
</svg>"#,
        w,
        h,
        pad_t + chart_h,
        pad_t + chart_h,
        w - pad_r,
        pad_t + chart_h,
    )
}

fn render_pie_svg(id: &str, points: &[ChartPoint], palette: &[&str]) -> String {
    let w = 360;
    let h = 360;
    let cx = w as f64 / 2.0;
    let cy = h as f64 / 2.0;
    let r = 140.0;
    let total: f64 = points.iter().map(|p| p.value).sum();
    let total = if total <= 0.0 { 1.0 } else { total };

    let mut slices = String::new();
    let mut start_angle = -std::f64::consts::FRAC_PI_2;

    for (i, p) in points.iter().enumerate() {
        let fraction = p.value / total;
        let sweep = fraction * std::f64::consts::TAU;
        let end_angle = start_angle + sweep;
        let x1 = cx + r * start_angle.cos();
        let y1 = cy + r * start_angle.sin();
        let x2 = cx + r * end_angle.cos();
        let y2 = cy + r * end_angle.sin();
        let large = if sweep > std::f64::consts::PI { 1 } else { 0 };
        let color = palette[i % palette.len()];
        let label = super::render::escape_html(&p.label);
        let val = format_chart_number(p.value);
        slices.push_str(&format!(
            r#"<path class="chart-slice" data-label="{label}" data-value="{val}" fill="{color}" d="M {cx:.1} {cy:.1} L {x1:.1} {y1:.1} A {r} {r} 0 {large} 1 {x2:.1} {y2:.1} Z" />"#,
        ));
        start_angle = end_angle;
    }

    format!(
        r#"<svg class="chart-svg" id="{id}-svg" viewBox="0 0 {w} {h}" role="img" aria-label="Pie chart">{slices}</svg>"#
    )
}

fn render_line_svg(id: &str, points: &[ChartPoint], palette: &[&str]) -> String {
    let w = 640.0;
    let h = 320.0;
    let pad_l = 48.0;
    let pad_b = 40.0;
    let pad_t = 16.0;
    let pad_r = 16.0;
    let chart_w = w - pad_l - pad_r;
    let chart_h = h - pad_b - pad_t;
    let max_val = points
        .iter()
        .map(|p| p.value)
        .fold(0.0_f64, f64::max)
        .max(1.0);
    let n = points.len().max(1);
    let step = chart_w / (n - 1).max(1) as f64;
    let color = palette[0];

    let mut coords = Vec::new();
    let mut dots = String::new();
    for (i, p) in points.iter().enumerate() {
        let x = pad_l + i as f64 * step;
        let y = pad_t + chart_h - (p.value / max_val) * chart_h;
        coords.push(format!("{x:.1},{y:.1}"));
        let label = super::render::escape_html(&p.label);
        let val = format_chart_number(p.value);
        dots.push_str(&format!(
            r#"<circle class="chart-dot" data-label="{label}" data-value="{val}" cx="{x:.1}" cy="{y:.1}" r="5" fill="{color}" />"#,
        ));
    }

    format!(
        r#"<svg class="chart-svg" id="{id}-svg" viewBox="0 0 {:.0} {:.0}" role="img" aria-label="Line chart">
  <polyline class="chart-line" fill="none" stroke="{color}" stroke-width="2.5" points="{}" />
  {dots}
</svg>"#,
        w,
        h,
        coords.join(" ")
    )
}

fn render_legend(id: &str, points: &[ChartPoint], palette: &[&str]) -> String {
    let items: String = points
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let color = palette[i % palette.len()];
            let label = super::render::escape_html(&p.label);
            let val = format_chart_number(p.value);
            format!(
                r#"<button type="button" class="chart-legend-item" data-label="{label}" data-chart="{id}">
      <span class="chart-swatch" style="background:{color}"></span>
      <span class="chart-legend-text">{label}</span>
      <span class="chart-legend-val">{val}</span>
    </button>"#
            )
        })
        .collect::<Vec<_>>()
        .join("\n    ");

    format!(
        r#"<div class="chart-legend" id="{id}-legend">
    <div class="chart-filter-bar">
      <button type="button" class="chart-filter-btn active" data-filter="all" data-chart="{id}">All</button>
      {items}
    </div>
  </div>"#
    )
}

pub const CHART_INTERACTION_JS: &str = r#"
(function() {
  var activeFilters = {};

  function showTooltip(panel, text, x, y) {
    var tip = panel.querySelector('.chart-tooltip');
    if (!tip) return;
    tip.textContent = text;
    tip.hidden = false;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function hideTooltip(panel) {
    var tip = panel.querySelector('.chart-tooltip');
    if (tip) tip.hidden = true;
  }

  function applyFilter(chartId, label) {
    activeFilters[chartId] = label;
    var panel = document.querySelector('[data-chart-id="' + chartId + '"]');
    if (!panel) return;
    var match = label === 'all' ? null : label;
    panel.querySelectorAll('[data-label]').forEach(function(el) {
      if (!el.getAttribute('data-label')) return;
      var on = !match || el.getAttribute('data-label') === match;
      el.style.opacity = on ? '1' : '0.2';
      el.style.pointerEvents = on ? 'auto' : 'none';
    });
    panel.querySelectorAll('.chart-filter-btn, .chart-legend-item').forEach(function(btn) {
      var bl = btn.getAttribute('data-filter') || btn.getAttribute('data-label');
      btn.classList.toggle('active', bl === label || (label === 'all' && bl === 'all'));
    });
  }

  document.querySelectorAll('.chart-panel[data-chart-id]').forEach(function(panel) {
    var chartId = panel.getAttribute('data-chart-id');
    panel.querySelectorAll('.chart-bar, .chart-slice, .chart-dot').forEach(function(el) {
      el.addEventListener('mouseenter', function(e) {
        var lbl = el.getAttribute('data-label') || '';
        var val = el.getAttribute('data-value') || '';
        var rect = panel.getBoundingClientRect();
        showTooltip(panel, lbl + ': ' + val, e.clientX - rect.left + 8, e.clientY - rect.top - 28);
      });
      el.addEventListener('mousemove', function(e) {
        var lbl = el.getAttribute('data-label') || '';
        var val = el.getAttribute('data-value') || '';
        var rect = panel.getBoundingClientRect();
        showTooltip(panel, lbl + ': ' + val, e.clientX - rect.left + 8, e.clientY - rect.top - 28);
      });
      el.addEventListener('mouseleave', function() { hideTooltip(panel); });
      el.addEventListener('click', function() {
        var lbl = el.getAttribute('data-label');
        if (lbl) applyFilter(chartId, lbl);
      });
    });
    panel.querySelectorAll('.chart-filter-btn, .chart-legend-item').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var filter = btn.getAttribute('data-filter') || btn.getAttribute('data-label') || 'all';
        applyFilter(chartId, filter);
      });
    });
  });
})();
"#;

pub const CHART_CSS: &str = r#"
.chart-section .chart-panel {
  position: relative;
  background: var(--surface);
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
  padding: 1.25rem;
  margin-top: .5rem;
}
.chart-svg-wrap { overflow-x: auto; }
.chart-svg { width: 100%; max-width: 640px; height: auto; display: block; color: var(--muted); }
.chart-bar, .chart-slice, .chart-dot { cursor: pointer; transition: opacity .2s ease, transform .15s ease; }
.chart-bar:hover, .chart-slice:hover, .chart-dot:hover { opacity: .85; }
.chart-axis-label { fill: var(--muted); }
.chart-legend { margin-top: 1rem; }
.chart-filter-bar { display: flex; flex-wrap: wrap; gap: .5rem; }
.chart-filter-btn, .chart-legend-item {
  display: inline-flex; align-items: center; gap: .4rem;
  padding: .35rem .65rem; border-radius: 999px; font-size: .82rem;
  border: 1px solid color-mix(in srgb, var(--text) 12%, transparent);
  background: color-mix(in srgb, var(--bg) 60%, var(--surface));
  color: var(--text); cursor: pointer;
}
.chart-filter-btn.active, .chart-legend-item.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 15%, var(--surface));
}
.chart-swatch { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.chart-legend-val { color: var(--muted); margin-left: .25rem; }
.chart-tooltip {
  position: absolute; z-index: 20; pointer-events: none;
  background: var(--surface); color: var(--text);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  padding: .35rem .55rem; border-radius: 8px; font-size: .8rem;
  box-shadow: 0 8px 24px rgba(0,0,0,.25);
  white-space: nowrap;
}
.chart-empty { text-align: center; padding: 2rem; }
.layout-dashboard .chart-section { padding: 1rem 0; }
.layout-dashboard .charts-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem;
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grammar::schema::HtmlPlan;

    #[test]
    fn aggregates_csv_columns() {
        let mut plan = HtmlPlan {
            title: "Sales".into(),
            tagline: None,
            archetype: "dashboard".into(),
            sections: vec![{
                let mut s = HtmlSection::with_kind(HtmlSectionKind::Chart);
                s.title = "By region".into();
                s.chart_type = Some("bar".into());
                s.label_column = Some("region".into());
                s.value_column = Some("revenue".into());
                s.aggregation = Some("sum".into());
                s.items = vec![HtmlSectionItem {
                    label: "fake".into(),
                    detail: None,
                    meta: Some("999".into()),
                }];
                s
            }],
            theme: None,
            output_name: None,
            html: None,
            headers: Some(vec!["region".into(), "revenue".into()]),
            images: None,
            source_rows: Some(vec![
                vec!["North".into(), "100".into()],
                vec!["South".into(), "50".into()],
                vec!["North".into(), "25".into()],
            ]),
        };
        resolve_plan_charts(&mut plan);
        let items = &plan.sections[0].items;
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|i| i.label == "North" && i.meta.as_deref() == Some("125")));
        assert!(items.iter().any(|i| i.label == "South" && i.meta.as_deref() == Some("50")));
    }
}
