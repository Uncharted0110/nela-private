//! Assemble a complete HTML document from a structured `HtmlPlan`.

use crate::grammar::schema::{
    HtmlPlan, HtmlSection, HtmlSectionItem, HtmlSectionKind,
};

use super::layout::{layout_for, ArchetypeLayout, GridVariant, HeroVariant, ARCHETYPE_CSS};
use super::charts::{self, CHART_CSS, CHART_INTERACTION_JS};

const DEFAULT_INTERACTIVE_POOL: &[(&str, &str, &str)] = &[
    ("The Grand Budapest Hotel", "A whimsical caper through a luxurious European hotel.", "2014 · Comedy"),
    ("Arrival", "A linguist deciphers alien language to prevent global war.", "2016 · Sci-Fi"),
    ("Spirited Away", "A girl navigates a spirit world to save her parents.", "2001 · Animation"),
    ("Mad Max: Fury Road", "A high-octane chase across a desert wasteland.", "2015 · Action"),
    ("Parasite", "Class tension erupts in a darkly comic thriller.", "2019 · Thriller"),
    ("Before Sunrise", "Two strangers connect on a single night in Vienna.", "1995 · Romance"),
    ("The Matrix", "A hacker learns reality is a simulation.", "1999 · Sci-Fi"),
    ("Everything Everywhere All at Once", "A laundromat owner faces the multiverse.", "2022 · Adventure"),
];

const REQUIRED_KINDS: &[( &str, &[HtmlSectionKind])] = &[
    (
        "landing",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::Grid,
            HtmlSectionKind::Stats,
            HtmlSectionKind::Quotes,
            HtmlSectionKind::Faq,
            HtmlSectionKind::Cta,
        ],
    ),
    (
        "local_business",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::InfoBar,
            HtmlSectionKind::Grid,
            HtmlSectionKind::Split,
            HtmlSectionKind::Quotes,
            HtmlSectionKind::Cta,
        ],
    ),
    (
        "article",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::Text,
            HtmlSectionKind::Text,
            HtmlSectionKind::Quotes,
            HtmlSectionKind::Cta,
        ],
    ),
    (
        "portfolio",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::Grid,
            HtmlSectionKind::Split,
            HtmlSectionKind::Cta,
        ],
    ),
    (
        "dashboard",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::Stats,
            HtmlSectionKind::Chart,
            HtmlSectionKind::Chart,
            HtmlSectionKind::Text,
        ],
    ),
    (
        "documentation",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::Text,
            HtmlSectionKind::Grid,
            HtmlSectionKind::Faq,
        ],
    ),
    (
        "event",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::InfoBar,
            HtmlSectionKind::Grid,
            HtmlSectionKind::Quotes,
            HtmlSectionKind::Cta,
        ],
    ),
    (
        "comparison",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::Grid,
            HtmlSectionKind::Split,
            HtmlSectionKind::Faq,
            HtmlSectionKind::Cta,
        ],
    ),
    (
        "catalog",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::Grid,
            HtmlSectionKind::Stats,
            HtmlSectionKind::Cta,
        ],
    ),
    (
        "resume",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::Grid,
            HtmlSectionKind::Split,
            HtmlSectionKind::Cta,
        ],
    ),
    (
        "infographic",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::Stats,
            HtmlSectionKind::Grid,
            HtmlSectionKind::Text,
            HtmlSectionKind::Cta,
        ],
    ),
    (
        "newsletter",
        &[
            HtmlSectionKind::Hero,
            HtmlSectionKind::Text,
            HtmlSectionKind::Quotes,
            HtmlSectionKind::Cta,
        ],
    ),
    (
        "interactive",
        &[HtmlSectionKind::Hero, HtmlSectionKind::Grid],
    ),
];

