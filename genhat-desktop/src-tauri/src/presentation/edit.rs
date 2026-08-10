//! Apply structural / style edits to existing NELA presentation decks (and
//! best-effort PPTX → plan conversion for surgical edits).

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use zip::ZipArchive;

use crate::grammar::schema::{PresentationPlan, PresentationSlide, SlideLayout};

use super::parse::{is_nela_presentation_html, parse_presentation_html};
use super::write_presentation_plan;

/// Derive a filesystem-safe output stem for an edited deck.
pub fn edited_output_name(source_path: &str) -> String {
    let base = Path::new(source_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("nela_presentation");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let stem = trimmed.chars().take(72).collect::<String>();
    if stem.is_empty() {
        "nela_presentation_edited".to_string()
    } else if stem.ends_with("_edited") {
        stem
    } else {
        format!("{stem}_edited")
    }
}

/// Parse an on-disk deck, insert slides at `insert_at`, and write a new HTML artifact.
pub fn insert_slides_to_deck(
    source_path: &str,
    new_slides: Vec<PresentationSlide>,
    insert_at: usize,
    output_name: Option<String>,
) -> Result<PathBuf, String> {
    let html = std::fs::read_to_string(source_path)
        .map_err(|e| format!("Failed to read presentation: {e}"))?;

    let mut plan = parse_presentation_html(&html)?;
    let insert_at = insert_at.min(plan.slides.len());
    for (offset, slide) in new_slides.into_iter().enumerate() {
        plan.slides.insert(insert_at + offset, slide);
    }
    plan.output_name = Some(
        output_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| edited_output_name(source_path)),
    );

    write_presentation_plan(plan)
}

/// Append slides at the end of a deck (convenience wrapper).
pub fn append_slides_to_deck(
    source_path: &str,
    append: Vec<PresentationSlide>,
    output_name: Option<String>,
) -> Result<PathBuf, String> {
    let html = std::fs::read_to_string(source_path)
        .map_err(|e| format!("Failed to read presentation: {e}"))?;
    let plan = parse_presentation_html(&html)?;
    insert_slides_to_deck(source_path, append, plan.slides.len(), output_name)
}

/// Replace slide content from a full plan (used after LLM deck edits).
pub fn rewrite_deck_from_plan(
    source_path: &str,
    mut plan: PresentationPlan,
    output_name: Option<String>,
) -> Result<PathBuf, String> {
    let html = std::fs::read_to_string(source_path)
        .map_err(|e| format!("Failed to read presentation: {e}"))?;
    let existing = parse_presentation_html(&html)?;

    if plan.theme.is_none() {
        plan.theme = existing.theme;
    }
    if plan.images.is_none() {
        plan.images = existing.images;
    }
    plan.output_name = Some(
        output_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| edited_output_name(source_path)),
    );

    write_presentation_plan(plan)
}

// ── Surgical ops ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PresentationEditOp {
    SetTheme {
        theme: String,
    },
    SetFont {
        #[serde(default)]
        heading: Option<String>,
        #[serde(default)]
        body: Option<String>,
    },
    SetColors {
        #[serde(default)]
        accent: Option<String>,
        #[serde(default)]
        background: Option<String>,
    },
    InsertSlide {
        #[serde(default)]
        at: Option<String>,
        #[serde(default)]
        index: Option<usize>,
        title: String,
        #[serde(default)]
        layout: Option<String>,
        #[serde(default)]
        bullets: Vec<String>,
    },
    PatchSlide {
        /// 0-based index preferred; 1-based accepted when `one_based` is true.
        index: usize,
        #[serde(default)]
        one_based: Option<bool>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        layout: Option<String>,
        #[serde(default)]
        bullets: Option<Vec<String>>,
    },
    RemoveSlide {
        index: usize,
        #[serde(default)]
        one_based: Option<bool>,
    },
    MoveSlide {
        from: usize,
        to: usize,
        #[serde(default)]
        one_based: Option<bool>,
    },
}

#[derive(Debug, Clone, Default)]
struct StyleOverrides {
    font_head: Option<String>,
    font_body: Option<String>,
    accent: Option<String>,
    background: Option<String>,
}

/// Load a presentation plan from a NELA HTML deck or a native PPTX.
pub fn load_presentation_plan(source_path: &str) -> Result<PresentationPlan, String> {
    let lower = source_path.to_ascii_lowercase();
    if lower.ends_with(".pptx") || lower.ends_with(".ppt") {
        return parse_pptx_to_plan(source_path);
    }
    let html = std::fs::read_to_string(source_path)
        .map_err(|e| format!("Failed to read presentation: {e}"))?;
    if is_nela_presentation_html(&html) {
        return parse_presentation_html(&html);
    }
    Err(
        "Unsupported presentation format for surgical edit (need NELA HTML deck or .pptx)"
            .to_string(),
    )
}

