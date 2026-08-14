//! Chart data resolution and ECharts embedding for dashboard HTML pages.

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

/// Aggregate a chart series from tabular rows (shared by HTML render + cloud pool).
pub fn aggregate_chart(
    headers: &[String],
    rows: &[Vec<String>],
    label_col: &str,
    value_col: Option<&str>,
    aggregation: Option<&str>,
    max_points: usize,
) -> Vec<ChartPoint> {
    let cap = if max_points == 0 { 48 } else { max_points };
    let mut points = match value_col.map(str::trim).filter(|s| !s.is_empty()) {
        Some(value) => {
            let agg = Aggregation::parse(aggregation.unwrap_or("sum"));
            aggregate_numeric(headers, rows, label_col, value, agg)
        }
        None => aggregate_count_by_label(headers, rows, label_col),
    };
    if points.len() > cap {
        points.truncate(cap);
    }
    points
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
        let points = aggregate_chart(
            &headers,
            &data_rows,
            label_col,
            if value_col.is_empty() {
                None
            } else {
                Some(value_col)
            },
            section.aggregation.as_deref(),
            48,
        );
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
    let mut numeric_cols: Vec<(usize, String, bool)> = headers
        .iter()
        .enumerate()
        .filter_map(|(i, h)| {
            if skip_stat_column(h) {
                return None;
            }
            let has_num = rows.iter().any(|r| {
                r.get(i).and_then(|s| parse_number(s)).is_some()
            });
            if has_num {
                Some((i, h.clone(), prefer_stat_column(h)))
            } else {
                None
            }
        })
        .collect();
    numeric_cols.sort_by(|a, b| b.2.cmp(&a.2));

    for section in &mut plan.sections {
        if section.kind != HtmlSectionKind::Stats {
            continue;
        }
        let mut items = vec![HtmlSectionItem {
            label: format!("{}", rows.len()),
            detail: Some(stat_row_label(headers).to_string()),
            meta: None,
        }];
        for (i, name, _) in numeric_cols.iter().take(3) {
            let vals: Vec<f64> = rows
                .iter()
                .filter_map(|r| r.get(*i).and_then(|s| parse_number(s)))
                .collect();
            if vals.is_empty() {
                continue;
            }
            let n = name.to_lowercase();
            let use_avg = n.contains("per unit") || n.contains("unit cost") || n.contains("unit price");
            let value = if use_avg {
                vals.iter().sum::<f64>() / vals.len() as f64
            } else {
                vals.iter().sum::<f64>()
            };
            let prefix = if use_avg { "Avg" } else { "Total" };
            items.push(HtmlSectionItem {
                label: format_chart_number(value),
                detail: Some(format!("{prefix} {name}")),
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
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let negative = t.starts_with('(') && t.ends_with(')');
    let cleaned = t
        .trim_matches(|c: char| c == '(' || c == ')')
        .replace(',', "")
        .replace(['$', '₹', '€', '£', '%', ' '], "");
    let value: f64 = cleaned.parse().ok()?;
    Some(if negative { -value } else { value })
}

fn skip_stat_column(name: &str) -> bool {
    let n = name.to_lowercase();
    n == "id"
        || n.ends_with(" id")
        || n.contains("sku")
        || n.contains("per unit")
        || n.contains("unit cost")
        || n.contains("unit price")
        || n.contains("price per")
        || n.contains("percent")
        || n.contains('%')
        || n.contains(" rate")
        || n.ends_with(" rate")
}

fn prefer_stat_column(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("total")
        || n.contains("value")
        || n.contains("revenue")
        || n.contains("sold")
        || n.contains("stock")
        || n.contains("amount")
        || n.contains("salary")
}

fn stat_row_label(headers: &[String]) -> &'static str {
    let blob = headers.join(" ").to_lowercase();
    if blob.contains("product") || blob.contains("inventory") || blob.contains("sku") {
        "Products"
    } else if blob.contains("order") || blob.contains("invoice") {
        "Orders"
    } else if blob.contains("employee") {
        "Employees"
    } else {
        "Data rows"
    }
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

    let option = echarts_option(chart_type, &points, theme, &section.title);
    let option_json = serde_json::to_string(&option)
        .unwrap_or_else(|_| "{}".to_string())
        .replace('<', "\\u003c");
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
    <div class="chart-panel echarts-panel" data-chart-id="{id}" data-chart-type="{type_name}">
      <div class="echarts-host" id="{id}" style="width:100%;height:360px;"></div>
      <script type="application/json" class="echarts-option" id="{id}-option">{option_json}</script>
    </div>
  </div>
</section>"#
    )
}

fn echarts_option(
    chart_type: ChartType,
    points: &[ChartPoint],
    theme: &str,
    title: &str,
) -> serde_json::Value {
    let palette: Vec<&str> = chart_palette(theme);
    let labels: Vec<&str> = points.iter().map(|p| p.label.as_str()).collect();
    let values: Vec<f64> = points.iter().map(|p| p.value).collect();
    let colors: Vec<&str> = points
        .iter()
        .enumerate()
        .map(|(i, _)| palette[i % palette.len()])
        .collect();

    match chart_type {
        ChartType::Pie => serde_json::json!({
            "color": colors,
            "tooltip": { "trigger": "item" },
            "legend": { "orient": "horizontal", "bottom": 0 },
            "series": [{
                "name": title,
                "type": "pie",
                "radius": ["36%", "68%"],
                "itemStyle": { "borderRadius": 6 },
                "data": points.iter().map(|p| serde_json::json!({
                    "name": p.label,
                    "value": p.value
                })).collect::<Vec<_>>()
            }]
        }),
        ChartType::Line => serde_json::json!({
            "color": palette,
            "tooltip": { "trigger": "axis" },
            "grid": { "containLabel": true, "left": "3%", "right": "4%", "bottom": "8%", "top": "12%" },
            "legend": { "show": false },
            "xAxis": { "type": "category", "data": labels, "boundaryGap": false },
            "yAxis": { "type": "value" },
            "series": [{
                "name": title,
                "type": "line",
                "smooth": true,
                "areaStyle": { "opacity": 0.12 },
                "data": values
            }]
        }),
        ChartType::Bar => serde_json::json!({
            "color": palette,
            "tooltip": { "trigger": "axis" },
            "grid": { "containLabel": true, "left": "3%", "right": "4%", "bottom": "8%", "top": "12%" },
            "legend": { "show": false },
            "xAxis": { "type": "category", "data": labels },
            "yAxis": { "type": "value" },
            "series": [{
                "name": title,
                "type": "bar",
                "barMaxWidth": 48,
                "itemStyle": { "borderRadius": [6, 6, 0, 0] },
                "data": values.iter().enumerate().map(|(i, v)| serde_json::json!({
                    "value": v,
                    "itemStyle": { "color": colors[i % colors.len()] }
                })).collect::<Vec<_>>()
            }]
        }),
    }
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

pub const CHART_INTERACTION_JS: &str = r#"
(function() {
  function boot() {
    if (typeof echarts === 'undefined') return;
    document.querySelectorAll('.echarts-host').forEach(function(el) {
      if (el.getAttribute('data-echarts-ready')) return;
      var optEl = document.getElementById(el.id + '-option');
      if (!optEl) return;
      try {
        var option = JSON.parse(optEl.textContent || '{}');
        var chart = echarts.init(el, null, { renderer: 'svg' });
        chart.setOption(option);
        el.setAttribute('data-echarts-ready', '1');
        window.addEventListener('resize', function() { chart.resize(); });
      } catch (err) {
        console.warn('ECharts init failed', el.id, err);
      }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
"#;

pub const ECHARTS_CDN: &str =
    r#"<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>"#;

pub const CHART_CSS: &str = r#"
.chart-section .chart-panel {
  position: relative;
  background: var(--surface);
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
  padding: 1rem 1rem 0.75rem;
  margin-top: .5rem;
  overflow: hidden;
}
.chart-section .echarts-host {
  min-height: 320px;
  width: 100%;
}
.chart-section .chart-empty {
  padding: 2rem;
  text-align: center;
}
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

    #[test]
    fn aggregate_chart_caps_and_sums() {
        let headers = vec!["region".into(), "revenue".into()];
        let rows = vec![
            vec!["North".into(), "100".into()],
            vec!["South".into(), "50".into()],
            vec!["North".into(), "25".into()],
        ];
        let points = aggregate_chart(&headers, &rows, "region", Some("revenue"), Some("sum"), 48);
        assert_eq!(points.len(), 2);
        assert!((points[0].value - 125.0).abs() < f64::EPSILON);
        assert_eq!(points[0].label, "North");
    }

    #[test]
    fn parses_currency_and_skips_unit_cost_kpis() {
        let points = aggregate_chart(
            &["Product Name".into(), "Cost Price Total".into()],
            &[
                vec!["A".into(), "$1,000".into()],
                vec!["B".into(), "$250".into()],
            ],
            "Product Name",
            Some("Cost Price Total"),
            Some("sum"),
            48,
        );
        assert_eq!(points.len(), 2);
        assert!((points.iter().find(|p| p.label == "A").unwrap().value - 1000.0).abs() < f64::EPSILON);

        let mut plan = HtmlPlan {
            title: "Inventory".into(),
            tagline: None,
            archetype: "dashboard".into(),
            sections: vec![HtmlSection::with_kind(HtmlSectionKind::Stats)],
            theme: None,
            output_name: None,
            html: None,
            headers: Some(vec![
                "Product ID".into(),
                "Product Name".into(),
                "Cost Price Per Unit".into(),
                "Cost Price Total".into(),
                "Number of Units Sold".into(),
            ]),
            images: None,
            source_rows: Some(vec![
                vec!["P1".into(), "Widget".into(), "10".into(), "100".into(), "5".into()],
                vec!["P2".into(), "Gadget".into(), "20".into(), "200".into(), "8".into()],
            ]),
        };
        resolve_plan_charts(&mut plan);
        let details: Vec<_> = plan.sections[0]
            .items
            .iter()
            .filter_map(|i| i.detail.as_deref())
            .collect();
        assert!(details.iter().any(|d| *d == "Products"));
        assert!(details.iter().any(|d| d.contains("Cost Price Total")));
        assert!(details.iter().any(|d| d.contains("Units Sold")));
        assert!(!details.iter().any(|d| d.contains("Per Unit")));
        assert!(!details.iter().any(|d| d.contains("Product ID")));
    }
}
