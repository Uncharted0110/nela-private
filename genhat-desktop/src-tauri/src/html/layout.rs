//! Per-archetype page shells — different headers, heroes, grids, and typography.

#[derive(Clone, Copy)]
pub enum HeroVariant {
    MarketingSplit,
    Centered,
    Compact,
    ResumeBand,
    EventBanner,
    CatalogBanner,
    Infographic,
}

#[derive(Clone, Copy)]
pub enum GridVariant {
    Cards,
    Products,
    Projects,
    Compare,
    Docs,
    Skills,
}

#[derive(Clone, Copy)]
pub struct ArchetypeLayout {
    pub body_class: &'static str,
    pub font_url: &'static str,
    pub font_body: &'static str,
    pub font_heading: &'static str,
    pub header_cta: Option<&'static str>,
    pub show_nav: bool,
    pub footer_note: &'static str,
    pub hero: HeroVariant,
    pub grid: GridVariant,
    pub cta_label: &'static str,
    pub hero_eyebrow: &'static str,
}

pub fn layout_for(archetype: &str) -> ArchetypeLayout {
    match archetype {
        "local_business" => ArchetypeLayout {
            body_class: "layout-business",
            font_url: "https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600;9..40,700&family=Playfair+Display:wght@600;700&display=swap",
            font_body: "'DM Sans', system-ui, sans-serif",
            font_heading: "'Playfair Display', Georgia, serif",
            header_cta: Some("Visit us"),
            show_nav: true,
            footer_note: "We look forward to seeing you.",
            hero: HeroVariant::Centered,
            grid: GridVariant::Products,
            cta_label: "Get directions",
            hero_eyebrow: "Locally owned",
        },
        "article" => ArchetypeLayout {
            body_class: "layout-article",
            font_url: "https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&family=Source+Sans+3:wght@400;600&display=swap",
            font_body: "'Source Sans 3', system-ui, sans-serif",
            font_heading: "'Lora', Georgia, serif",
            header_cta: None,
            show_nav: false,
            footer_note: "Thanks for reading.",
            hero: HeroVariant::Centered,
            grid: GridVariant::Cards,
            cta_label: "Read more",
            hero_eyebrow: "Essay",
        },
        "portfolio" => ArchetypeLayout {
            body_class: "layout-portfolio",
            font_url: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap",
            font_body: "'Space Grotesk', system-ui, sans-serif",
            font_heading: "'Space Grotesk', system-ui, sans-serif",
            header_cta: Some("Hire me"),
            show_nav: true,
            footer_note: "Available for new projects.",
            hero: HeroVariant::MarketingSplit,
            grid: GridVariant::Projects,
            cta_label: "View work",
            hero_eyebrow: "Portfolio",
        },
        "dashboard" => ArchetypeLayout {
            body_class: "layout-dashboard",
            font_url: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap",
            font_body: "'IBM Plex Sans', system-ui, sans-serif",
            font_heading: "'IBM Plex Sans', system-ui, sans-serif",
            header_cta: Some("Export"),
            show_nav: true,
            footer_note: "Data refreshes automatically.",
            hero: HeroVariant::Compact,
            grid: GridVariant::Docs,
            cta_label: "Open report",
            hero_eyebrow: "Overview",
        },
        "documentation" => ArchetypeLayout {
            body_class: "layout-docs",
            font_url: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
            font_body: "'Inter', system-ui, sans-serif",
            font_heading: "'Inter', system-ui, sans-serif",
            header_cta: Some("API ref"),
            show_nav: true,
            footer_note: "Documentation generated locally.",
            hero: HeroVariant::Compact,
            grid: GridVariant::Docs,
            cta_label: "Get started",
            hero_eyebrow: "Docs",
        },
        "event" => ArchetypeLayout {
            body_class: "layout-event",
            font_url: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=Bebas+Neue&display=swap",
            font_body: "'DM Sans', system-ui, sans-serif",
            font_heading: "'Bebas Neue', Impact, sans-serif",
            header_cta: Some("Get tickets"),
            show_nav: true,
            footer_note: "See you there!",
            hero: HeroVariant::EventBanner,
            grid: GridVariant::Cards,
            cta_label: "Register now",
            hero_eyebrow: "Upcoming event",
        },
        "comparison" => ArchetypeLayout {
            body_class: "layout-compare",
            font_url: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap",
            font_body: "'DM Sans', system-ui, sans-serif",
            font_heading: "'DM Sans', system-ui, sans-serif",
            header_cta: Some("Compare"),
            show_nav: true,
            footer_note: "Choose what fits you best.",
            hero: HeroVariant::Compact,
            grid: GridVariant::Compare,
            cta_label: "Pick a plan",
            hero_eyebrow: "Comparison",
        },
        "catalog" => ArchetypeLayout {
            body_class: "layout-catalog",
            font_url: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap",
            font_body: "'DM Sans', system-ui, sans-serif",
            font_heading: "'DM Sans', system-ui, sans-serif",
            header_cta: Some("Shop all"),
            show_nav: true,
            footer_note: "Free returns within 30 days.",
            hero: HeroVariant::CatalogBanner,
            grid: GridVariant::Products,
            cta_label: "Add to cart",
            hero_eyebrow: "New collection",
        },
        "resume" => ArchetypeLayout {
            body_class: "layout-resume",
            font_url: "https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;600&family=Work+Sans:wght@400;500;600&display=swap",
            font_body: "'Work Sans', system-ui, sans-serif",
            font_heading: "'Crimson Pro', Georgia, serif",
            header_cta: Some("Contact"),
            show_nav: false,
            footer_note: "References available on request.",
            hero: HeroVariant::ResumeBand,
            grid: GridVariant::Skills,
            cta_label: "Download CV",
            hero_eyebrow: "Professional profile",
        },
        "infographic" => ArchetypeLayout {
            body_class: "layout-infographic",
            font_url: "https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap",
            font_body: "'Archivo', system-ui, sans-serif",
            font_heading: "'Archivo', system-ui, sans-serif",
            header_cta: None,
            show_nav: true,
            footer_note: "Sources cited in text.",
            hero: HeroVariant::Infographic,
            grid: GridVariant::Cards,
            cta_label: "Learn more",
            hero_eyebrow: "Key facts",
        },
        "newsletter" => ArchetypeLayout {
            body_class: "layout-newsletter",
            font_url: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=DM+Sans:wght@400;600&display=swap",
            font_body: "'DM Sans', system-ui, sans-serif",
            font_heading: "'Fraunces', Georgia, serif",
            header_cta: Some("Subscribe"),
            show_nav: false,
            footer_note: "No spam. Unsubscribe anytime.",
            hero: HeroVariant::Centered,
            grid: GridVariant::Cards,
            cta_label: "Join the list",
            hero_eyebrow: "Newsletter",
        },
        "interactive" => ArchetypeLayout {
            body_class: "layout-interactive",
            font_url: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=Outfit:wght@500;700&display=swap",
            font_body: "'DM Sans', system-ui, sans-serif",
            font_heading: "'Outfit', system-ui, sans-serif",
            header_cta: None,
            show_nav: false,
            footer_note: "Runs entirely in your browser.",
            hero: HeroVariant::Compact,
            grid: GridVariant::Cards,
            cta_label: "Pick again",
            hero_eyebrow: "Tool",
        },
        _ => ArchetypeLayout {
            body_class: "layout-landing",
            font_url: "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,600;0,9..40,700;1,9..40,400&family=Fraunces:opsz,wght@9..144,600;9..144,700&display=swap",
            font_body: "'DM Sans', system-ui, sans-serif",
            font_heading: "'Fraunces', Georgia, serif",
            header_cta: Some("Get started"),
            show_nav: true,
            footer_note: "Crafted with NELA — local intelligence.",
            hero: HeroVariant::MarketingSplit,
            grid: GridVariant::Cards,
            cta_label: "Start now",
            hero_eyebrow: "Welcome",
        },
    }
}

