//! mcp-server-presentation — MCP tool sidecar for presentation slide synthesis.
//!
//! Reads one JSON-RPC 2.0 request from stdin, generates an `.html` interactive presentation
//! slide deck, and writes one JSON-RPC 2.0 response to stdout, then exits.

use std::io::{self, BufRead};
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use base64::{engine::general_purpose::STANDARD, Engine};

// ─────────────────────────────────────────────────────────────────────────────
// Wire types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: u64,
    params: PresentationPlan,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<ToolResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct ToolResult {
    path: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation plan types (must mirror grammar::schema::PresentationPlan)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum SlideLayout {
    Title,
    Bullet,
    TwoColumn,
    ImageLeft,
    Blank,
    Section,
    Stat,
    Quote,
    Cards,
    Comparison,
    Centered,
}

#[derive(Debug, Deserialize)]
struct PresentationSlide {
    title: String,
    layout: SlideLayout,
    #[serde(default)]
    bullets: Vec<String>,
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PresentationPlan {
    slides: Vec<PresentationSlide>,
    theme: Option<String>,
    output_name: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme registry
// ─────────────────────────────────────────────────────────────────────────────

struct FontSpec {
    css_name: &'static str,
    file: &'static str,
    weight: u32,
}

struct Theme {
    name: &'static str,
    fonts: &'static [FontSpec],
    css_vars: &'static str,
}

const THEME_MIDNIGHT: Theme = Theme {
    name: "midnight",
    fonts: &[
        FontSpec { css_name: "Outfit", file: "Outfit-400.woff2", weight: 400 },
        FontSpec { css_name: "Outfit", file: "Outfit-600.woff2", weight: 600 },
        FontSpec { css_name: "Outfit", file: "Outfit-800.woff2", weight: 800 },
        FontSpec { css_name: "Plus Jakarta Sans", file: "Plus_Jakarta_Sans-300.woff2", weight: 300 },
        FontSpec { css_name: "Plus Jakarta Sans", file: "Plus_Jakarta_Sans-400.woff2", weight: 400 },
        FontSpec { css_name: "Plus Jakarta Sans", file: "Plus_Jakarta_Sans-500.woff2", weight: 500 },
        FontSpec { css_name: "Plus Jakarta Sans", file: "Plus_Jakarta_Sans-700.woff2", weight: 700 },
    ],
    css_vars: r#":root {
  --font-head: 'Outfit', system-ui, sans-serif;
  --font-body: 'Plus Jakarta Sans', system-ui, sans-serif;
  --bg: #0d0d11;
  --surface: #1a1a24;
  --text: #e4e4eb;
  --text-muted: #94a3b8;
  --text-secondary: #cbd5e1;
  --accent-from: #a5b4fc;
  --accent-to: #6366f1;
  --accent-solid: #6366f1;
  --accent-glow: rgba(99, 102, 241, 0.8);
  --border-subtle: rgba(255, 255, 255, 0.08);
  --footer-bg: rgba(13, 13, 17, 0.5);
  --bullet-radius: 50%;
  --mock-image-bg: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(165, 180, 252, 0.05) 100%);
  --section-line: rgba(99, 102, 241, 0.4);
}"#,
};

const THEME_CORPORATE: Theme = Theme {
    name: "corporate",
    fonts: &[
        FontSpec { css_name: "Inter", file: "Inter-400.woff2", weight: 400 },
        FontSpec { css_name: "Inter", file: "Inter-600.woff2", weight: 600 },
        FontSpec { css_name: "Inter", file: "Inter-700.woff2", weight: 700 },
        FontSpec { css_name: "Source Sans 3", file: "Source_Sans_3-300.woff2", weight: 300 },
        FontSpec { css_name: "Source Sans 3", file: "Source_Sans_3-400.woff2", weight: 400 },
        FontSpec { css_name: "Source Sans 3", file: "Source_Sans_3-600.woff2", weight: 600 },
    ],
    css_vars: r#":root {
  --font-head: 'Inter', system-ui, sans-serif;
  --font-body: 'Source Sans 3', system-ui, sans-serif;
  --bg: #0f172a;
  --surface: #1e293b;
  --text: #f1f5f9;
  --text-muted: #94a3b8;
  --text-secondary: #cbd5e1;
  --accent-from: #60a5fa;
  --accent-to: #2563eb;
  --accent-solid: #2563eb;
  --accent-glow: rgba(37, 99, 235, 0.6);
  --border-subtle: rgba(255, 255, 255, 0.12);
  --footer-bg: rgba(15, 23, 42, 0.85);
  --bullet-radius: 2px;
  --mock-image-bg: linear-gradient(135deg, rgba(37, 99, 235, 0.15) 0%, rgba(30, 41, 59, 0.5) 100%);
  --section-line: rgba(37, 99, 235, 0.5);
}"#,
};

const THEME_SUNSET: Theme = Theme {
    name: "sunset",
    fonts: &[
        FontSpec { css_name: "Poppins", file: "Poppins-400.woff2", weight: 400 },
        FontSpec { css_name: "Poppins", file: "Poppins-600.woff2", weight: 600 },
        FontSpec { css_name: "Poppins", file: "Poppins-700.woff2", weight: 700 },
        FontSpec { css_name: "Nunito", file: "Nunito-300.woff2", weight: 300 },
        FontSpec { css_name: "Nunito", file: "Nunito-400.woff2", weight: 400 },
        FontSpec { css_name: "Nunito", file: "Nunito-600.woff2", weight: 600 },
    ],
    css_vars: r#":root {
  --font-head: 'Poppins', system-ui, sans-serif;
  --font-body: 'Nunito', system-ui, sans-serif;
  --bg: #1a0f14;
  --surface: #2d1520;
  --text: #fce7f3;
  --text-muted: #f9a8d4;
  --text-secondary: #fbcfe8;
  --accent-from: #fb923c;
  --accent-to: #f43f5e;
  --accent-solid: #f43f5e;
  --accent-glow: rgba(244, 63, 94, 0.7);
  --border-subtle: rgba(255, 255, 255, 0.1);
  --footer-bg: rgba(26, 15, 20, 0.75);
  --bullet-radius: 50%;
  --mock-image-bg: linear-gradient(135deg, rgba(251, 146, 60, 0.15) 0%, rgba(244, 63, 94, 0.1) 100%);
  --section-line: rgba(251, 146, 60, 0.5);
}"#,
};