/// Apply a small list of ops to an existing deck/PPTX and write a new HTML artifact.
pub fn apply_ops_to_deck(
    source_path: &str,
    ops: Vec<PresentationEditOp>,
    output_name: Option<String>,
) -> Result<PathBuf, String> {
    if ops.is_empty() {
        return Err("No edit operations provided".to_string());
    }

    let mut plan = load_presentation_plan(source_path)?;
    let mut style = StyleOverrides::default();

    // Carry forward style overrides already embedded in a NELA HTML deck.
    if let Ok(html) = std::fs::read_to_string(source_path) {
        if is_nela_presentation_html(&html) {
            style = extract_style_overrides(&html);
        }
    }

    apply_ops_to_plan(&mut plan, &mut style, ops)?;

    plan.output_name = Some(
        output_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| edited_output_name(source_path)),
    );

    let out = write_presentation_plan(plan)?;
    inject_style_overrides(&out, &style)?;
    Ok(out)
}

fn apply_ops_to_plan(
    plan: &mut PresentationPlan,
    style: &mut StyleOverrides,
    ops: Vec<PresentationEditOp>,
) -> Result<(), String> {
    for op in ops {
        match op {
            PresentationEditOp::SetTheme { theme } => {
                let t = theme.trim();
                if !t.is_empty() {
                    plan.theme = Some(t.to_ascii_lowercase());
                }
            }
            PresentationEditOp::SetFont { heading, body } => {
                if let Some(h) = heading.filter(|s| !s.trim().is_empty()) {
                    style.font_head = Some(sanitize_font_name(&h));
                }
                if let Some(b) = body.filter(|s| !s.trim().is_empty()) {
                    style.font_body = Some(sanitize_font_name(&b));
                }
            }
            PresentationEditOp::SetColors { accent, background } => {
                if let Some(a) = accent.filter(|s| !s.trim().is_empty()) {
                    style.accent = Some(normalize_color(&a));
                }
                if let Some(b) = background.filter(|s| !s.trim().is_empty()) {
                    style.background = Some(normalize_color(&b));
                }
            }
            PresentationEditOp::InsertSlide {
                at,
                index,
                title,
                layout,
                bullets,
            } => {
                let insert_at = resolve_insert_index(plan.slides.len(), at.as_deref(), index);
                let slide = PresentationSlide {
                    title: title.trim().to_string(),
                    layout: parse_layout(layout.as_deref()),
                    bullets: bullets
                        .into_iter()
                        .map(|b| b.trim().to_string())
                        .filter(|b| !b.is_empty())
                        .collect(),
                    notes: None,
                    image_index: None,
                    left_title: None,
                    right_title: None,
                };
                plan.slides.insert(insert_at.min(plan.slides.len()), slide);
            }
            PresentationEditOp::PatchSlide {
                index,
                one_based,
                title,
                layout,
                bullets,
            } => {
                let idx = resolve_slide_index(plan.slides.len(), index, one_based.unwrap_or(false))?;
                let slide = &mut plan.slides[idx];
                if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
                    slide.title = t.trim().to_string();
                }
                if let Some(l) = layout {
                    slide.layout = parse_layout(Some(&l));
                }
                if let Some(b) = bullets {
                    slide.bullets = b
                        .into_iter()
                        .map(|x| x.trim().to_string())
                        .filter(|x| !x.is_empty())
                        .collect();
                }
            }
            PresentationEditOp::MoveSlide {
                from,
                to,
                one_based,
            } => {
                let one = one_based.unwrap_or(false);
                let from_idx = resolve_slide_index(plan.slides.len(), from, one)?;
                let to_idx = resolve_slide_index(plan.slides.len(), to, one)?;
                if from_idx != to_idx {
                    let slide = plan.slides.remove(from_idx);
                    let insert_at = to_idx.min(plan.slides.len());
                    plan.slides.insert(insert_at, slide);
                }
            }
            PresentationEditOp::RemoveSlide { index, one_based } => {
                let idx = resolve_slide_index(plan.slides.len(), index, one_based.unwrap_or(false))?;
                plan.slides.remove(idx);
                if plan.slides.is_empty() {
                    return Err("Cannot remove the last remaining slide".to_string());
                }
            }
        }
    }
    Ok(())
}

