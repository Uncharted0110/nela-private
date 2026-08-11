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
    let style = extract_style_overrides(&html);
    let mut slide_overrides = extract_slide_overrides(&html);
    let image_library = extract_image_library_blocks(&html);
    let insert_at = insert_at.min(plan.slides.len());
    for (offset, slide) in new_slides.into_iter().enumerate() {
        plan.slides.insert(insert_at + offset, slide);
        shift_overrides_on_insert(&mut slide_overrides, insert_at + offset);
    }
    plan.output_name = Some(
        output_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| edited_output_name(source_path)),
    );

    let out = write_presentation_plan(plan)?;
    inject_style_overrides(&out, &style)?;
    inject_slide_overrides(&out, &slide_overrides)?;
    inject_image_library_blocks(&out, &image_library)?;
    Ok(out)
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
    // Slide indexes change wholesale on a rewrite — keep global style + image library.
    let style = extract_style_overrides(&html);
    let image_library = extract_image_library_blocks(&html);

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

    let out = write_presentation_plan(plan)?;
    inject_style_overrides(&out, &style)?;
    inject_image_library_blocks(&out, &image_library)?;
    Ok(out)
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
        #[serde(default)]
        text: Option<String>,
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
    text: Option<String>,
}

/// Per-slide style overrides (background / text color) stamped by the desktop
/// edit executor as `<style id="nela-slide-overrides" data-nela-overrides="…">`.
/// Keys are 0-based slide indexes; they are remapped when ops insert, remove,
/// or move slides so the overrides stay on the right slides after re-render.
#[derive(Debug, Clone, Default, serde::Serialize, Deserialize)]
struct SlideOverrideRule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

type SlideOverrides = std::collections::BTreeMap<usize, SlideOverrideRule>;

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
    let mut slide_overrides = SlideOverrides::new();
    let mut image_library = ImageLibraryBlocks::default();

    // Carry forward style overrides + image library already embedded in a NELA HTML deck.
    if let Ok(html) = std::fs::read_to_string(source_path) {
        if is_nela_presentation_html(&html) {
            style = extract_style_overrides(&html);
            slide_overrides = extract_slide_overrides(&html);
            image_library = extract_image_library_blocks(&html);
        }
    }

    apply_ops_to_plan(&mut plan, &mut style, &mut slide_overrides, ops)?;

    plan.output_name = Some(
        output_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| edited_output_name(source_path)),
    );

    let out = write_presentation_plan(plan)?;
    inject_style_overrides(&out, &style)?;
    inject_slide_overrides(&out, &slide_overrides)?;
    inject_image_library_blocks(&out, &image_library)?;
    Ok(out)
}

// ── Per-slide override remapping ─────────────────────────────────────────────

fn shift_overrides_on_insert(overrides: &mut SlideOverrides, insert_at: usize) {
    let shifted: SlideOverrides = overrides
        .iter()
        .map(|(&k, v)| (if k >= insert_at { k + 1 } else { k }, v.clone()))
        .collect();
    *overrides = shifted;
}

fn shift_overrides_on_remove(overrides: &mut SlideOverrides, removed_at: usize) {
    let shifted: SlideOverrides = overrides
        .iter()
        .filter(|(&k, _)| k != removed_at)
        .map(|(&k, v)| (if k > removed_at { k - 1 } else { k }, v.clone()))
        .collect();
    *overrides = shifted;
}

fn shift_overrides_on_move(overrides: &mut SlideOverrides, from: usize, to: usize) {
    let moved = overrides.remove(&from);
    shift_overrides_on_remove(overrides, from);
    shift_overrides_on_insert(overrides, to);
    if let Some(rule) = moved {
        overrides.insert(to, rule);
    }
}

fn apply_ops_to_plan(
    plan: &mut PresentationPlan,
    style: &mut StyleOverrides,
    slide_overrides: &mut SlideOverrides,
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
            PresentationEditOp::SetColors {
                accent,
                background,
                text,
            } => {
                if let Some(a) = accent.filter(|s| !s.trim().is_empty()) {
                    style.accent = Some(normalize_color(&a));
                }
                if let Some(b) = background.filter(|s| !s.trim().is_empty()) {
                    style.background = Some(normalize_color(&b));
                }
                if let Some(t) = text.filter(|s| !s.trim().is_empty()) {
                    style.text = Some(normalize_color(&t));
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
                let at_idx = insert_at.min(plan.slides.len());
                plan.slides.insert(at_idx, slide);
                shift_overrides_on_insert(slide_overrides, at_idx);
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
                    shift_overrides_on_move(slide_overrides, from_idx, insert_at);
                }
            }
            PresentationEditOp::RemoveSlide { index, one_based } => {
                let idx = resolve_slide_index(plan.slides.len(), index, one_based.unwrap_or(false))?;
                plan.slides.remove(idx);
                shift_overrides_on_remove(slide_overrides, idx);
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
        if let Some(v) = css_var_value(block, "--text") {
            style.text = Some(v);
        }
    }
    style
}