pub const ARCHETYPE_CSS: &str = r#"
/* ── Article: editorial, reading-focused ── */
.layout-article .site-header { position: static; border: none; background: var(--bg); }
.layout-article .hero { background: transparent; padding-top: 2rem; }
.layout-article .hero-inner { grid-template-columns: 1fr; text-align: left; }
.layout-article .hero-visual { display: none; }
.layout-article .hero-actions { display: none; }
.layout-article .hero-copy h1 { font-size: clamp(2.4rem, 5vw, 3.8rem); }
.layout-article .prose { font-size: 1.08rem; }
.layout-article .prose p { max-width: 68ch; }
.layout-article .site-footer { margin-top: 4rem; text-align: center; }

/* ── Local business: warm, welcoming ── */
.layout-business .hero-inner { grid-template-columns: 1fr; text-align: center; }
.layout-business .hero-visual { display: none; }
.layout-business .info-bar { background: color-mix(in srgb, var(--accent) 12%, var(--bg)); }
.layout-business .grid.cards { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.layout-business .card { border-radius: 12px; text-align: center; }

/* ── Portfolio: bold projects grid ── */
.layout-portfolio .hero-visual { min-height: 320px; border-radius: 0; margin: 0 -1rem; width: calc(100% + 2rem); }
.layout-portfolio .grid.cards { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.25rem; }
.layout-portfolio .card { border-radius: 8px; padding: 0; overflow: hidden; }
.layout-portfolio .card h3 { padding: 1rem 1rem .25rem; }
.layout-portfolio .card p { padding: 0 1rem 1rem; }
.layout-portfolio .card::before {
  content: ""; display: block; height: 140px;
  background: var(--card-grad);
  border-bottom: 1px solid color-mix(in srgb, var(--text) 8%, transparent);
}

/* ── Dashboard: dense panels ── */
.layout-dashboard .site-header { background: var(--surface); }
.layout-dashboard .hero { background: var(--surface); padding: 1.5rem 0; }
.layout-dashboard .hero-inner { grid-template-columns: 1fr; }
.layout-dashboard .hero-visual, .layout-dashboard .hero-actions { display: none; }
.layout-dashboard .hero-copy h1 { font-size: 1.5rem; }
.layout-dashboard .stats-band { padding: 1.5rem 0; }
.layout-dashboard .stat {
  background: var(--bg); border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--text) 8%, transparent);
}
.layout-dashboard .card { border-radius: 10px; }
.layout-dashboard .chart-section { padding: 1rem 0; }
.layout-dashboard main .chart-section + .chart-section { margin-top: -0.5rem; }

