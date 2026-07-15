//! Apply structural edits to existing NELA presentation decks.

use std::path::{Path, PathBuf};

use crate::grammar::schema::{PresentationPlan, PresentationSlide};

use super::parse::parse_presentation_html;
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
///
/// `insert_at` is a zero-based index; values equal to the current slide count append
/// at the end. The index is clamped to `0..=slides.len()`.
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