/// Render a plan into a full HTML document. Never returns an empty string.
pub fn render_html_plan(plan: HtmlPlan) -> String {
    if plan.sections.is_empty() {
        if let Some(ref legacy) = plan.html {
            if !legacy.trim().is_empty() {
                return legacy.trim().to_string();
            }
        }
    }

    let mut plan = plan;
    if plan.title.trim().is_empty() {
        plan.title = "Generated Page".to_string();
    }
    if plan.sections.is_empty() {
        plan.sections = default_sections(&plan.archetype, &plan.title, plan.tagline.as_deref());
    }
    plan.sections = normalize_sections(&plan.archetype, plan.sections, &plan.title);
    charts::resolve_plan_charts(&mut plan);

    if plan.archetype == "interactive" {
        return super::interactive::render_interactive_plan(plan);
    }

    let layout = layout_for(&plan.archetype);
    let theme = plan.theme.as_deref().unwrap_or("midnight");
    let title = escape_html(&plan.title);
    let tagline = plan
        .tagline
        .as_deref()
        .map(escape_html)
        .unwrap_or_default();

    let nav_links: String = if layout.show_nav {
        plan.sections
            .iter()
            .enumerate()
            .map(|(i, s)| {
                format!(
                    r##"<a href="#sec-{i}">{}</a>"##,
                    escape_html(&short_nav_label(&s.title))
                )
            })
            .collect::<Vec<_>>()
            .join("\n        ")
    } else {
        String::new()
    };

    let header_cta = layout.header_cta.map(|label| {
        format!(
            r##"<a class="btn btn-small" href="#cta">{}</a>"##,
            escape_html(label)
        )
    }).unwrap_or_default();

    let body_sections: String = plan
        .sections
        .iter()
        .enumerate()
        .map(|(i, s)| render_section(&layout, i, s, theme, plan.images.as_deref()))
        .collect::<Vec<_>>()
        .join("\n");

    let hero_tagline = if tagline.is_empty() {
        String::new()
    } else {
        format!(r#"<p class="site-tagline">{tagline}</p>"#)
    };

    let has_charts = plan
        .sections
        .iter()
        .any(|s| s.kind == HtmlSectionKind::Chart);

    let theme_vars = theme_css(theme);
    let (font_body, font_heading) = theme_fonts(theme, &layout);
    let body_class = layout.body_class;
    let font_vars = format!(
        ":root {{ --font-body: {}; --font-heading: {}; }}",
        font_body, font_heading
    );
    let footer_note = escape_html(layout.footer_note);
    let chart_css = if has_charts { CHART_CSS } else { "" };
    let chart_js = if has_charts {
        CHART_INTERACTION_JS
    } else {
        ""
    };

    format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
{font_vars}
{theme_css}
{base_css}
{archetype_css}
{chart_css}
</style>
</head>
<body class="{body_class}">
  <header class="site-header">
    <div class="container header-inner">
      <a class="logo" href="#top">{title}</a>
      <nav class="site-nav">{nav_links}</nav>
      {header_cta}
    </div>
  </header>
  <main id="top">
    {hero_tagline}
    {body_sections}
  </main>
  <footer class="site-footer">
    <div class="container footer-inner">
      <div>
        <strong>{title}</strong>
        <p class="muted">{footer_note}</p>
      </div>
      <div class="footer-links">
        <a href="#top">Back to top</a>
      </div>
    </div>
  </footer>
  <script>
    document.querySelectorAll('.faq-q').forEach(function(btn) {{
      btn.addEventListener('click', function() {{
        var item = btn.closest('.faq-item');
        if (item) item.classList.toggle('open');
      }});
    }});
    {chart_js}
  </script>
</body>
</html>"##,
        theme_css = theme_vars,
        base_css = BASE_CSS,
        archetype_css = ARCHETYPE_CSS,
        chart_css = chart_css,
        chart_js = chart_js,
    )
}

fn short_nav_label(title: &str) -> String {
    let t = title.trim();
    if t.len() <= 22 {
        return t.to_string();
    }
    format!("{}…", &t[..21])
}

fn default_sections(archetype: &str, title: &str, tagline: Option<&str>) -> Vec<HtmlSection> {
    if archetype == "interactive" {
        return vec![
            HtmlSection {
                kind: HtmlSectionKind::Hero,
                title: title.to_string(),
                subtitle: Some(
                    tagline
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "Hit the button — see what you get.".to_string()),
                ),
                body: None,
                items: vec![],
                ..HtmlSection::with_kind(HtmlSectionKind::Hero)
            },
            HtmlSection {
                kind: HtmlSectionKind::Grid,
                title: "Options".to_string(),
                subtitle: None,
                body: None,
                items: DEFAULT_INTERACTIVE_POOL
                    .iter()
                    .map(|(label, detail, meta)| item(label, detail, Some(meta)))
                    .collect(),
                ..HtmlSection::with_kind(HtmlSectionKind::Grid)
            },
        ];
    }

    let sub = tagline.unwrap_or("Discover more below");
    vec![
        HtmlSection {
            kind: HtmlSectionKind::Hero,
            title: title.to_string(),
            subtitle: Some(sub.to_string()),
            body: Some(format!(
                "Welcome to {} — explore what makes this topic worth your time.",
                title
            )),
            items: vec![],
            ..HtmlSection::with_kind(HtmlSectionKind::Hero)
        },
        HtmlSection {
            kind: HtmlSectionKind::Grid,
            title: "Highlights".to_string(),
            subtitle: None,
            body: None,
            items: vec![
                item("Feature one", "A clear benefit explained in plain language.", None),
                item("Feature two", "Another reason this topic matters today.", None),
                item("Feature three", "Practical value you can act on right away.", None),
            ],
            ..HtmlSection::with_kind(HtmlSectionKind::Grid)
        },
        HtmlSection {
            kind: HtmlSectionKind::Stats,
            title: "By the numbers".to_string(),
            subtitle: None,
            body: None,
            items: vec![
                item("98%", "Satisfaction", None),
                item("24/7", "Availability", None),
                item("10k+", "Community", None),
                item("5★", "Rated experience", None),
            ],
            ..HtmlSection::with_kind(HtmlSectionKind::Stats)
        },
        HtmlSection {
            kind: HtmlSectionKind::Cta,
            title: "Ready to learn more?".to_string(),
            subtitle: Some("Take the next step today.".to_string()),
            body: None,
            items: vec![],
            ..HtmlSection::with_kind(HtmlSectionKind::Cta)
        },
    ]
}

pub(crate) fn normalize_sections(
    archetype: &str,
    sections: Vec<HtmlSection>,
    title: &str,
) -> Vec<HtmlSection> {
    let required = REQUIRED_KINDS
        .iter()
        .find(|(a, _)| *a == archetype)
        .map(|(_, k)| *k)
        .unwrap_or(REQUIRED_KINDS[0].1);

    let mut pool = sections;
    let mut ordered = Vec::with_capacity(required.len() + pool.len());

    for &kind in required {
        if let Some(pos) = pool.iter().position(|s| s.kind == kind) {
            ordered.push(enrich_section(pool.remove(pos)));
        } else {
            ordered.push(enrich_section(placeholder_section(kind, title, archetype)));
        }
    }

    for section in pool.drain(..) {
        ordered.push(enrich_section(section));
    }

    ordered
}

