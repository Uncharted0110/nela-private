//! Interactive / utility pages — mini-apps that DO something (pickers, generators).

use crate::grammar::schema::{HtmlPlan, HtmlSection, HtmlSectionItem, HtmlSectionKind};

use super::layout::layout_for;
use super::render::{escape_html, normalize_sections, theme_css, BASE_CSS};
use super::layout::ARCHETYPE_CSS;

const DEFAULT_POOL: &[(&str, &str, &str)] = &[
    ("The Grand Budapest Hotel", "A whimsical caper through a luxurious European hotel.", "2014 · Comedy"),
    ("Arrival", "A linguist deciphers alien language to prevent global war.", "2016 · Sci-Fi"),
    ("Spirited Away", "A girl navigates a spirit world to save her parents.", "2001 · Animation"),
    ("Mad Max: Fury Road", "A high-octane chase across a desert wasteland.", "2015 · Action"),
    ("Parasite", "Class tension erupts in a darkly comic thriller.", "2019 · Thriller"),
    ("Before Sunrise", "Two strangers connect on a single night in Vienna.", "1995 · Romance"),
    ("The Matrix", "A hacker learns reality is a simulation.", "1999 · Sci-Fi"),
    ("Everything Everywhere All at Once", "A laundromat owner faces the multiverse.", "2022 · Adventure"),
];

/// Render a utility page (random picker, generator, etc.) — not a marketing site.
pub fn render_interactive_plan(mut plan: HtmlPlan) -> String {
    if plan.title.trim().is_empty() {
        plan.title = "Interactive Tool".to_string();
    }
    plan.sections = normalize_sections("interactive", plan.sections, &plan.title);

    let layout = layout_for("interactive");
    let theme = plan.theme.as_deref().unwrap_or("midnight");
    let title = escape_html(&plan.title);

    let hero = plan
        .sections
        .iter()
        .find(|s| s.kind == HtmlSectionKind::Hero);
    let hero_title = hero
        .map(|h| escape_html(&h.title))
        .unwrap_or_else(|| title.clone());
    let hero_sub = hero
        .and_then(|h| h.subtitle.as_deref())
        .map(escape_html)
        .unwrap_or_else(|| "Press the button to get a random pick.".to_string());
    let hero_body = hero
        .and_then(|h| h.body.as_deref())
        .map(escape_html)
        .unwrap_or_default();

    let pool = pool_items(&plan.sections);
    let options_json = build_options_json(&pool);
    let pool_list = render_pool_list(&pool);
    let action_label = infer_action_label(&plan.title, &pool);

    let theme_vars = theme_css(theme);
    let font_vars = format!(
        ":root {{ --font-body: {}; --font-heading: {}; }}",
        layout.font_body, layout.font_heading
    );

    format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="{font_url}" rel="stylesheet">
<style>
{font_vars}
{theme_css}
{base_css}
{archetype_css}
</style>
</head>
<body class="{body_class}">
  <header class="site-header">
    <div class="container header-inner">
      <span class="logo">{title}</span>
    </div>
  </header>
  <main id="top">
    <section class="section hero app-hero">
      <div class="container narrow">
        <h1>{hero_title}</h1>
        <p class="section-sub">{hero_sub}</p>
        {hero_body_block}
      </div>
    </section>
    <section class="section app-tool" id="tool">
      <div class="container narrow tool-panel">
        <div class="result-card" id="result-card" aria-live="polite">
          <p class="result-placeholder">Your pick will appear here</p>
        </div>
        <button type="button" class="btn btn-lg" id="pick-btn">{action_label}</button>
        <div class="pool-section">
          <h2 class="pool-heading">In the pool</h2>
          <ul class="pool-list" id="pool-list">{pool_list}</ul>
        </div>
      </div>
    </section>
  </main>
  <footer class="site-footer">
    <div class="container footer-inner">
      <p class="muted">{footer_note}</p>
    </div>
  </footer>
  <script>
    var OPTIONS = {options_json};
    var btn = document.getElementById('pick-btn');
    var card = document.getElementById('result-card');
    var lastIdx = -1;

    function pickRandom() {{
      if (!OPTIONS.length) return;
      var idx;
      do {{
        idx = Math.floor(Math.random() * OPTIONS.length);
      }} while (OPTIONS.length > 1 && idx === lastIdx);
      lastIdx = idx;
      var o = OPTIONS[idx];
      card.innerHTML =
        '<span class="result-meta">' + escapeHtml(o.meta || '') + '</span>' +
        '<h2 class="result-title">' + escapeHtml(o.label) + '</h2>' +
        '<p class="result-detail">' + escapeHtml(o.detail || '') + '</p>';
      card.classList.add('revealed');
      document.querySelectorAll('.pool-list li').forEach(function(li, i) {{
        li.classList.toggle('active', i === idx);
      }});
    }}

    function escapeHtml(s) {{
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }}

    btn.addEventListener('click', pickRandom);
    if (OPTIONS.length) pickRandom();
  </script>
</body>
</html>"##,
        font_url = layout.font_url,
        body_class = layout.body_class,
        theme_css = theme_vars,
        hero_body_block = if hero_body.is_empty() {
            String::new()
        } else {
            format!(r#"<p class="section-body">{hero_body}</p>"#)
        },
        footer_note = escape_html(layout.footer_note),
        action_label = escape_html(&action_label),
        base_css = BASE_CSS,
        archetype_css = ARCHETYPE_CSS,
    )
}