const THEME_MINIMAL: Theme = Theme {
    name: "minimal",
    fonts: &[
        FontSpec { css_name: "DM Sans", file: "DM_Sans-400.woff2", weight: 400 },
        FontSpec { css_name: "DM Sans", file: "DM_Sans-500.woff2", weight: 500 },
        FontSpec { css_name: "DM Sans", file: "DM_Sans-700.woff2", weight: 700 },
    ],
    css_vars: r#":root {
  --font-head: 'DM Sans', system-ui, sans-serif;
  --font-body: 'DM Sans', system-ui, sans-serif;
  --bg: #fafafa;
  --surface: #f0f0f0;
  --text: #171717;
  --text-muted: #737373;
  --text-secondary: #404040;
  --accent-from: #404040;
  --accent-to: #171717;
  --accent-solid: #171717;
  --accent-glow: rgba(23, 23, 23, 0.3);
  --border-subtle: rgba(0, 0, 0, 0.08);
  --footer-bg: rgba(250, 250, 250, 0.9);
  --bullet-radius: 50%;
  --mock-image-bg: linear-gradient(135deg, rgba(0, 0, 0, 0.04) 0%, rgba(0, 0, 0, 0.02) 100%);
  --section-line: rgba(0, 0, 0, 0.15);
}"#,
};

const THEME_ACADEMIC: Theme = Theme {
    name: "academic",
    fonts: &[
        FontSpec { css_name: "Libre Baskerville", file: "Libre_Baskerville-400.woff2", weight: 400 },
        FontSpec { css_name: "Libre Baskerville", file: "Libre_Baskerville-700.woff2", weight: 700 },
        FontSpec { css_name: "Source Serif 4", file: "Source_Serif_4-300.woff2", weight: 300 },
        FontSpec { css_name: "Source Serif 4", file: "Source_Serif_4-400.woff2", weight: 400 },
        FontSpec { css_name: "Source Serif 4", file: "Source_Serif_4-600.woff2", weight: 600 },
    ],
    css_vars: r#":root {
  --font-head: 'Libre Baskerville', Georgia, serif;
  --font-body: 'Source Serif 4', Georgia, serif;
  --bg: #f8f5f0;
  --surface: #ede8e0;
  --text: #292524;
  --text-muted: #78716c;
  --text-secondary: #44403c;
  --accent-from: #991b1b;
  --accent-to: #7f1d1d;
  --accent-solid: #7f1d1d;
  --accent-glow: rgba(127, 29, 29, 0.4);
  --border-subtle: rgba(41, 37, 36, 0.12);
  --footer-bg: rgba(248, 245, 240, 0.92);
  --bullet-radius: 0;
  --mock-image-bg: linear-gradient(135deg, rgba(127, 29, 29, 0.08) 0%, rgba(237, 232, 224, 0.8) 100%);
  --section-line: rgba(127, 29, 29, 0.35);
}"#,
};

const THEME_CYBER: Theme = Theme {
    name: "cyber",
    fonts: &[
        FontSpec { css_name: "Orbitron", file: "Orbitron-400.woff2", weight: 400 },
        FontSpec { css_name: "Orbitron", file: "Orbitron-700.woff2", weight: 700 },
        FontSpec { css_name: "Rajdhani", file: "Rajdhani-300.woff2", weight: 300 },
        FontSpec { css_name: "Rajdhani", file: "Rajdhani-500.woff2", weight: 500 },
        FontSpec { css_name: "Rajdhani", file: "Rajdhani-700.woff2", weight: 700 },
    ],
    css_vars: r#":root {
  --font-head: 'Orbitron', monospace;
  --font-body: 'Rajdhani', system-ui, sans-serif;
  --bg: #050508;
  --surface: #0a1628;
  --text: #e0fff4;
  --text-muted: #4ade80;
  --text-secondary: #86efac;
  --accent-from: #22d3ee;
  --accent-to: #10b981;
  --accent-solid: #10b981;
  --accent-glow: rgba(16, 185, 129, 0.8);
  --border-subtle: rgba(34, 211, 238, 0.15);
  --footer-bg: rgba(5, 5, 8, 0.9);
  --bullet-radius: 0;
  --mock-image-bg: linear-gradient(135deg, rgba(34, 211, 238, 0.12) 0%, rgba(16, 185, 129, 0.08) 100%);
  --section-line: rgba(34, 211, 238, 0.6);
}"#,
};

const THEME_OCEAN: Theme = Theme {
    name: "ocean",
    fonts: &[
        FontSpec { css_name: "Montserrat", file: "Montserrat-400.woff2", weight: 400 },
        FontSpec { css_name: "Montserrat", file: "Montserrat-600.woff2", weight: 600 },
        FontSpec { css_name: "Montserrat", file: "Montserrat-800.woff2", weight: 800 },
        FontSpec { css_name: "Open Sans", file: "Open_Sans-300.woff2", weight: 300 },
        FontSpec { css_name: "Open Sans", file: "Open_Sans-400.woff2", weight: 400 },
        FontSpec { css_name: "Open Sans", file: "Open_Sans-600.woff2", weight: 600 },
    ],
    css_vars: r#":root {
  --font-head: 'Montserrat', system-ui, sans-serif;
  --font-body: 'Open Sans', system-ui, sans-serif;
  --bg: #0c1929;
  --surface: #0f2847;
  --text: #e0f2fe;
  --text-muted: #7dd3fc;
  --text-secondary: #bae6fd;
  --accent-from: #38bdf8;
  --accent-to: #0284c7;
  --accent-solid: #0284c7;
  --accent-glow: rgba(2, 132, 199, 0.7);
  --border-subtle: rgba(56, 189, 248, 0.12);
  --footer-bg: rgba(12, 25, 41, 0.85);
  --bullet-radius: 50%;
  --mock-image-bg: linear-gradient(135deg, rgba(56, 189, 248, 0.15) 0%, rgba(2, 132, 199, 0.08) 100%);
  --section-line: rgba(56, 189, 248, 0.5);
}"#,
};