/// Pad sparse sections so grids, FAQs, and quotes never render empty.
fn enrich_section(mut section: HtmlSection) -> HtmlSection {
    let min_items = match section.kind {
        HtmlSectionKind::Grid => 3,
        HtmlSectionKind::Faq | HtmlSectionKind::Quotes | HtmlSectionKind::Stats => 2,
        HtmlSectionKind::InfoBar => 2,
        HtmlSectionKind::Chart => 2,
        _ => 0,
    };

    while section.items.len() < min_items {
        let n = section.items.len() + 1;
        section.items.push(match section.kind {
            HtmlSectionKind::Grid => item(
                &format!("Highlight {n}"),
                "A concise benefit or feature tied to the page topic.",
                None,
            ),
            HtmlSectionKind::Faq => item(
                &format!("Common question {n}?"),
                "A helpful answer with practical detail.",
                None,
            ),
            HtmlSectionKind::Quotes => item(
                "A memorable endorsement about this topic.",
                "— A happy visitor",
                None,
            ),
            HtmlSectionKind::Stats => item(
                &format!("{n}00+"),
                "Key metric",
                None,
            ),
            HtmlSectionKind::InfoBar => item(
                &format!("Detail {n}"),
                "Supporting information",
                None,
            ),
            HtmlSectionKind::Chart => item(
                &format!("Category {n}"),
                "",
                Some(&format!("{n}0")),
            ),
            _ => break,
        });
    }

    if section.title.trim().is_empty() {
        section.title = match section.kind {
            HtmlSectionKind::Hero => "Welcome".to_string(),
            HtmlSectionKind::Cta => "Get started".to_string(),
            _ => "Section".to_string(),
        };
    }

    section
}

fn placeholder_section(kind: HtmlSectionKind, title: &str, archetype: &str) -> HtmlSection {
    if archetype == "interactive" {
        return match kind {
            HtmlSectionKind::Hero => HtmlSection {
                kind,
                title: title.to_string(),
                subtitle: Some("Press the button to get a random pick.".to_string()),
                body: None,
                items: vec![],
                ..HtmlSection::with_kind(kind)
            },
            HtmlSectionKind::Grid => placeholder_interactive_grid(title),
            _ => HtmlSection {
                kind,
                title: title.to_string(),
                subtitle: None,
                body: None,
                items: vec![],
                ..HtmlSection::with_kind(kind)
            },
        };
    }

    match kind {
        HtmlSectionKind::Hero => HtmlSection {
            kind,
            title: title.to_string(),
            subtitle: Some("Your guide starts here".to_string()),
            body: Some(format!("Everything you need to know about {title}, in one place.")),
            items: vec![],
            ..HtmlSection::with_kind(kind)
        },
        HtmlSectionKind::InfoBar => HtmlSection {
            kind,
            title: "Quick info".to_string(),
            subtitle: None,
            body: None,
            items: vec![
                item("Hours", "Mon – Sat · 9am – 6pm", None),
                item("Location", "Downtown · Main Street", None),
                item("Contact", "hello@example.com", None),
            ],
            ..HtmlSection::with_kind(kind)
        },
        HtmlSectionKind::Grid => HtmlSection {
            kind,
            title: "Featured items".to_string(),
            subtitle: None,
            body: None,
            items: vec![
                item("Item A", "Description for the first highlight.", Some("$12")),
                item("Item B", "Description for the second highlight.", Some("$15")),
                item("Item C", "Description for the third highlight.", Some("$9")),
            ],
            ..HtmlSection::with_kind(kind)
        },
        HtmlSectionKind::Split => HtmlSection {
            kind,
            title: "Our story".to_string(),
            subtitle: None,
            body: Some(format!(
                "{title} began with a simple idea: do one thing exceptionally well. \
                 Today we continue that tradition with care, craft, and community at the center."
            )),
            items: vec![],
            ..HtmlSection::with_kind(kind)
        },
        HtmlSectionKind::Stats => HtmlSection {
            kind,
            title: "Key metrics".to_string(),
            subtitle: None,
            body: None,
            items: vec![
                item("120+", "Happy clients", None),
                item("15", "Years experience", None),
                item("4.9", "Average rating", None),
            ],
            ..HtmlSection::with_kind(kind)
        },
        HtmlSectionKind::Quotes => HtmlSection {
            kind,
            title: "What people say".to_string(),
            subtitle: None,
            body: None,
            items: vec![item(
                "A wonderful experience from start to finish.",
                "— A satisfied visitor",
                None,
            )],
            ..HtmlSection::with_kind(kind)
        },
        HtmlSectionKind::Faq => HtmlSection {
            kind,
            title: "Questions".to_string(),
            subtitle: None,
            body: None,
            items: vec![
                item("How do I get started?", "Simply reach out or visit us during opening hours.", None),
                item("Is there a cost?", "Pricing depends on what you need — see highlights above.", None),
            ],
            ..HtmlSection::with_kind(kind)
        },
        HtmlSectionKind::Cta => HtmlSection {
            kind,
            title: "Get in touch".to_string(),
            subtitle: Some("We would love to hear from you.".to_string()),
            body: None,
            items: vec![],
            ..HtmlSection::with_kind(kind)
        },
        HtmlSectionKind::Text => HtmlSection {
            kind,
            title: "Deep dive".to_string(),
            subtitle: None,
            body: Some(format!(
                "This section explores {title} in more detail — background, context, and \
                 practical takeaways you can use right away."
            )),
            items: vec![],
            ..HtmlSection::with_kind(kind)
        },
        HtmlSectionKind::Chart => HtmlSection {
            kind,
            title: "Distribution".to_string(),
            subtitle: None,
            body: None,
            chart_type: Some("bar".to_string()),
            items: vec![
                item("Category A", "", Some("42")),
                item("Category B", "", Some("28")),
                item("Category C", "", Some("18")),
            ],
            ..HtmlSection::with_kind(kind)
        },
        HtmlSectionKind::Image => HtmlSection {
            kind,
            title: "Illustration".to_string(),
            subtitle: None,
            body: None,
            image_index: Some(0),
            items: vec![],
            ..HtmlSection::with_kind(kind)
        },
    }
}