fn resolve_insert_index(slide_count: usize, at: Option<&str>, index: Option<usize>) -> usize {
    if let Some(i) = index {
        return i.min(slide_count);
    }
    let Some(at) = at.map(|s| s.trim().to_ascii_lowercase()) else {
        return slide_count;
    };
    match at.as_str() {
        "start" | "beginning" | "first" | "front" => 0,
        "end" | "last" | "append" => slide_count,
        _ => {
            if let Some(rest) = at.strip_prefix("before:") {
                if let Ok(n) = rest.trim().parse::<usize>() {
                    return n.saturating_sub(1).min(slide_count);
                }
            }
            if let Some(rest) = at.strip_prefix("after:") {
                if let Ok(n) = rest.trim().parse::<usize>() {
                    return n.min(slide_count);
                }
            }
            slide_count
        }
    }
}

fn resolve_slide_index(
    slide_count: usize,
    index: usize,
    one_based: bool,
) -> Result<usize, String> {
    if slide_count == 0 {
        return Err("Deck has no slides".to_string());
    }
    let idx = if one_based {
        index.saturating_sub(1)
    } else if index >= slide_count && index >= 1 {
        // Heuristic: models often emit 1-based indexes.
        index.saturating_sub(1)
    } else {
        index
    };
    if idx >= slide_count {
        return Err(format!(
            "Slide index {index} out of range (deck has {slide_count} slides)"
        ));
    }
    Ok(idx)
}

fn parse_layout(raw: Option<&str>) -> SlideLayout {
    let Some(s) = raw.map(|x| x.trim().to_ascii_uppercase()) else {
        return SlideLayout::Bullet;
    };
    match s.as_str() {
        "TITLE" => SlideLayout::Title,
        "SECTION" => SlideLayout::Section,
        "TWO_COLUMN" | "TWOCOLUMN" => SlideLayout::TwoColumn,
        "IMAGE_LEFT" | "IMAGELEFT" => SlideLayout::ImageLeft,
        "STAT" => SlideLayout::Stat,
        "QUOTE" => SlideLayout::Quote,
        "CARDS" => SlideLayout::Cards,
        "COMPARISON" => SlideLayout::Comparison,
        "CENTERED" => SlideLayout::Centered,
        "BLANK" => SlideLayout::Blank,
        _ => SlideLayout::Bullet,
    }
}

fn sanitize_font_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_color(raw: &str) -> String {
    let t = raw.trim();
    if t.starts_with('#') {
        return t.to_string();
    }
    let lower = t.to_ascii_lowercase();
    match lower.as_str() {
        "blue" => "#2563eb".into(),
        "red" => "#e11d48".into(),
        "green" => "#15803d".into(),
        "purple" | "violet" => "#7c3aed".into(),
        "orange" => "#ea580c".into(),
        "pink" => "#db2777".into(),
        "black" => "#0f172a".into(),
        "white" => "#ffffff".into(),
        "gray" | "grey" => "#64748b".into(),
        "teal" | "cyan" => "#0d9488".into(),
        _ => {
            if t.len() == 6 && t.chars().all(|c| c.is_ascii_hexdigit()) {
                format!("#{t}")
            } else {
                t.to_string()
            }
        }
    }
}

fn extract_style_overrides(html: &str) -> StyleOverrides {
    let mut style = StyleOverrides::default();
    if let Some(block) = html
        .split("id=\"nela-style-overrides\"")
        .nth(1)
        .and_then(|rest| rest.split("</style>").next())
    {
        if let Some(v) = css_var_value(block, "--font-head") {
            style.font_head = Some(v);
        }
        if let Some(v) = css_var_value(block, "--font-body") {
            style.font_body = Some(v);
        }
        if let Some(v) = css_var_value(block, "--accent-solid") {
            style.accent = Some(v);
        }
        if let Some(v) = css_var_value(block, "--bg") {
            style.background = Some(v);
        }
    }
    style
}

fn css_var_value(block: &str, name: &str) -> Option<String> {
    let key = format!("{name}:");
    let idx = block.find(&key)?;
    let rest = &block[idx + key.len()..];
    let end = rest.find([';', '\n']).unwrap_or(rest.len());
    let val = rest[..end].trim().trim_matches('\'').trim_matches('"');
    if val.is_empty() {
        None
    } else {
        Some(val.to_string())
    }
}