const THEME_FOREST: Theme = Theme {
    name: "forest",
    fonts: &[
        FontSpec { css_name: "Merriweather", file: "Merriweather-400.woff2", weight: 400 },
        FontSpec { css_name: "Merriweather", file: "Merriweather-700.woff2", weight: 700 },
        FontSpec { css_name: "Lato", file: "Lato-300.woff2", weight: 300 },
        FontSpec { css_name: "Lato", file: "Lato-400.woff2", weight: 400 },
        FontSpec { css_name: "Lato", file: "Lato-700.woff2", weight: 700 },
    ],
    css_vars: r#":root {
  --font-head: 'Merriweather', Georgia, serif;
  --font-body: 'Lato', system-ui, sans-serif;
  --bg: #0a1f0a;
  --surface: #142814;
  --text: #ecfdf5;
  --text-muted: #86efac;
  --text-secondary: #bbf7d0;
  --accent-from: #4ade80;
  --accent-to: #15803d;
  --accent-solid: #15803d;
  --accent-glow: rgba(21, 128, 61, 0.7);
  --border-subtle: rgba(74, 222, 128, 0.12);
  --footer-bg: rgba(10, 31, 10, 0.85);
  --bullet-radius: 50%;
  --mock-image-bg: linear-gradient(135deg, rgba(74, 222, 128, 0.12) 0%, rgba(21, 128, 61, 0.08) 100%);
  --section-line: rgba(74, 222, 128, 0.45);
}"#,
};

const THEME_LAVENDER: Theme = Theme {
    name: "lavender",
    fonts: &[
        FontSpec { css_name: "Playfair Display", file: "Playfair_Display-400.woff2", weight: 400 },
        FontSpec { css_name: "Playfair Display", file: "Playfair_Display-700.woff2", weight: 700 },
        FontSpec { css_name: "Raleway", file: "Raleway-300.woff2", weight: 300 },
        FontSpec { css_name: "Raleway", file: "Raleway-400.woff2", weight: 400 },
        FontSpec { css_name: "Raleway", file: "Raleway-600.woff2", weight: 600 },
    ],
    css_vars: r#":root {
  --font-head: 'Playfair Display', Georgia, serif;
  --font-body: 'Raleway', system-ui, sans-serif;
  --bg: #1a0f2e;
  --surface: #2d1b4e;
  --text: #f3e8ff;
  --text-muted: #c4b5fd;
  --text-secondary: #ddd6fe;
  --accent-from: #c084fc;
  --accent-to: #7c3aed;
  --accent-solid: #7c3aed;
  --accent-glow: rgba(124, 58, 237, 0.7);
  --border-subtle: rgba(192, 132, 252, 0.12);
  --footer-bg: rgba(26, 15, 46, 0.85);
  --bullet-radius: 50%;
  --mock-image-bg: linear-gradient(135deg, rgba(192, 132, 252, 0.15) 0%, rgba(124, 58, 237, 0.08) 100%);
  --section-line: rgba(192, 132, 252, 0.5);
}"#,
};

const THEME_NEON: Theme = Theme {
    name: "neon",
    fonts: &[
        FontSpec { css_name: "Bebas Neue", file: "Bebas_Neue-400.woff2", weight: 400 },
        FontSpec { css_name: "Roboto", file: "Roboto-300.woff2", weight: 300 },
        FontSpec { css_name: "Roboto", file: "Roboto-400.woff2", weight: 400 },
        FontSpec { css_name: "Roboto", file: "Roboto-700.woff2", weight: 700 },
    ],
    css_vars: r#":root {
  --font-head: 'Bebas Neue', Impact, sans-serif;
  --font-body: 'Roboto', system-ui, sans-serif;
  --bg: #0a0a0a;
  --surface: #1a1a2e;
  --text: #ffffff;
  --text-muted: #f0abfc;
  --text-secondary: #e879f9;
  --accent-from: #f0abfc;
  --accent-to: #06b6d4;
  --accent-solid: #06b6d4;
  --accent-glow: rgba(6, 182, 212, 0.9);
  --border-subtle: rgba(240, 171, 252, 0.15);
  --footer-bg: rgba(10, 10, 10, 0.9);
  --bullet-radius: 0;
  --mock-image-bg: linear-gradient(135deg, rgba(240, 171, 252, 0.2) 0%, rgba(6, 182, 212, 0.15) 100%);
  --section-line: rgba(6, 182, 212, 0.7);
}"#,
};

const THEME_ROSE: Theme = Theme {
    name: "rose",
    fonts: &[
        FontSpec { css_name: "Cormorant Garamond", file: "Cormorant_Garamond-400.woff2", weight: 400 },
        FontSpec { css_name: "Cormorant Garamond", file: "Cormorant_Garamond-600.woff2", weight: 600 },
        FontSpec { css_name: "Cormorant Garamond", file: "Cormorant_Garamond-700.woff2", weight: 700 },
        FontSpec { css_name: "Josefin Sans", file: "Josefin_Sans-300.woff2", weight: 300 },
        FontSpec { css_name: "Josefin Sans", file: "Josefin_Sans-400.woff2", weight: 400 },
        FontSpec { css_name: "Josefin Sans", file: "Josefin_Sans-600.woff2", weight: 600 },
    ],
    css_vars: r#":root {
  --font-head: 'Cormorant Garamond', Georgia, serif;
  --font-body: 'Josefin Sans', system-ui, sans-serif;
  --bg: #1c0a14;
  --surface: #3d1228;
  --text: #fce7f3;
  --text-muted: #f9a8d4;
  --text-secondary: #fbcfe8;
  --accent-from: #fda4af;
  --accent-to: #e11d48;
  --accent-solid: #e11d48;
  --accent-glow: rgba(225, 29, 72, 0.7);
  --border-subtle: rgba(253, 164, 175, 0.12);
  --footer-bg: rgba(28, 10, 20, 0.85);
  --bullet-radius: 50%;
  --mock-image-bg: linear-gradient(135deg, rgba(253, 164, 175, 0.15) 0%, rgba(225, 29, 72, 0.1) 100%);
  --section-line: rgba(253, 164, 175, 0.5);
}"#,
};