fn pool_items(sections: &[HtmlSection]) -> Vec<HtmlSectionItem> {
    let from_plan: Vec<_> = sections
        .iter()
        .find(|s| s.kind == HtmlSectionKind::Grid)
        .map(|s| s.items.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|it| !it.label.trim().is_empty())
        .collect();

    if !from_plan.is_empty() {
        return from_plan;
    }

    DEFAULT_POOL
        .iter()
        .map(|(label, detail, meta)| HtmlSectionItem {
            label: (*label).to_string(),
            detail: Some((*detail).to_string()),
            meta: Some((*meta).to_string()),
        })
        .collect()
}

fn build_options_json(items: &[HtmlSectionItem]) -> String {
    let entries: Vec<String> = items
        .iter()
        .map(|it| {
            format!(
                "{{\"label\":{},\"detail\":{},\"meta\":{}}}",
                js_string(&it.label),
                js_string(it.detail.as_deref().unwrap_or("")),
                js_string(it.meta.as_deref().unwrap_or(""))
            )
        })
        .collect();
    format!("[{}]", entries.join(","))
}

fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

fn render_pool_list(items: &[HtmlSectionItem]) -> String {
    items
        .iter()
        .enumerate()
        .map(|(i, it)| {
            let meta = it
                .meta
                .as_deref()
                .map(|m| format!(r#"<span class="pool-meta">{}</span>"#, escape_html(m)))
                .unwrap_or_default();
            format!(
                r#"<li data-idx="{i}"><strong>{}</strong>{meta}</li>"#,
                escape_html(&it.label)
            )
        })
        .collect::<Vec<_>>()
        .join("\n          ")
}

fn infer_action_label(title: &str, pool: &[HtmlSectionItem]) -> String {
    let lower = title.to_lowercase();
    if lower.contains("movie") || lower.contains("film") || lower.contains("watch") {
        return "Pick a random movie".to_string();
    }
    if lower.contains("recipe") || lower.contains("food") || lower.contains("meal") {
        return "Pick a random recipe".to_string();
    }
    if lower.contains("book") || lower.contains("read") {
        return "Pick a random book".to_string();
    }
    if lower.contains("song") || lower.contains("music") {
        return "Pick a random song".to_string();
    }
    if pool.len() == 1 {
        return "Generate".to_string();
    }
    "Pick one at random".to_string()
}