fn unescape_html_attr(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&amp;", "&")
}

fn escape_html_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
}

/// Read per-slide overrides stamped by the desktop edit executor.
fn extract_slide_overrides(html: &str) -> SlideOverrides {
    let mut out = SlideOverrides::new();
    let Some(tag_start) = html.find("id=\"nela-slide-overrides\"") else {
        return out;
    };
    let rest = &html[tag_start..];
    let Some(attr_start) = rest.find("data-nela-overrides=\"") else {
        return out;
    };
    let json_start = attr_start + "data-nela-overrides=\"".len();
    let Some(json_end) = rest[json_start..].find('"') else {
        return out;
    };
    let raw = unescape_html_attr(&rest[json_start..json_start + json_end]);
    if let Ok(parsed) =
        serde_json::from_str::<std::collections::BTreeMap<String, SlideOverrideRule>>(&raw)
    {
        for (key, rule) in parsed {
            if let Ok(idx) = key.trim().parse::<usize>() {
                out.insert(idx, rule);
            }
        }
    }
    out
}

/// Opaque HTML fragments for the desktop image library (`#nela-image-library`
/// aside plus companion style/script). Carried across Rust re-renders so
/// theme/layout ops do not wipe searched images.
#[derive(Debug, Clone, Default)]
struct ImageLibraryBlocks {
    aside: Option<String>,
    style: Option<String>,
    script: Option<String>,
}

impl ImageLibraryBlocks {
    fn is_empty(&self) -> bool {
        self.aside.is_none() && self.style.is_none() && self.script.is_none()
    }
}

fn extract_element_by_id(html: &str, id: &str, close_tag: &str) -> Option<String> {
    let marker = format!("id=\"{id}\"");
    let id_idx = html.find(&marker)?;
    let start = html[..id_idx].rfind('<')?;
    let end_rel = html[id_idx..].find(close_tag)?;
    let end = id_idx + end_rel + close_tag.len();
    Some(html[start..end].to_string())
}

fn extract_image_library_blocks(html: &str) -> ImageLibraryBlocks {
    ImageLibraryBlocks {
        aside: extract_element_by_id(html, "nela-image-library", "</aside>"),
        style: extract_element_by_id(html, "nela-image-library-style", "</style>"),
        script: extract_element_by_id(html, "nela-image-library-script", "</script>"),
    }
}

fn strip_element_by_id(html: &mut String, id: &str, close_tag: &str) {
    let marker = format!("id=\"{id}\"");
    if let Some(id_idx) = html.find(&marker) {
        if let Some(start) = html[..id_idx].rfind('<') {
            if let Some(end_rel) = html[id_idx..].find(close_tag) {
                let end = id_idx + end_rel + close_tag.len();
                html.replace_range(start..end, "");
            }
        }
    }
}

fn inject_image_library_blocks(path: &Path, blocks: &ImageLibraryBlocks) -> Result<(), String> {
    if blocks.is_empty() {
        return Ok(());
    }

    let mut html =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read written deck: {e}"))?;

    // Drop any previous library fragments from a fresh render (usually none).
    strip_element_by_id(&mut html, "nela-image-library", "</aside>");
    strip_element_by_id(&mut html, "nela-image-library-style", "</style>");
    strip_element_by_id(&mut html, "nela-image-library-script", "</script>");

    if let Some(style) = &blocks.style {
        if let Some(idx) = html.rfind("</head>") {
            html.insert_str(idx, &format!("{style}\n"));
        } else {
            html.push_str(style);
        }
    }

    let mut body_chunk = String::new();
    if let Some(aside) = &blocks.aside {
        body_chunk.push_str(aside);
        body_chunk.push('\n');
    }
    if let Some(script) = &blocks.script {
        body_chunk.push_str(script);
        body_chunk.push('\n');
    }
    if !body_chunk.is_empty() {
        if let Some(idx) = html.rfind("</body>") {
            html.insert_str(idx, &body_chunk);
        } else {
            html.push_str(&body_chunk);
        }
    }

    std::fs::write(path, html).map_err(|e| format!("Failed to write image library: {e}"))?;
    Ok(())
}