const THEME_SLATE: Theme = Theme {
    name: "slate",
    fonts: &[
        FontSpec { css_name: "IBM Plex Sans", file: "IBM_Plex_Sans-400.woff2", weight: 400 },
        FontSpec { css_name: "IBM Plex Sans", file: "IBM_Plex_Sans-600.woff2", weight: 600 },
        FontSpec { css_name: "IBM Plex Sans", file: "IBM_Plex_Sans-700.woff2", weight: 700 },
        FontSpec { css_name: "IBM Plex Mono", file: "IBM_Plex_Mono-400.woff2", weight: 400 },
        FontSpec { css_name: "IBM Plex Mono", file: "IBM_Plex_Mono-500.woff2", weight: 500 },
    ],
    css_vars: r#":root {
  --font-head: 'IBM Plex Sans', system-ui, sans-serif;
  --font-body: 'IBM Plex Mono', monospace;
  --bg: #18181b;
  --surface: #27272a;
  --text: #fafafa;
  --text-muted: #a1a1aa;
  --text-secondary: #d4d4d8;
  --accent-from: #a1a1aa;
  --accent-to: #52525b;
  --accent-solid: #71717a;
  --accent-glow: rgba(113, 113, 122, 0.5);
  --border-subtle: rgba(255, 255, 255, 0.08);
  --footer-bg: rgba(24, 24, 27, 0.9);
  --bullet-radius: 2px;
  --mock-image-bg: linear-gradient(135deg, rgba(161, 161, 170, 0.1) 0%, rgba(82, 82, 91, 0.08) 100%);
  --section-line: rgba(161, 161, 170, 0.4);
}"#,
};

const ALL_THEMES: &[&Theme] = &[
    &THEME_MIDNIGHT,
    &THEME_CORPORATE,
    &THEME_SUNSET,
    &THEME_MINIMAL,
    &THEME_ACADEMIC,
    &THEME_CYBER,
    &THEME_OCEAN,
    &THEME_FOREST,
    &THEME_LAVENDER,
    &THEME_NEON,
    &THEME_ROSE,
    &THEME_SLATE,
];

fn compute_seed(slides: &[PresentationSlide]) -> u64 {
    let mut hash: u64 = 5381;
    for slide in slides {
        for b in slide.title.bytes() {
            hash = hash.wrapping_mul(33).wrapping_add(b as u64);
        }
        for bullet in &slide.bullets {
            for b in bullet.bytes() {
                hash = hash.wrapping_mul(33).wrapping_add(b as u64);
            }
        }
    }
    hash.wrapping_add(slides.len() as u64 * 7919)
}

fn theme_by_name(name: &str) -> Option<&'static Theme> {
    let lower = name.trim().to_lowercase();
    match lower.as_str() {
        "corporate" | "business" | "professional" => Some(&THEME_CORPORATE),
        "sunset" | "warm" | "vibrant" => Some(&THEME_SUNSET),
        "minimal" | "clean" | "simple" | "light" => Some(&THEME_MINIMAL),
        "academic" | "research" | "serif" => Some(&THEME_ACADEMIC),
        "cyber" | "tech" | "hacker" | "matrix" => Some(&THEME_CYBER),
        "ocean" | "blue" | "aqua" | "marine" => Some(&THEME_OCEAN),
        "forest" | "green" | "nature" | "eco" => Some(&THEME_FOREST),
        "lavender" | "purple" | "violet" => Some(&THEME_LAVENDER),
        "neon" | "bright" | "electric" => Some(&THEME_NEON),
        "rose" | "pink" | "elegant" => Some(&THEME_ROSE),
        "slate" | "gray" | "grey" | "mono" => Some(&THEME_SLATE),
        "midnight" | "dark" | "default" => Some(&THEME_MIDNIGHT),
        _ => ALL_THEMES.iter().find(|t| t.name == lower).copied(),
    }
}

fn resolve_theme(name: Option<&str>, seed: u64) -> &'static Theme {
    if let Some(n) = name {
        if let Some(theme) = theme_by_name(n) {
            return theme;
        }
    }
    ALL_THEMES[(seed as usize) % ALL_THEMES.len()]
}

/// Content layouts rotated so consecutive slides never repeat the same structure.
const CONTENT_POOL: [SlideLayout; 8] = [
    SlideLayout::Bullet,
    SlideLayout::TwoColumn,
    SlideLayout::ImageLeft,
    SlideLayout::Stat,
    SlideLayout::Quote,
    SlideLayout::Cards,
    SlideLayout::Comparison,
    SlideLayout::Centered,
];

/// Decide the final layout for every slide.
///
/// The model chooses a layout per slide based on the actual content, so we
/// honor those choices — that is what makes each design fit the content. We
/// only fall back to deterministic variety when the model produced a
/// degenerate deck (e.g. nearly every slide is a plain BULLET list), which is
/// exactly the "everything looks like a list" failure mode we want to avoid.
fn resolve_layouts(slides: &[PresentationSlide], seed: u64) -> Vec<SlideLayout> {
    let total = slides.len();
    if total == 0 {
        return vec![];
    }

    let chosen: Vec<SlideLayout> = slides.iter().map(|s| s.layout).collect();

    // Variety metrics across the whole deck.
    let mut distinct: Vec<SlideLayout> = Vec::new();
    for &l in &chosen {
        if !distinct.contains(&l) {
            distinct.push(l);
        }
    }
    let bullet_count = chosen.iter().filter(|&&l| l == SlideLayout::Bullet).count();

    // Monotonous if there's almost no structural variety or it's mostly plain
    // bullet lists. Tiny decks (1-2 slides) are exempt.
    let monotonous = total >= 3
        && (distinct.len() <= 2 || bullet_count * 100 / total > 55);

    if monotonous {
        return assign_layouts(total, seed);
    }

    let mut layouts = chosen;
    // Always lead with a proper cover slide.
    layouts[0] = SlideLayout::Title;
    layouts
}

fn assign_layouts(total: usize, seed: u64) -> Vec<SlideLayout> {
    if total == 0 {
        return vec![];
    }
    let mut layouts = vec![SlideLayout::Bullet; total];
    layouts[0] = SlideLayout::Title;

    if total == 1 {
        return layouts;
    }

    // Closing slide — rotate between dramatic layouts
    layouts[total - 1] = match seed % 4 {
        0 => SlideLayout::Stat,
        1 => SlideLayout::Section,
        2 => SlideLayout::Centered,
        _ => SlideLayout::Quote,
    };

    if total == 2 {
        return layouts;
    }

    let mut pool_idx = (seed as usize) % CONTENT_POOL.len();
    let mut prev = SlideLayout::Title;

    for i in 1..total - 1 {
        let mut picked = CONTENT_POOL[pool_idx % CONTENT_POOL.len()];
        let mut attempts = 0;
        while picked == prev && attempts < CONTENT_POOL.len() {
            pool_idx += 1;
            picked = CONTENT_POOL[pool_idx % CONTENT_POOL.len()];
            attempts += 1;
        }
        layouts[i] = picked;
        prev = picked;
        pool_idx += 1;
    }

    layouts
}