/* ── Documentation: clean reference layout ── */
.layout-docs .site-header { background: var(--surface); }
.layout-docs .hero { padding: 2rem 0 1rem; background: var(--bg); }
.layout-docs .hero-inner { grid-template-columns: 1fr; }
.layout-docs .hero-visual, .layout-docs .hero-actions { display: none; }
.layout-docs .hero-copy h1 { font-size: 2rem; font-family: var(--font-mono, monospace); }
.layout-docs .grid.cards { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.layout-docs .card { font-size: .92rem; border-left: 3px solid var(--accent); }

/* ── Event: poster energy ── */
.layout-event .hero { text-align: center; }
.layout-event .hero-inner { grid-template-columns: 1fr; }
.layout-event .hero-visual { display: none; }
.layout-event .hero-copy h1 {
  font-size: clamp(3rem, 8vw, 5rem); letter-spacing: .04em; text-transform: uppercase;
}
.layout-event .eyebrow {
  background: var(--accent); color: #fff; padding: .35rem .9rem; border-radius: 6px;
  letter-spacing: .08em;
}
.layout-event .info-bar-inner { justify-content: center; gap: 2rem; }

/* ── Comparison: side-by-side options ── */
.layout-compare .grid.cards { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.layout-compare .card {
  text-align: center; padding: 1.75rem 1.25rem;
  border: 2px solid color-mix(in srgb, var(--text) 10%, transparent);
}
.layout-compare .card:hover { border-color: var(--accent); }
.layout-compare .card-meta { font-size: 1.4rem; display: block; margin: .75rem 0; }
.layout-compare .split-inner { grid-template-columns: 1fr 1fr; gap: 0; }
.layout-compare .split-visual { border-radius: 0; min-height: 200px; }

/* ── Catalog: shop grid ── */
.layout-catalog .hero-inner { grid-template-columns: 1fr; }
.layout-catalog .hero-visual { display: none; }
.layout-catalog .grid.cards { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.layout-catalog .card { text-align: left; }
.layout-catalog .card-meta {
  display: block; font-size: 1.15rem; margin-top: .75rem;
  padding-top: .75rem; border-top: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
}

/* ── Resume: CV band ── */
.layout-resume .site-header { border: none; background: transparent; position: static; }
.layout-resume .hero {
  background: color-mix(in srgb, var(--surface) 90%, var(--accent));
  border-bottom: 3px solid var(--accent);
}
.layout-resume .hero-inner { grid-template-columns: 1fr; }
.layout-resume .hero-visual, .layout-resume .hero-actions { display: none; }
.layout-resume .hero-copy h1 { font-size: 2.4rem; }
.layout-resume .grid.cards {
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .6rem;
}
.layout-resume .card {
  padding: .65rem .9rem; border-radius: 999px; text-align: center;
  background: color-mix(in srgb, var(--accent) 15%, var(--surface));
}
.layout-resume .card h3 { font-size: .9rem; margin: 0; }
.layout-resume .card p { display: none; }
.layout-resume .split-copy h2 { font-size: 1.3rem; color: var(--accent-2); }

/* ── Infographic: stat-forward ── */
.layout-infographic .hero-inner { grid-template-columns: 1fr; text-align: center; }
.layout-infographic .hero-visual { display: none; }
.layout-infographic .stats-band { background: var(--hero-grad); }
.layout-infographic .stat-num { font-size: 3rem; }
.layout-infographic .section.alt { background: transparent; }

/* ── Newsletter: narrow centered column ── */
.layout-newsletter main { max-width: 640px; margin: 0 auto; }
.layout-newsletter .site-header { justify-content: center; text-align: center; }
.layout-newsletter .header-inner { flex-direction: column; gap: .5rem; }
.layout-newsletter .logo { margin: 0 auto; }
.layout-newsletter .hero { text-align: center; background: transparent; }
.layout-newsletter .hero-inner { grid-template-columns: 1fr; }
.layout-newsletter .hero-visual, .layout-newsletter .hero-actions { display: none; }
.layout-newsletter .cta { border-radius: 16px; margin-bottom: 2rem; }

/* ── Interactive: utility / picker apps ── */
.layout-interactive .site-header { position: static; background: transparent; border: none; }
.layout-interactive .header-inner { justify-content: center; padding: 1.25rem 0 .5rem; }
.layout-interactive .logo { font-size: .95rem; color: var(--muted); font-weight: 600; }
.layout-interactive .app-hero { padding: 1rem 0 0; background: transparent; text-align: center; }
.layout-interactive .app-hero h1 { font-size: clamp(1.8rem, 4vw, 2.6rem); margin-bottom: .35rem; }
.layout-interactive .app-hero .section-sub { margin-bottom: 0; }
.layout-interactive .tool-panel { text-align: center; padding-bottom: 2rem; }
.layout-interactive .result-card {
  background: var(--surface); border-radius: 20px; padding: 2rem 1.5rem;
  margin-bottom: 1.25rem; min-height: 180px;
  border: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  transition: transform .25s ease, box-shadow .25s ease;
}
.layout-interactive .result-card.revealed { transform: scale(1.02); box-shadow: 0 20px 50px rgba(0,0,0,.25); }
.layout-interactive .result-placeholder { color: var(--muted); font-size: 1.05rem; }
.layout-interactive .result-meta {
  display: block; font-size: .8rem; letter-spacing: .08em; text-transform: uppercase;
  color: var(--accent-2); margin-bottom: .5rem;
}
.layout-interactive .result-title { font-size: 1.75rem; margin-bottom: .5rem; }
.layout-interactive .result-detail { color: var(--muted); max-width: 42ch; }
.layout-interactive #pick-btn { min-width: 220px; margin-bottom: 2rem; }
.layout-interactive .pool-section { text-align: left; margin-top: 1rem; }
.layout-interactive .pool-heading { font-size: .85rem; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); margin-bottom: .75rem; }
.layout-interactive .pool-list { list-style: none; display: grid; gap: .4rem; }
.layout-interactive .pool-list li {
  padding: .55rem .75rem; border-radius: 10px; font-size: .92rem;
  background: color-mix(in srgb, var(--surface) 80%, var(--bg));
  border: 1px solid transparent;
}
.layout-interactive .pool-list li.active {
  border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface));
}
.layout-interactive .pool-meta { color: var(--muted); font-size: .8rem; margin-left: .5rem; }
.layout-interactive .site-footer { text-align: center; margin-top: 0; }
"#;