/// Re-stamp per-slide overrides on a freshly rendered deck (same format the
/// desktop executor writes, so later edits keep merging into one block).
fn inject_slide_overrides(path: &Path, overrides: &SlideOverrides) -> Result<(), String> {
    if overrides.is_empty() {
        return Ok(());
    }

    let mut html =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read written deck: {e}"))?;

    // Drop any previous block.
    if let Some(start) = html.find("<style id=\"nela-slide-overrides\"") {
        if let Some(rel_end) = html[start..].find("</style>") {
            let end = start + rel_end + "</style>".len();
            html.replace_range(start..end, "");
        }
    }

    let mut css = String::new();
    for (&idx, rule) in overrides {
        let sel = format!(".slide-stage > .slide:nth-child({})", idx + 1);
        if let Some(bg) = &rule.background {
            css.push_str(&format!(
                "{sel} {{ background: {bg} !important; background-image: none !important; }}\n\
                 {sel}::before, {sel}::after {{ background: none !important; }}\n"
            ));
        }
        if let Some(text) = &rule.text {
            css.push_str(&format!(
                "{sel}, {sel} :is(h1,h2,h3,h4,h5,p,li,span,strong,em,blockquote,div) \
                 {{ color: {text} !important; -webkit-text-fill-color: {text} !important; }}\n"
            ));
        }
    }

    let keyed: std::collections::BTreeMap<String, &SlideOverrideRule> = overrides
        .iter()
        .map(|(&k, v)| (k.to_string(), v))
        .collect();
    let json = serde_json::to_string(&keyed).unwrap_or_else(|_| "{}".to_string());
    let block = format!(
        "<style id=\"nela-slide-overrides\" data-nela-overrides=\"{}\">\n{css}</style>\n",
        escape_html_attr(&json)
    );

    if let Some(idx) = html.rfind("</head>") {
        html.insert_str(idx, &block);
    } else {
        html.push_str(&block);
    }

    std::fs::write(path, html).map_err(|e| format!("Failed to write slide overrides: {e}"))?;
    Ok(())
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
        && style.text.is_none()
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
    if let Some(text) = &style.text {
        rules.push_str(&format!("  --text: {text};\n"));
        rules.push_str(&format!(
            "  --text-muted: color-mix(in srgb, {text} 72%, transparent);\n"
        ));
        rules.push_str(&format!(
            "  --text-secondary: color-mix(in srgb, {text} 84%, transparent);\n"
        ));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(bg: &str) -> SlideOverrideRule {
        SlideOverrideRule {
            background: Some(bg.to_string()),
            text: None,
        }
    }

    #[test]
    fn extracts_slide_overrides_from_desktop_block() {
        let html = r#"<html><head><style id="nela-slide-overrides" data-nela-overrides="{&quot;2&quot;:{&quot;background&quot;:&quot;#dc2626&quot;,&quot;text&quot;:&quot;#f8fafc&quot;}}">
.slide-stage > .slide:nth-child(3) { background: #dc2626 !important; }
</style></head><body></body></html>"#;
        let overrides = extract_slide_overrides(html);
        assert_eq!(overrides.len(), 1);
        let rule = overrides.get(&2).expect("index 2 present");
        assert_eq!(rule.background.as_deref(), Some("#dc2626"));
        assert_eq!(rule.text.as_deref(), Some("#f8fafc"));
    }

    #[test]
    fn remaps_overrides_on_insert_remove_move() {
        let mut overrides = SlideOverrides::new();
        overrides.insert(1, rule("#111111"));
        overrides.insert(4, rule("#444444"));

        // Insert a slide at index 2 → 1 stays, 4 becomes 5.
        shift_overrides_on_insert(&mut overrides, 2);
        assert!(overrides.contains_key(&1));
        assert!(overrides.contains_key(&5));

        // Remove slide 0 → 1 becomes 0, 5 becomes 4.
        shift_overrides_on_remove(&mut overrides, 0);
        assert!(overrides.contains_key(&0));
        assert!(overrides.contains_key(&4));

        // Remove the overridden slide 0 → its override is dropped.
        shift_overrides_on_remove(&mut overrides, 0);
        assert_eq!(overrides.len(), 1);
        assert!(overrides.contains_key(&3));

        // Move slide 3 to position 0 → override follows the slide.
        shift_overrides_on_move(&mut overrides, 3, 0);
        assert_eq!(overrides.len(), 1);
        assert_eq!(overrides.get(&0).unwrap().background.as_deref(), Some("#444444"));
    }

    #[test]
    fn slide_override_json_round_trips_html_escaping() {
        let raw = r##"{"0":{"text":"#ffff00"}}"##;
        let escaped = escape_html_attr(raw);
        assert!(!escaped.contains('"'));
        assert_eq!(unescape_html_attr(&escaped), raw);
    }

    #[test]
    fn extracts_image_library_blocks() {
        let html = r#"<html><head><style id="nela-image-library-style">.nela-image-library{}</style></head>
<body>
<aside id="nela-image-library" class="nela-image-library"><div class="nela-image-library-rail">
<button type="button" data-nela-lib-id="0" title="t"><img src="data:image/png;base64,aaa" alt="t"></button>
</div></aside>
<script id="nela-image-library-script">(function(){})();</script>
</body></html>"#;
        let blocks = extract_image_library_blocks(html);
        assert!(blocks.aside.as_ref().unwrap().contains("nela-image-library"));
        assert!(blocks.aside.as_ref().unwrap().contains("data:image/png;base64,aaa"));
        assert!(blocks.style.as_ref().unwrap().contains("nela-image-library-style"));
        assert!(blocks.script.as_ref().unwrap().contains("nela-image-library-script"));
    }
}