fn layout_class(layout: SlideLayout) -> &'static str {
    match layout {
        SlideLayout::Title => "layout-title",
        SlideLayout::Bullet => "layout-bullet",
        SlideLayout::TwoColumn => "layout-twocolumn",
        SlideLayout::ImageLeft => "layout-imageleft",
        SlideLayout::Blank => "layout-blank",
        SlideLayout::Section => "layout-section",
        SlideLayout::Stat => "layout-stat",
        SlideLayout::Quote => "layout-quote",
        SlideLayout::Cards => "layout-cards",
        SlideLayout::Comparison => "layout-comparison",
        SlideLayout::Centered => "layout-centered",
    }
}

const BASE_CSS: &str = r#"
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: var(--font-body);
            background-color: var(--bg);
            color: var(--text);
            overflow: hidden;
            height: 100vh;
            width: 100vw;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
        }
        .deck-container {
            position: relative;
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            background: radial-gradient(circle at top left, var(--surface) 0%, var(--bg) 100%);
        }
        .slides-wrapper {
            position: relative;
            flex-grow: 1;
            width: 100%;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        /* Fixed reference canvas; scaled to fit by JS so everything stays
           proportional whether inline or fullscreen. */
        .slide-stage {
            position: relative;
            width: 1280px;
            height: 720px;
            flex-shrink: 0;
            transform-origin: center center;
        }
        .slide {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.6s cubic-bezier(0.25, 1, 0.5, 1), transform 0.6s cubic-bezier(0.25, 1, 0.5, 1);
            transform: scale(0.98) translateY(10px);
            padding: 6% 8%;
            display: flex;
            flex-direction: column;
            justify-content: center;
            z-index: 1;
        }
        .slide.active {
            opacity: 1;
            visibility: visible;
            transform: scale(1) translateY(0);
            z-index: 10;
        }

        h1, h2, h3 {
            font-family: var(--font-head);
            font-weight: 800;
        }

        .title-gradient {
            background: linear-gradient(135deg, var(--accent-from) 0%, var(--accent-to) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .layout-title {
            align-items: center;
            text-align: center;
            gap: 24px;
        }
        .layout-title h1 {
            font-size: 4.5rem;
            line-height: 1.15;
            letter-spacing: -0.03em;
        }
        .layout-title p {
            font-size: 1.8rem;
            color: var(--text-muted);
            font-weight: 300;
            max-width: 800px;
        }

        .layout-bullet, .layout-twocolumn, .layout-imageleft, .layout-stat,
        .layout-quote, .layout-cards, .layout-comparison, .layout-centered {
            justify-content: flex-start;
            gap: 30px;
        }
        .slide-header {
            border-bottom: 1px solid var(--border-subtle);
            padding-bottom: 20px;
            margin-bottom: 10px;
        }
        .slide-header h2 {
            font-size: 3rem;
            letter-spacing: -0.02em;
        }

        .bullets-list {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        .bullets-list li {
            font-size: 1.5rem;
            line-height: 1.5;
            color: var(--text-secondary);
            position: relative;
            padding-left: 35px;
        }
        .bullets-list li::before {
            content: "";
            position: absolute;
            left: 10px;
            top: 12px;
            width: 8px;
            height: 8px;
            background-color: var(--accent-solid);
            border-radius: var(--bullet-radius);
            box-shadow: 0 0 10px var(--accent-glow);
        }

        .two-column-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 50px;
            height: 100%;
        }

        .image-left-grid {
            display: grid;
            grid-template-columns: 4fr 5fr;
            gap: 50px;
            align-items: center;
            height: 100%;
        }
        .mock-image {
            background: var(--mock-image-bg);
            border: 1px solid var(--border-subtle);
            border-radius: 16px;
            height: 320px;
            display: flex;
            justify-content: center;
            align-items: center;
            position: relative;
            overflow: hidden;
        }
        .mock-image::after {
            content: "Visual Panel";
            font-family: var(--font-head);
            color: var(--accent-from);
            font-size: 1.2rem;
            font-weight: 600;
        }

        .layout-section {
            align-items: center;
            text-align: center;
            gap: 20px;
        }
        .section-line {
            width: 80px;
            height: 4px;
            background: linear-gradient(90deg, var(--accent-from), var(--accent-to));
            border-radius: 2px;
        }
        .layout-section h2 {
            font-size: 3.5rem;
            letter-spacing: -0.02em;
        }
        .layout-section p {
            font-size: 1.4rem;
            color: var(--text-muted);
            max-width: 700px;
        }

        .stat-value {
            font-family: var(--font-head);
            font-size: 6rem;
            font-weight: 800;
            line-height: 1;
            letter-spacing: -0.03em;
        }
        .stat-label {
            font-size: 1.6rem;
            color: var(--text-muted);
            margin-top: 12px;
        }
        .layout-stat .bullets-list {
            margin-top: 20px;
        }

        .layout-blank h3 {
            font-size: 2rem;
            color: var(--text-muted);
        }

        /* ── Per-slide visual variety (max) ─────────────────────────────── */
        .slide > * { position: relative; z-index: 1; }
        .slide::before {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            z-index: 0;
            opacity: 0.55;
        }
        .slide::after {
            content: attr(data-num);
            position: absolute;
            top: -4%;
            right: 1%;
            font-family: var(--font-head);
            font-weight: 800;
            font-size: 20rem;
            line-height: 1;
            color: var(--accent-solid);
            opacity: 0.07;
            pointer-events: none;
            z-index: 0;
        }
        .bg-0::before { background: transparent; }
        .bg-1::before { background: linear-gradient(135deg, var(--surface) 0%, transparent 60%); }
        .bg-2::before { background: radial-gradient(circle at 95% 10%, var(--surface) 0%, transparent 50%); }
        .bg-3::before { background: linear-gradient(225deg, var(--surface) 0%, transparent 55%); }
        .bg-4::before { background: radial-gradient(ellipse at 10% 90%, var(--surface) 0%, transparent 45%); }

        .accent-0 .title-gradient, .accent-0 .stat-value, .accent-0 .section-line,
        .accent-0 .bullets-list li::before, .accent-0 .mock-image, .accent-0 .card-box,
        .accent-0 .compare-side, .accent-0::after { filter: none; }
        .accent-1 .title-gradient, .accent-1 .stat-value, .accent-1 .section-line,
        .accent-1 .bullets-list li::before, .accent-1 .mock-image, .accent-1 .card-box,
        .accent-1 .compare-side, .accent-1::after { filter: hue-rotate(55deg) saturate(1.15); }
        .accent-2 .title-gradient, .accent-2 .stat-value, .accent-2 .section-line,
        .accent-2 .bullets-list li::before, .accent-2 .mock-image, .accent-2 .card-box,
        .accent-2 .compare-side, .accent-2::after { filter: hue-rotate(-60deg) saturate(1.2); }
        .accent-3 .title-gradient, .accent-3 .stat-value, .accent-3 .section-line,
        .accent-3 .bullets-list li::before, .accent-3 .mock-image, .accent-3 .card-box,
        .accent-3 .compare-side, .accent-3::after { filter: hue-rotate(120deg) saturate(1.1); }
        .accent-4 .title-gradient, .accent-4 .stat-value, .accent-4 .section-line,
        .accent-4 .bullets-list li::before, .accent-4 .mock-image, .accent-4 .card-box,
        .accent-4 .compare-side, .accent-4::after { filter: hue-rotate(-120deg) brightness(1.08); }

        /* Quote layout */
        .layout-quote { align-items: center; text-align: center; gap: 28px; padding: 8% 12%; }
        .quote-mark { font-size: 5rem; line-height: 1; color: var(--accent-from); opacity: 0.5; font-family: var(--font-head); }
        .quote-text { font-size: 2.2rem; line-height: 1.45; font-style: italic; color: var(--text); max-width: 900px; }
        .quote-attr { font-size: 1.3rem; color: var(--text-muted); }

        /* Cards layout */
        .cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; width: 100%; }
        .card-box {
            background: var(--mock-image-bg);
            border: 1px solid var(--border-subtle);
            border-radius: 14px;
            padding: 24px;
            font-size: 1.15rem;
            color: var(--text-secondary);
            line-height: 1.45;
        }
        .card-box strong { display: block; font-family: var(--font-head); color: var(--text); margin-bottom: 8px; font-size: 1.05em; }

        /* Comparison layout */
        .compare-grid { display: grid; grid-template-columns: 1fr auto 1fr; gap: 24px; align-items: stretch; width: 100%; flex: 1; }
        .compare-side {
            background: var(--mock-image-bg);
            border: 1px solid var(--border-subtle);
            border-radius: 14px;
            padding: 28px;
        }
        .compare-side h3 { font-size: 1.6rem; margin-bottom: 16px; }
        .compare-vs {
            display: flex; align-items: center; justify-content: center;
            font-family: var(--font-head); font-weight: 800; font-size: 1.4rem;
            color: var(--accent-from);
        }

        /* Centered layout */
        .layout-centered { align-items: center; text-align: center; gap: 24px; }
        .layout-centered h2 { font-size: 3.8rem; letter-spacing: -0.02em; }
        .layout-centered p { font-size: 1.5rem; color: var(--text-muted); max-width: 750px; line-height: 1.5; }

        .deck-footer {
            padding: 24px 40px;
            background: var(--footer-bg);
            backdrop-filter: blur(10px);
            border-top: 1px solid var(--border-subtle);
            display: flex;
            justify-content: space-between;
            align-items: center;
            z-index: 100;
        }
        .controls {
            display: flex;
            gap: 12px;
        }
        .btn {
            background: var(--border-subtle);
            border: 1px solid var(--border-subtle);
            color: var(--text-secondary);
            padding: 8px 16px;
            border-radius: 8px;
            cursor: pointer;
            font-family: inherit;
            font-weight: 500;
            font-size: 0.9rem;
            transition: all 0.2s ease;
        }
        .btn:hover {
            color: var(--text);
            border-color: var(--accent-solid);
        }
        .btn-icon {
            padding: 8px 12px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .btn-icon svg { display: block; }
        .progress-bar-container {
            flex-grow: 1;
            margin: 0 40px;
            height: 4px;
            background: var(--border-subtle);
            border-radius: 2px;
            position: relative;
            overflow: hidden;
        }
        .progress-bar {
            height: 100%;
            background: linear-gradient(90deg, var(--accent-to), var(--accent-from));
            width: 0%;
            transition: width 0.3s ease;
        }
        .slide-counter {
            font-size: 0.9rem;
            color: var(--text-muted);
            font-weight: 500;
        }

        /* ── Export mode ────────────────────────────────────────────────────
           Toggled by the exporter while rasterizing each slide. Disables the
           slide enter animation so each frame is captured fully painted and at
           full opacity; all theme styling (backgrounds, gradients) is kept. */
        .exporting .slide {
            transition: none !important;
            animation: none !important;
        }
        .exporting .slide.active {
            opacity: 1 !important;
            visibility: visible !important;
            transform: none !important;
        }
"#;

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

fn main() {
    let stdin = io::stdin();
    let mut line = String::new();
    if let Err(e) = stdin.lock().read_line(&mut line) {
        write_error(0, -32700, &format!("Failed to read stdin: {e}"));
        std::process::exit(1);
    }

    let line = line.trim();
    if line.is_empty() {
        write_error(0, -32700, "Empty request");
        std::process::exit(1);
    }

    let raw: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            write_error(0, -32700, &format!("JSON parse error: {e}"));
            std::process::exit(1);
        }
    };

    let id = raw["id"].as_u64().unwrap_or(0);

    let plan: PresentationPlan = match serde_json::from_value(raw["params"].clone()) {
        Ok(p) => p,
        Err(e) => {
            write_error(id, -32602, &format!("Invalid presentation plan: {e}"));
            std::process::exit(1);
        }
    };

    match generate_html(plan) {
        Ok(path) => {
            let resp = JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(ToolResult {
                    path: path.to_string_lossy().to_string(),
                    kind: "html".to_string(),
                    warning: None,
                }),
                error: None,
            };
            println!("{}", serde_json::to_string(&resp).unwrap());
        }
        Err(e) => {
            write_error(id, -32603, &e);
            std::process::exit(1);
        }
    }
}