fn placeholder_interactive_grid(title: &str) -> HtmlSection {
    let lower = title.to_lowercase();
    let items = if lower.contains("movie") || lower.contains("film") {
        DEFAULT_INTERACTIVE_POOL
            .iter()
            .map(|(l, d, m)| item(l, d, Some(m)))
            .collect()
    } else {
        vec![
            item("Option A", "First choice in the pool.", Some("Pick me")),
            item("Option B", "Second choice in the pool.", Some("Pick me")),
            item("Option C", "Third choice in the pool.", Some("Pick me")),
            item("Option D", "Fourth choice in the pool.", Some("Pick me")),
        ]
    };
    HtmlSection {
        kind: HtmlSectionKind::Grid,
        title: "Pool".to_string(),
        subtitle: None,
        body: None,
        items,
        ..HtmlSection::with_kind(HtmlSectionKind::Grid)
    }
}

fn item(label: &str, detail: &str, meta: Option<&str>) -> HtmlSectionItem {
    HtmlSectionItem {
        label: label.to_string(),
        detail: Some(detail.to_string()),
        meta: meta.map(|s| s.to_string()),
    }
}

fn render_section(layout: &ArchetypeLayout, index: usize, section: &HtmlSection, theme: &str, images: Option<&[crate::grammar::schema::ArtifactImageAsset]>) -> String {
    let id = format!("sec-{index}");
    let title = escape_html(&section.title);
    let subtitle = section
        .subtitle
        .as_deref()
        .map(|s| format!(r#"<p class="section-sub">{}</p>"#, escape_html(s)))
        .unwrap_or_default();
    let body = section
        .body
        .as_deref()
        .map(|s| format!(r#"<p class="section-body">{}</p>"#, escape_html(s)))
        .unwrap_or_default();

    match section.kind {
        HtmlSectionKind::Hero => render_hero(layout, &id, &title, &subtitle, &body),
        HtmlSectionKind::InfoBar => {
            let chips = section
                .items
                .iter()
                .map(|it| {
                    format!(
                        r#"<div class="info-chip"><strong>{}</strong><span>{}</span></div>"#,
                        escape_html(&it.label),
                        escape_html(it.detail.as_deref().unwrap_or(""))
                    )
                })
                .collect::<Vec<_>>()
                .join("\n      ");
            format!(
                r#"<section class="section info-bar" id="{id}">
  <div class="container info-bar-inner">{chips}</div>
</section>"#
            )
        }
        HtmlSectionKind::Grid => render_grid(layout, &id, &title, &subtitle, section),
        HtmlSectionKind::Split => format!(
            r#"<section class="section split" id="{id}">
  <div class="container split-inner">
    <div class="split-visual" aria-hidden="true"></div>
    <div class="split-copy">
      <h2>{title}</h2>
      {body}
    </div>
  </div>
</section>"#
        ),
        HtmlSectionKind::Stats => {
            let stats = section
                .items
                .iter()
                .map(|it| {
                    format!(
                        r#"<div class="stat"><div class="stat-num">{}</div><div class="stat-label">{}</div></div>"#,
                        escape_html(&it.label),
                        escape_html(it.detail.as_deref().unwrap_or(""))
                    )
                })
                .collect::<Vec<_>>()
                .join("\n      ");
            format!(
                r#"<section class="section stats-band" id="{id}">
  <div class="container">
    <h2 class="section-title center">{title}</h2>
    <div class="stats-row">{stats}</div>
  </div>
</section>"#
            )
        }
        HtmlSectionKind::Quotes => {
            let quotes = section
                .items
                .iter()
                .map(|it| {
                    format!(
                        r#"<blockquote class="quote-card"><p>{}</p><cite>{}</cite></blockquote>"#,
                        escape_html(&it.label),
                        escape_html(it.detail.as_deref().unwrap_or(""))
                    )
                })
                .collect::<Vec<_>>()
                .join("\n      ");
            format!(
                r#"<section class="section alt" id="{id}">
  <div class="container">
    <h2 class="section-title">{title}</h2>
    <div class="quotes">{quotes}</div>
  </div>
</section>"#
            )
        }
        HtmlSectionKind::Faq => {
            let faqs = section
                .items
                .iter()
                .map(|it| {
                    format!(
                        r#"<div class="faq-item"><button type="button" class="faq-q">{}</button><div class="faq-a">{}</div></div>"#,
                        escape_html(&it.label),
                        escape_html(it.detail.as_deref().unwrap_or(""))
                    )
                })
                .collect::<Vec<_>>()
                .join("\n      ");
            format!(
                r#"<section class="section" id="{id}">
  <div class="container narrow">
    <h2 class="section-title">{title}</h2>
    <div class="faq-list">{faqs}</div>
  </div>
</section>"#
            )
        }
        HtmlSectionKind::Cta => format!(
            r##"<section class="section cta" id="cta">
  <div class="container cta-inner">
    <h2>{title}</h2>
    {subtitle}
    <a class="btn btn-lg" href="#top">{}</a>
  </div>
</section>"##,
            escape_html(layout.cta_label)
        ),
        HtmlSectionKind::Text => format!(
            r#"<section class="section prose" id="{id}">
  <div class="container narrow">
    <h2>{title}</h2>
    {body}
  </div>
</section>"#
        ),
        HtmlSectionKind::Chart => charts::render_chart_section(section, index, theme),
        HtmlSectionKind::Image => render_image_section(section, index, images),
    }
}

fn section_image_uri(
    section: &HtmlSection,
    section_index: usize,
    images: Option<&[crate::grammar::schema::ArtifactImageAsset]>,
) -> Option<String> {
    let pool = images.filter(|p| !p.is_empty())?;
    let idx = section
        .image_index
        .map(|i| i as usize)
        .unwrap_or(section_index % pool.len());
    pool.get(idx)
        .or_else(|| pool.first())
        .map(|a| a.data_uri.clone())
}

fn render_image_section(
    section: &HtmlSection,
    index: usize,
    images: Option<&[crate::grammar::schema::ArtifactImageAsset]>,
) -> String {
    let title = escape_html(&section.title);
    let subtitle = section
        .subtitle
        .as_deref()
        .map(|s| format!(r#"<p class="section-sub">{}</p>"#, escape_html(s)))
        .unwrap_or_default();
    let body = section
        .body
        .as_deref()
        .map(|s| format!(r#"<p class="section-body">{}</p>"#, escape_html(s)))
        .unwrap_or_default();

    let img_block = if let Some(uri) = section_image_uri(section, index, images) {
        let alt = escape_html(
            images
                .and_then(|pool| {
                    let idx = section.image_index.map(|i| i as usize).unwrap_or(index % pool.len());
                    pool.get(idx).or_else(|| pool.first())
                })
                .map(|a| {
                    a.alt
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(a.caption.as_str())
                })
                .unwrap_or("Illustration"),
        );
        format!(r#"<figure class="page-figure"><img class="page-image" src="{uri}" alt="{alt}" loading="lazy" /></figure>"#)
    } else {
        r#"<div class="hero-visual" aria-hidden="true"></div>"#.to_string()
    };

    format!(
        r#"<section class="section image-section" id="sec-{index}">
  <div class="container">
    <h2 class="section-title">{title}</h2>
    {subtitle}
    {body}
    {img_block}
  </div>
</section>"#
    )
}

fn render_hero(
    layout: &ArchetypeLayout,
    id: &str,
    title: &str,
    subtitle: &str,
    body: &str,
) -> String {
    let eyebrow = escape_html(layout.hero_eyebrow);
    let actions = match layout.hero {
        HeroVariant::Centered | HeroVariant::Compact | HeroVariant::ResumeBand
        | HeroVariant::EventBanner | HeroVariant::CatalogBanner | HeroVariant::Infographic => {
            String::new()
        }
        HeroVariant::MarketingSplit => format!(
            r##"<div class="hero-actions">
        <a class="btn" href="#sec-1">Explore</a>
        <a class="btn btn-ghost" href="#cta">Contact</a>
      </div>"##
        ),
    };

    let visual = match layout.hero {
        HeroVariant::MarketingSplit | HeroVariant::CatalogBanner => {
            r#"<div class="hero-visual" aria-hidden="true"></div>"#
        }
        _ => "",
    };

    let inner_class = match layout.hero {
        HeroVariant::Compact => "container hero-inner hero-compact",
        HeroVariant::ResumeBand => "container hero-inner hero-resume",
        HeroVariant::EventBanner => "container hero-inner hero-event",
        HeroVariant::Infographic => "container hero-inner hero-infographic",
        _ => "container hero-inner",
    };

    format!(
        r##"<section class="section hero" id="{id}">
  <div class="{inner_class}">
    <div class="hero-copy">
      <span class="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      {subtitle}
      {body}
      {actions}
    </div>
    {visual}
  </div>
</section>"##
    )
}

fn render_grid(
    layout: &ArchetypeLayout,
    id: &str,
    title: &str,
    subtitle: &str,
    section: &HtmlSection,
) -> String {
    let grid_class = match layout.grid {
        GridVariant::Products => "grid cards grid-products",
        GridVariant::Projects => "grid cards grid-projects",
        GridVariant::Compare => "grid cards grid-compare",
        GridVariant::Docs => "grid cards grid-docs",
        GridVariant::Skills => "grid cards grid-skills",
        GridVariant::Cards => "grid cards",
    };

    let cards = section
        .items
        .iter()
        .map(|it| {
            let meta = it
                .meta
                .as_deref()
                .map(|m| format!(r#"<span class="card-meta">{}</span>"#, escape_html(m)))
                .unwrap_or_default();
            let tag = "article";
            format!(
                r#"<{tag} class="card">
        <h3>{}</h3>
        <p>{}</p>
        {meta}
      </{tag}>"#,
                escape_html(&it.label),
                escape_html(it.detail.as_deref().unwrap_or(""))
            )
        })
        .collect::<Vec<_>>()
        .join("\n      ");

    format!(
        r#"<section class="section alt" id="{id}">
  <div class="container">
    <h2 class="section-title">{title}</h2>
    {subtitle}
    <div class="{grid_class}">{cards}</div>
  </div>
</section>"#
    )
}

pub(crate) fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub(crate) fn theme_css(theme: &str) -> &'static str {
    match theme {
        "sunset" => SUNSET_THEME,
        "minimal" => MINIMAL_THEME,
        "corporate" => CORPORATE_THEME,
        "forest" => FOREST_THEME,
        "rose" => ROSE_THEME,
        "cyber" => CYBER_THEME,
        "ocean" => OCEAN_THEME,
        "academic" => ACADEMIC_THEME,
        "lavender" => LAVENDER_THEME,
        "neon" => NEON_THEME,
        "slate" => SLATE_THEME,
        "aurora" => AURORA_THEME,
        "paper" => PAPER_THEME,
        _ => MIDNIGHT_THEME,
    }
}

/// Offline system font stacks per theme (no CDN).
pub(crate) fn theme_fonts(theme: &str, layout: &ArchetypeLayout) -> (&'static str, &'static str) {
    match theme {
        "cyber" => (
            "ui-monospace, 'Cascadia Code', 'Segoe UI', system-ui, sans-serif",
            "ui-monospace, 'Cascadia Code', 'Segoe UI', system-ui, sans-serif",
        ),
        "academic" => (
            "Georgia, 'Times New Roman', serif",
            "Georgia, 'Times New Roman', serif",
        ),
        "ocean" => (
            "system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
            "system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        ),
        "lavender" => (
            "system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
            "Georgia, 'Times New Roman', serif",
        ),
        "paper" => (
            "Georgia, 'Times New Roman', serif",
            "Georgia, 'Times New Roman', serif",
        ),
        _ => (layout.font_body, layout.font_heading),
    }
}

const MIDNIGHT_THEME: &str = r#":root {
  --bg: #0b1020;
  --surface: #151b2e;
  --text: #eef2ff;
  --muted: #94a3b8;
  --accent: #6366f1;
  --accent-2: #22d3ee;
  --hero-grad: linear-gradient(135deg, #1e1b4b 0%, #0b1020 50%, #134e4a 100%);
  --card-grad: linear-gradient(145deg, rgba(99,102,241,.15), rgba(34,211,238,.08));
}"#;

const SUNSET_THEME: &str = r#":root {
  --bg: #1a0f14;
  --surface: #2d1520;
  --text: #fff1f2;
  --muted: #fda4af;
  --accent: #f43f5e;
  --accent-2: #fb923c;
  --hero-grad: linear-gradient(135deg, #7f1d1d 0%, #1a0f14 60%, #9a3412 100%);
  --card-grad: linear-gradient(145deg, rgba(244,63,94,.2), rgba(251,146,60,.1));
}"#;

const MINIMAL_THEME: &str = r#":root {
  --bg: #fafafa;
  --surface: #ffffff;
  --text: #171717;
  --muted: #737373;
  --accent: #2563eb;
  --accent-2: #0ea5e9;
  --hero-grad: linear-gradient(180deg, #ffffff 0%, #f5f5f5 100%);
  --card-grad: linear-gradient(145deg, #fff, #f5f5f5);
}"#;

const CORPORATE_THEME: &str = r#":root {
  --bg: #0f172a;
  --surface: #1e293b;
  --text: #f8fafc;
  --muted: #94a3b8;
  --accent: #2563eb;
  --accent-2: #38bdf8;
  --hero-grad: linear-gradient(135deg, #0f172a, #1e3a5f);
  --card-grad: linear-gradient(145deg, rgba(37,99,235,.18), rgba(30,41,59,.9));
}"#;

const FOREST_THEME: &str = r#":root {
  --bg: #0f1a14;
  --surface: #1a2e22;
  --text: #ecfdf5;
  --muted: #86efac;
  --accent: #22c55e;
  --accent-2: #a3e635;
  --hero-grad: linear-gradient(135deg, #14532d, #0f1a14);
  --card-grad: linear-gradient(145deg, rgba(34,197,94,.15), rgba(163,230,53,.08));
}"#;

const ROSE_THEME: &str = r#":root {
  --bg: #1c1017;
  --surface: #2a1520;
  --text: #fff1f2;
  --muted: #f9a8d4;
  --accent: #e11d48;
  --accent-2: #fbbf24;
  --hero-grad: linear-gradient(135deg, #4c0519, #1c1017);
  --card-grad: linear-gradient(145deg, rgba(225,29,72,.2), rgba(251,191,36,.08));
}"#;

const CYBER_THEME: &str = r#":root {
  --bg: #050508;
  --surface: #0a1628;
  --text: #e0fff4;
  --muted: #4ade80;
  --accent: #22d3ee;
  --accent-2: #10b981;
  --hero-grad: linear-gradient(135deg, #050508, #0a1628 60%, #064e3b);
  --card-grad: linear-gradient(145deg, rgba(34,211,238,.12), rgba(16,185,129,.08));
}"#;

const OCEAN_THEME: &str = r#":root {
  --bg: #0c1929;
  --surface: #0f2847;
  --text: #e0f2fe;
  --muted: #7dd3fc;
  --accent: #38bdf8;
  --accent-2: #0284c7;
  --hero-grad: linear-gradient(135deg, #0c1929, #0f2847);
  --card-grad: linear-gradient(145deg, rgba(56,189,248,.15), rgba(2,132,199,.08));
}"#;

const ACADEMIC_THEME: &str = r#":root {
  --bg: #f8f5f0;
  --surface: #ede8e0;
  --text: #292524;
  --muted: #78716c;
  --accent: #991b1b;
  --accent-2: #7f1d1d;
  --hero-grad: linear-gradient(180deg, #f8f5f0, #ede8e0);
  --card-grad: linear-gradient(145deg, #fff, #ede8e0);
}"#;

const LAVENDER_THEME: &str = r#":root {
  --bg: #1a1028;
  --surface: #261433;
  --text: #f5f3ff;
  --muted: #c4b5fd;
  --accent: #a78bfa;
  --accent-2: #e879f9;
  --hero-grad: linear-gradient(135deg, #1a1028, #312e81);
  --card-grad: linear-gradient(145deg, rgba(167,139,250,.18), rgba(232,121,249,.08));
}"#;

const NEON_THEME: &str = r#":root {
  --bg: #0a0a0f;
  --surface: #14141f;
  --text: #fafafa;
  --muted: #f0abfc;
  --accent: #f0abfc;
  --accent-2: #22d3ee;
  --hero-grad: linear-gradient(135deg, #0a0a0f, #1e1b4b);
  --card-grad: linear-gradient(145deg, rgba(240,171,252,.2), rgba(34,211,238,.1));
}"#;

const SLATE_THEME: &str = r#":root {
  --bg: #0f1419;
  --surface: #1a222c;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --accent: #64748b;
  --accent-2: #cbd5e1;
  --hero-grad: linear-gradient(135deg, #0f1419, #1e293b);
  --card-grad: linear-gradient(145deg, rgba(100,116,139,.2), rgba(30,41,59,.9));
}"#;

const AURORA_THEME: &str = r#":root {
  --bg: #0b1020;
  --surface: #121a2e;
  --text: #ecfeff;
  --muted: #a5b4fc;
  --accent: #22d3ee;
  --accent-2: #a78bfa;
  --hero-grad: linear-gradient(135deg, #0b1020, #1e1b4b 50%, #134e4a);
  --card-grad: linear-gradient(145deg, rgba(34,211,238,.15), rgba(167,139,250,.12));
}"#;

const PAPER_THEME: &str = r#":root {
  --bg: #faf8f5;
  --surface: #ffffff;
  --text: #1c1917;
  --muted: #78716c;
  --accent: #b45309;
  --accent-2: #1d4ed8;
  --hero-grad: linear-gradient(180deg, #faf8f5, #f5f0e8);
  --card-grad: linear-gradient(145deg, #fff, #f5f0e8);
}"#;

pub(crate) const BASE_CSS: &str = r#"
* { box-sizing: border-box; margin: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--font-body, 'DM Sans', system-ui, sans-serif);
  background: var(--bg);
  color: var(--text);
  line-height: 1.65;
}
h1, h2, h3 { font-family: var(--font-heading, 'Fraunces', Georgia, serif); line-height: 1.15; }
.container { width: min(1120px, 100% - 2rem); margin: 0 auto; }
.narrow { width: min(720px, 100% - 2rem); margin: 0 auto; }
.site-header {
  position: sticky; top: 0; z-index: 50;
  backdrop-filter: blur(12px);
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
}
.header-inner { display: flex; align-items: center; gap: 1rem; padding: .9rem 0; }
.logo { font-weight: 700; color: var(--text); text-decoration: none; font-size: 1.05rem; }
.site-nav { display: flex; gap: 1rem; flex-wrap: wrap; margin-left: auto; }
.site-nav a { color: var(--muted); text-decoration: none; font-size: .9rem; }
.site-nav a:hover { color: var(--accent-2); }
.btn {
  display: inline-block; padding: .75rem 1.35rem; border-radius: 999px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #fff; font-weight: 600; text-decoration: none; border: none;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 35%, transparent);
}
.btn-small { padding: .5rem 1rem; font-size: .85rem; }
.btn-lg { padding: 1rem 1.75rem; font-size: 1.05rem; }
.btn-ghost {
  background: transparent; color: var(--text);
  border: 1px solid color-mix(in srgb, var(--text) 20%, transparent);
  box-shadow: none;
}
.section { padding: clamp(3rem, 7vw, 5.5rem) 0; }
.section.alt { background: color-mix(in srgb, var(--surface) 70%, var(--bg)); }
.section-title { font-size: clamp(1.6rem, 3vw, 2.2rem); margin-bottom: 1rem; }
.section-title.center { text-align: center; }
.section-sub { color: var(--muted); font-size: 1.1rem; margin-bottom: .75rem; }
.section-body { color: color-mix(in srgb, var(--text) 88%, var(--muted)); max-width: 65ch; }
.hero { background: var(--hero-grad); }
.hero-inner {
  display: grid; grid-template-columns: 1.1fr .9fr; gap: 2rem; align-items: center;
}
.hero-copy h1 { font-size: clamp(2.2rem, 5vw, 3.6rem); margin: .5rem 0 1rem; }
.eyebrow {
  display: inline-block; font-size: .75rem; letter-spacing: .12em; text-transform: uppercase;
  color: var(--accent-2); font-weight: 700;
}
.hero-actions { display: flex; gap: .75rem; flex-wrap: wrap; margin-top: 1.5rem; }
.hero-visual, .split-visual {
  min-height: 280px; border-radius: 24px;
  background: var(--card-grad);
  border: 1px solid color-mix(in srgb, var(--text) 12%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
}
.info-bar-inner { display: flex; flex-wrap: wrap; gap: 1rem; justify-content: center; }
.info-chip {
  background: var(--surface); padding: .85rem 1.1rem; border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
  min-width: 160px;
}
.info-chip strong { display: block; font-size: .8rem; color: var(--accent-2); }
.grid.cards {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem;
}
.card {
  background: var(--surface); padding: 1.25rem; border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--text) 8%, transparent);
  transition: transform .2s ease, box-shadow .2s ease;
}
.card:hover { transform: translateY(-4px); box-shadow: 0 16px 40px rgba(0,0,0,.2); }
.card h3 { margin-bottom: .5rem; font-size: 1.1rem; }
.card p { color: var(--muted); font-size: .92rem; }
.card-meta { display: inline-block; margin-top: .5rem; font-weight: 700; color: var(--accent); }
.split-inner { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; align-items: center; }
.stats-band { background: var(--surface); }
.stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; }
.stat { text-align: center; padding: 1rem; }
.stat-num { font-size: 2rem; font-weight: 700; color: var(--accent-2); }
.stat-label { color: var(--muted); font-size: .9rem; }
.quotes { display: grid; gap: 1rem; }
.quote-card {
  background: var(--surface); padding: 1.25rem 1.5rem; border-radius: 16px;
  border-left: 4px solid var(--accent);
}
.quote-card cite { display: block; margin-top: .75rem; color: var(--muted); font-style: normal; }
.faq-item { border-bottom: 1px solid color-mix(in srgb, var(--text) 12%, transparent); }
.faq-q {
  width: 100%; text-align: left; background: none; border: none; color: var(--text);
  padding: 1rem 0; font: inherit; font-weight: 600; cursor: pointer;
}
.faq-a { display: none; padding-bottom: 1rem; color: var(--muted); }
.faq-item.open .faq-a { display: block; }
.cta {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #fff; text-align: center;
}
.cta-inner h2 { color: #fff; margin-bottom: .5rem; }
.cta .btn { background: #fff; color: var(--accent); box-shadow: none; }
.prose h2 { margin-bottom: 1rem; }
.prose p { margin-bottom: 1rem; color: color-mix(in srgb, var(--text) 90%, var(--muted)); }
.site-footer {
  border-top: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
  padding: 2rem 0; margin-top: 2rem;
}
.footer-inner { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.muted { color: var(--muted); font-size: .9rem; margin-top: .35rem; }
.footer-links a { color: var(--muted); }
@media (max-width: 768px) {
  .hero-inner, .split-inner { grid-template-columns: 1fr; }
  .site-nav { display: none; }
}
.page-figure { margin: 1.25rem 0 0; border-radius: 16px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--text) 10%, transparent); }
.page-image { width: 100%; max-height: 420px; object-fit: cover; display: block; }
.image-section .hero-visual { min-height: 200px; margin-top: 1rem; }
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grammar::schema::HtmlPlan;

    #[test]
    fn renders_complete_document() {
        let plan = HtmlPlan {
            title: "Test Bakery".into(),
            tagline: Some("Fresh daily".into()),
            archetype: "local_business".into(),
            sections: vec![],
            theme: Some("sunset".into()),
            output_name: None,
            html: None,
            headers: None,
            source_rows: None,
            images: None,
        };
        let html = render_html_plan(plan);
        assert!(html.contains("<!DOCTYPE html>"));
        assert!(html.contains("Test Bakery"));
        assert!(html.contains("site-footer"));
        assert!(html.contains("faq-item") || html.contains("info-chip"));
        assert!(html.contains("layout-business"));
    }

    #[test]
    fn renders_archetype_layout_classes() {
        let article = HtmlPlan {
            title: "Climate Essay".into(),
            tagline: None,
            archetype: "article".into(),
            sections: vec![],
            theme: Some("minimal".into()),
            output_name: None,
            html: None,
            headers: None,
            source_rows: None,
            images: None,
        };
        assert!(render_html_plan(article).contains("layout-article"));

        let resume = HtmlPlan {
            title: "Jane Doe".into(),
            tagline: Some("Engineer".into()),
            archetype: "resume".into(),
            sections: vec![],
            theme: Some("minimal".into()),
            output_name: None,
            html: None,
            headers: None,
            source_rows: None,
            images: None,
        };
        assert!(render_html_plan(resume).contains("layout-resume"));

        let picker = HtmlPlan {
            title: "Random Movie Picker".into(),
            tagline: None,
            archetype: "interactive".into(),
            sections: vec![],
            theme: Some("midnight".into()),
            output_name: None,
            html: None,
            headers: None,
            source_rows: None,
            images: None,
        };
        let html = render_html_plan(picker);
        assert!(html.contains("layout-interactive"));
        assert!(html.contains("pick-btn"));
        assert!(html.contains("Pick a random movie"));
    }

    #[test]
    fn renders_dashboard_charts() {
        let plan = HtmlPlan {
            title: "Sales Dashboard".into(),
            tagline: Some("Q4 overview".into()),
            archetype: "dashboard".into(),
            sections: vec![{
                let mut s = HtmlSection::with_kind(HtmlSectionKind::Chart);
                s.title = "Revenue".into();
                s.chart_type = Some("bar".into());
                s.items = vec![
                    item("A", "", Some("10")),
                    item("B", "", Some("20")),
                ];
                s
            }],
            theme: Some("corporate".into()),
            output_name: None,
            html: None,
            headers: None,
            source_rows: None,
            images: None,
        };
        let html = render_html_plan(plan);
        assert!(html.contains("chart-panel"));
        assert!(html.contains("chart-bar"));
        assert!(!html.contains("fonts.googleapis.com"));
    }
}
