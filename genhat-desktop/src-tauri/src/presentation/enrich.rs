//! Expand sparse presentation plans so slides carry enough on-screen text.

use crate::grammar::schema::{PresentationPlan, PresentationSlide, SlideLayout};

/// Minimum visible bullet/point count per layout (content slides should feel filled).
fn min_bullets(layout: SlideLayout) -> usize {
    match layout {
        SlideLayout::Title => 1,
        SlideLayout::Section => 1,
        SlideLayout::Bullet => 4,
        SlideLayout::TwoColumn => 4,
        SlideLayout::ImageLeft => 4,
        SlideLayout::Stat => 2,
        SlideLayout::Quote => 1,
        SlideLayout::Cards => 3,
        SlideLayout::Comparison => 4,
        SlideLayout::Centered => 2,
        SlideLayout::Blank => 0,
    }
}

fn split_compound_bullets(bullets: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for b in bullets {
        let t = b.trim();
        if t.is_empty() {
            continue;
        }
        if t.contains('\n') {
            out.extend(
                t.split('\n')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from),
            );
            continue;
        }
        if t.contains(';') && t.matches(';').count() >= 1 {
            let parts: Vec<String> = t
                .split(';')
                .map(str::trim)
                .filter(|s| s.len() > 8)
                .map(String::from)
                .collect();
            if parts.len() > 1 {
                out.extend(parts);
                continue;
            }
        }
        if t.contains(" • ") {
            out.extend(
                t.split(" • ")
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from),
            );
            continue;
        }
        out.push(t.to_string());
    }
    out
}

/// Split prose into sentence-sized chunks suitable as bullet points.
fn split_into_sentences(text: &str) -> Vec<String> {
    let t = text.trim();
    if t.is_empty() {
        return vec![];
    }
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in t.chars() {
        current.push(ch);
        if (ch == '.' || ch == '!' || ch == '?') && current.trim().len() > 20 {
            parts.push(current.trim().to_string());
            current.clear();
        }
    }
    if current.trim().len() > 10 {
        parts.push(current.trim().to_string());
    }
    if parts.is_empty() {
        parts.push(t.to_string());
    }
    parts
}

fn enrich_slide(slide: &mut PresentationSlide) {
    slide.bullets = split_compound_bullets(std::mem::take(&mut slide.bullets));

    // One very long bullet → multiple sentences.
    if slide.bullets.len() == 1 {
        let only = slide.bullets[0].clone();
        if only.len() > 120 {
            let expanded = split_into_sentences(&only);
            if expanded.len() > 1 {
                slide.bullets = expanded;
            }
        }
    }

    let min = min_bullets(slide.layout);
    let notes_text = slide.notes.take();

    if slide.bullets.len() < min {
        if let Some(ref notes) = notes_text {
            for chunk in split_into_sentences(notes) {
                if slide.bullets.len() >= min {
                    break;
                }
                if !slide.bullets.iter().any(|b| b == &chunk) {
                    slide.bullets.push(chunk);
                }
            }
        }
    }

    // Keep remaining notes as a visible footer when still substantial.
    if let Some(notes) = notes_text {
        let trimmed = notes.trim();
        if trimmed.len() > 20 {
            let already_used = slide.bullets.iter().any(|b| b.contains(trimmed) || trimmed.contains(b.as_str()));
            if !already_used {
                slide.notes = Some(trimmed.to_string());
            }
        }
    }

    // TITLE / SECTION: synthesize a subtitle from title words if still empty.
    if matches!(slide.layout, SlideLayout::Title | SlideLayout::Section) && slide.bullets.is_empty() {
        if let Some(notes) = &slide.notes {
            slide.bullets.push(notes.clone());
            slide.notes = None;
        }
    }
}

/// Expand bullets and surface speaker notes before HTML render.
pub fn enrich_presentation_plan(mut plan: PresentationPlan) -> PresentationPlan {
    for slide in &mut plan.slides {
        enrich_slide(slide);
    }
    plan
}