fn write_error(id: u64, code: i32, message: &str) {
    let resp = JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: None,
        error: Some(JsonRpcError {
            code,
            message: message.to_string(),
        }),
    };
    eprintln!("mcp-server-presentation error: {message}");
    println!("{}", serde_json::to_string(&resp).unwrap_or_default());
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Locate the bundled `fonts/` directory containing the theme woff2 files.
///
/// Mirrors `paths::candidate_bin_dirs` but standalone (the sidecar is a
/// self-contained binary). Searches production resource dirs and dev ancestors.
/// Returns `None` when fonts aren't found — callers fall back to system fonts.
fn resolve_fonts_dir() -> Option<PathBuf> {
    // Explicit override (set by the host app when spawning the sidecar).
    if let Ok(dir) = std::env::var("NELA_FONTS_DIR") {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return Some(p);
        }
    }

    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    let mut candidates: Vec<PathBuf> = Vec::new();

    // Production resource layouts
    if cfg!(target_os = "linux") {
        candidates.push(exe_dir.join("..").join("lib").join("NELA").join("fonts"));
    }
    if cfg!(target_os = "macos") {
        candidates.push(exe_dir.join("..").join("Resources").join("fonts"));
    }
    if cfg!(windows) {
        candidates.push(exe_dir.join("fonts"));
    }

    // Dev / generic ancestor walk: <ancestor>/{fonts, src-tauri/fonts}
    for ancestor in exe.ancestors() {
        candidates.push(ancestor.join("fonts"));
        candidates.push(ancestor.join("src-tauri").join("fonts"));
    }

    candidates.into_iter().find(|p| p.is_dir())
}