fn inject_style_overrides(path: &Path, style: &StyleOverrides) -> Result<(), String> {
    if style.font_head.is_none()
        && style.font_body.is_none()
        && style.accent.is_none()
        && style.background.is_none()
    {
        return Ok(());
    }

    let mut html =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read written deck: {e}"))?;

    // Drop any previous override block.
    if let Some(start) = html.find("<style id=\"nela-style-overrides\">") {
        if let Some(rel_end) = html[start..].find("</style>") {
            let end = start + rel_end + "</style>".len();
            html.replace_range(start..end, "");
        }
    }

    let mut rules = String::from(":root {\n");
    if let Some(h) = &style.font_head {
        rules.push_str(&format!("  --font-head: '{h}', system-ui, sans-serif;\n"));
    }
    if let Some(b) = &style.font_body {
        rules.push_str(&format!("  --font-body: '{b}', system-ui, sans-serif;\n"));
    }
    if let Some(a) = &style.accent {
        rules.push_str(&format!("  --accent-solid: {a};\n"));
        rules.push_str(&format!("  --accent-from: {a};\n"));
        rules.push_str(&format!("  --accent-to: {a};\n"));
    }
    if let Some(bg) = &style.background {
        rules.push_str(&format!("  --bg: {bg};\n"));
        rules.push_str(&format!("  --surface: {bg};\n"));
    }
    rules.push_str("}\n");

    let block = format!("<style id=\"nela-style-overrides\">\n{rules}</style>\n");
    if let Some(idx) = html.rfind("</head>") {
        html.insert_str(idx, &block);
    } else {
        html.push_str(&block);
    }

    std::fs::write(path, html).map_err(|e| format!("Failed to write style overrides: {e}"))?;
    Ok(())
}

/// Best-effort PPTX → PresentationPlan (title + bullets per slide).
fn parse_pptx_to_plan(path: &str) -> Result<PresentationPlan, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open PPTX: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid PPTX zip: {e}"))?;

    let mut slide_names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let name = archive
            .by_index(i)
            .map(|f| f.name().to_string())
            .unwrap_or_default();
        if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
            slide_names.push(name);
        }
    }
    slide_names.sort_by(|a, b| nat_ord(a, b));

    let mut slides = Vec::new();
    for (i, slide_name) in slide_names.iter().enumerate() {
        let texts = extract_pptx_texts(&mut archive, slide_name)?;
        let texts: Vec<String> = texts
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        if texts.is_empty() {
            continue;
        }
        let title = texts[0].clone();
        let bullets: Vec<String> = texts[1..]
            .iter()
            .map(|t| {
                t.trim_start_matches(['•', '-', '*', '–', '—'] as [char; 5])
                    .trim()
                    .to_string()
            })
            .filter(|t| !t.is_empty())
            .collect();
        let layout = if i == 0 {
            SlideLayout::Title
        } else if bullets.is_empty() {
            SlideLayout::Centered
        } else {
            SlideLayout::Bullet
        };
        slides.push(PresentationSlide {
            title,
            layout,
            bullets,
            notes: None,
            image_index: None,
            left_title: None,
            right_title: None,
        });
    }

    if slides.is_empty() {
        return Err("No slides found in PPTX".to_string());
    }

    Ok(PresentationPlan {
        slides,
        theme: Some("midnight".into()),
        output_name: None,
        images: None,
    })
}

fn extract_pptx_texts(
    archive: &mut ZipArchive<std::fs::File>,
    name: &str,
) -> Result<Vec<String>, String> {
    let mut file = match archive.by_name(name) {
        Ok(f) => f,
        Err(_) => return Ok(Vec::new()),
    };
    let mut xml = String::new();
    file.read_to_string(&mut xml)
        .map_err(|e| format!("Failed to read {name}: {e}"))?;

    let mut texts = Vec::new();
    let mut reader = quick_xml::Reader::from_reader(Cursor::new(xml.as_bytes()));
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut in_t = false;
    let mut current = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Start(e)) => {
                let local = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if local == "t" {
                    in_t = true;
                } else if local == "p" {
                    current.clear();
                }
            }
            Ok(quick_xml::events::Event::Text(t)) if in_t => {
                current.push_str(&t.unescape().unwrap_or_default());
            }
            Ok(quick_xml::events::Event::End(e)) => {
                let local = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if local == "t" {
                    in_t = false;
                } else if local == "p" && !current.trim().is_empty() {
                    texts.push(std::mem::take(&mut current).trim().to_string());
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(e) => return Err(format!("PPTX XML parse error in {name}: {e}")),
            _ => {}
        }
        buf.clear();
    }
    if !current.trim().is_empty() {
        texts.push(current.trim().to_string());
    }
    Ok(texts)
}

fn nat_ord(a: &str, b: &str) -> std::cmp::Ordering {
    let num = |s: &str| {
        s.chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u32>()
            .unwrap_or(0)
    };
    num(a).cmp(&num(b)).then_with(|| a.cmp(b))
}