/// Build inlined `@font-face` rules (base64 woff2 data URIs) for a theme's
/// fonts, so the deck renders correctly inside the sandboxed blob iframe with
/// no network access. Missing files are skipped (system fallback applies).
fn build_font_faces(theme: &Theme, fonts_dir: Option<&PathBuf>) -> String {
    let dir = match fonts_dir {
        Some(d) => d,
        None => return String::new(),
    };
    let mut css = String::new();
    for f in theme.fonts {
        let path = dir.join(f.file);
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let b64 = STANDARD.encode(&bytes);
        css.push_str(&format!(
            "@font-face {{ font-family: '{name}'; font-style: normal; font-weight: {weight}; font-display: swap; src: url(data:font/woff2;base64,{b64}) format('woff2'); }}\n",
            name = f.css_name,
            weight = f.weight,
            b64 = b64,
        ));
    }
    css
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML generation
// ─────────────────────────────────────────────────────────────────────────────

fn generate_html(plan: PresentationPlan) -> Result<PathBuf, String> {
    let output_name = plan.output_name.as_deref().unwrap_or("nela_presentation");
    let out_dir = std::env::temp_dir().join("nela_artifacts");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Create output dir: {e}"))?;
    let path = out_dir.join(format!("{output_name}.html"));

    let seed = compute_seed(&plan.slides);
    let theme = resolve_theme(plan.theme.as_deref(), seed);
    let slides_html = render_slides(&plan.slides, seed);
    let theme_class = theme.name;

    // Embed the theme's fonts as base64 @font-face so the deck renders offline
    // inside the sandboxed blob iframe (no network / asset-protocol access).
    let fonts_dir = resolve_fonts_dir();
    let font_faces = build_font_faces(theme, fonts_dir.as_ref());
    let fonts_tag = format!("    <style>\n{font_faces}    </style>");

    let html_content = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Presentation</title>
{fonts_tag}
    <style>
{css_vars}
{base_css}
    </style>
</head>
<body class="theme-{theme_class}">
    <div class="deck-container">
        <div class="slides-wrapper">
            <div class="slide-stage" id="stage">
            {slides_html}
            </div>
        </div>
        <div class="deck-footer">
            <div class="slide-counter" id="counter">1 / 1</div>
            <div class="progress-bar-container">
                <div class="progress-bar" id="progress"></div>
            </div>
            <div class="controls">
                <button class="btn" onclick="prevSlide()">Prev</button>
                <button class="btn" onclick="nextSlide()">Next</button>
                <button class="btn btn-icon" id="fsBtn" onclick="toggleFullscreen()" title="Toggle fullscreen" aria-label="Toggle fullscreen"><svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg></button>
            </div>
        </div>
    </div>

    <script>
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        const totalSlides = slides.length;
        const counterEl = document.getElementById('counter');
        const progressEl = document.getElementById('progress');

        function showSlide(idx) {{
            if (idx < 0 || idx >= totalSlides) return;
            slides[currentSlide].classList.remove('active');
            currentSlide = idx;
            slides[currentSlide].classList.add('active');

            counterEl.innerText = `${{currentSlide + 1}} / ${{totalSlides}}`;
            progressEl.style.width = `${{((currentSlide + 1) / totalSlides) * 100}}%`;
        }}

        function nextSlide() {{
            if (currentSlide < totalSlides - 1) {{
                showSlide(currentSlide + 1);
            }}
        }}

        function prevSlide() {{
            if (currentSlide > 0) {{
                showSlide(currentSlide - 1);
            }}
        }}

        document.addEventListener('keydown', (e) => {{
            if (e.key === 'ArrowRight' || e.key === 'Space' || e.key === 'PageDown') {{
                nextSlide();
            }} else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {{
                prevSlide();
            }}
        }});

        // Scale the fixed 1280x720 stage to fit its container, so text and
        // layout stay perfectly proportional at any size (inline or fullscreen).
        const STAGE_W = 1280, STAGE_H = 720;
        const stageEl = document.getElementById('stage');
        function fitStage() {{
            const wrap = stageEl.parentElement;
            const scale = Math.min(wrap.clientWidth / STAGE_W, wrap.clientHeight / STAGE_H);
            stageEl.style.transform = `scale(${{scale}})`;
        }}
        window.addEventListener('resize', fitStage);
        if (window.ResizeObserver) {{
            new ResizeObserver(fitStage).observe(stageEl.parentElement);
        }}

        // Fullscreen toggle lives in the footer controls, beside Next.
        const fsBtn = document.getElementById('fsBtn');
        const EXPAND_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';
        const COMPRESS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';
        function toggleFullscreen() {{
            if (document.fullscreenElement) {{
                document.exitFullscreen();
            }} else {{
                document.documentElement.requestFullscreen().catch(function(){{}});
            }}
        }}
        document.addEventListener('fullscreenchange', function() {{
            fitStage();
            fsBtn.innerHTML = document.fullscreenElement ? COMPRESS_SVG : EXPAND_SVG;
        }});

        showSlide(0);
        fitStage();
    </script>
</body>
</html>"#,
        theme_class = theme_class,
        fonts_tag = fonts_tag,
        css_vars = theme.css_vars,
        base_css = BASE_CSS,
        slides_html = slides_html
    );

    std::fs::write(&path, html_content)
        .map_err(|e| format!("Failed to write presentation HTML: {e}"))?;

    Ok(path)
}

fn render_slides(slides: &[PresentationSlide], seed: u64) -> String {
    let assigned = resolve_layouts(slides, seed);
    let mut html = String::new();

    for (i, slide) in slides.iter().enumerate() {
        let layout = assigned[i];
        let active_class = if i == 0 { "active" } else { "" };
        let layout_class = layout_class(layout);
        let accent_class = format!("accent-{}", i % 5);
        let bg_class = format!("bg-{}", i % 5);
        let num = i + 1;

        html.push_str(&format!(
            r#"<div class="slide {active_class} {layout_class} {accent_class} {bg_class}" data-num="{num}">"#
        ));

        let title = escape_html(&slide.title);
        let bullets: Vec<String> = slide.bullets.iter().map(|b| escape_html(b)).collect();

        match layout {
            SlideLayout::Title => {
                html.push_str(&format!(r#"<h1 class="title-gradient">{title}</h1>"#));
                if let Some(subtitle) = bullets.first() {
                    html.push_str(&format!(r#"<p>{subtitle}</p>"#));
                }
            }
            SlideLayout::Bullet => {
                html.push_str(&format!(
                    r#"<div class="slide-header"><h2 class="title-gradient">{title}</h2></div>"#
                ));
                html.push_str(r#"<ul class="bullets-list">"#);
                for bullet in &bullets {
                    html.push_str(&format!("<li>{bullet}</li>"));
                }
                html.push_str("</ul>");
            }
            SlideLayout::TwoColumn => {
                html.push_str(&format!(
                    r#"<div class="slide-header"><h2 class="title-gradient">{title}</h2></div>"#
                ));
                html.push_str(r#"<div class="two-column-grid">"#);
                let mid = (bullets.len() + 1) / 2;
                html.push_str(r#"<ul class="bullets-list">"#);
                for bullet in &bullets[..mid.min(bullets.len())] {
                    html.push_str(&format!("<li>{bullet}</li>"));
                }
                html.push_str("</ul>");
                html.push_str(r#"<ul class="bullets-list">"#);
                for bullet in &bullets[mid..] {
                    html.push_str(&format!("<li>{bullet}</li>"));
                }
                html.push_str("</ul></div>");
            }
            SlideLayout::ImageLeft => {
                html.push_str(&format!(
                    r#"<div class="slide-header"><h2 class="title-gradient">{title}</h2></div>"#
                ));
                html.push_str(r#"<div class="image-left-grid"><div class="mock-image"></div><ul class="bullets-list">"#);
                for bullet in &bullets {
                    html.push_str(&format!("<li>{bullet}</li>"));
                }
                html.push_str("</ul></div>");
            }
            SlideLayout::Section => {
                html.push_str(r#"<div class="section-line"></div>"#);
                html.push_str(&format!(r#"<h2 class="title-gradient">{title}</h2>"#));
                if let Some(subtitle) = bullets.first() {
                    html.push_str(&format!(r#"<p>{subtitle}</p>"#));
                }
            }
            SlideLayout::Stat => {
                let stat_value = bullets.first().map(|s| s.as_str()).unwrap_or(title.as_str());
                html.push_str(&format!(
                    r#"<div class="stat-value title-gradient">{stat_value}</div>"#
                ));
                if !bullets.is_empty() {
                    html.push_str(&format!(r#"<div class="stat-label">{title}</div>"#));
                }
                if bullets.len() > 1 {
                    html.push_str(r#"<ul class="bullets-list">"#);
                    for bullet in &bullets[1..] {
                        html.push_str(&format!("<li>{bullet}</li>"));
                    }
                    html.push_str("</ul>");
                }
            }
            SlideLayout::Quote => {
                let quote = bullets.first().map(|s| s.as_str()).unwrap_or(title.as_str());
                let attr = bullets.get(1).map(|s| s.as_str()).unwrap_or(title.as_str());
                html.push_str(r#"<div class="quote-mark">"</div>"#);
                html.push_str(&format!(r#"<p class="quote-text">{quote}</p>"#));
                html.push_str(&format!(r#"<p class="quote-attr">— {attr}</p>"#));
            }
            SlideLayout::Cards => {
                html.push_str(&format!(
                    r#"<div class="slide-header"><h2 class="title-gradient">{title}</h2></div>"#
                ));
                html.push_str(r#"<div class="cards-grid">"#);
                for bullet in &bullets {
                    if let Some((head, body)) = bullet.split_once(": ") {
                        html.push_str(&format!(
                            r#"<div class="card-box"><strong>{head}</strong>{body}</div>"#
                        ));
                    } else {
                        html.push_str(&format!(r#"<div class="card-box">{bullet}</div>"#));
                    }
                }
                html.push_str("</div>");
            }
            SlideLayout::Comparison => {
                html.push_str(&format!(
                    r#"<div class="slide-header"><h2 class="title-gradient">{title}</h2></div>"#
                ));
                let mid = (bullets.len() + 1) / 2;
                html.push_str(r#"<div class="compare-grid">"#);
                html.push_str(r#"<div class="compare-side"><h3 class="title-gradient">Option A</h3><ul class="bullets-list">"#);
                for bullet in &bullets[..mid.min(bullets.len())] {
                    html.push_str(&format!("<li>{bullet}</li>"));
                }
                html.push_str("</ul></div>");
                html.push_str(r#"<div class="compare-vs">VS</div>"#);
                html.push_str(r#"<div class="compare-side"><h3 class="title-gradient">Option B</h3><ul class="bullets-list">"#);
                for bullet in &bullets[mid..] {
                    html.push_str(&format!("<li>{bullet}</li>"));
                }
                html.push_str("</ul></div></div>");
            }
            SlideLayout::Centered => {
                html.push_str(&format!(r#"<h2 class="title-gradient">{title}</h2>"#));
                for bullet in &bullets {
                    html.push_str(&format!(r#"<p>{bullet}</p>"#));
                }
            }
            SlideLayout::Blank => {
                html.push_str(&format!(r#"<h3>{title}</h3>"#));
            }
        }

        html.push_str("</div>\n");
    }
    html
}
