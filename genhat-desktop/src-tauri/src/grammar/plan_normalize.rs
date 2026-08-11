//! Normalize and repair artifact plans before native rendering.
//!
//! Models often omit required fields (e.g. slide `title`). This module fills
//! sensible defaults so generation never fails on minor schema drift.

use serde_json::Value;

use super::schema::{PresentationPlan, PresentationSlide, SlideLayout, SpreadsheetOp, SpreadsheetPlan};

fn string_or_empty(v: &Value) -> String {
    v.as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
}

fn first_string(values: &[&Value]) -> String {
    for v in values {
        let s = string_or_empty(v);
        if !s.is_empty() {
            return s;
        }
    }
    String::new()
}

fn parse_layout(raw: &Value, index: usize) -> SlideLayout {
    let text = string_or_empty(raw).to_uppercase();
    match text.as_str() {
        "TITLE" => SlideLayout::Title,
        "SECTION" => SlideLayout::Section,
        "BULLET" => SlideLayout::Bullet,
        "TWO_COLUMN" | "TWO-COLUMN" | "TWOCOLUMN" => SlideLayout::TwoColumn,
        "IMAGE_LEFT" | "IMAGE-LEFT" | "IMAGELEFT" => SlideLayout::ImageLeft,
        "BLANK" => SlideLayout::Blank,
        "STAT" => SlideLayout::Stat,
        "QUOTE" => SlideLayout::Quote,
        "CARDS" => SlideLayout::Cards,
        "COMPARISON" => SlideLayout::Comparison,
        "CENTERED" => SlideLayout::Centered,
        _ if index == 0 => SlideLayout::Title,
        _ => SlideLayout::Bullet,
    }
}

fn normalize_slide_value(slide: &Value, index: usize, fallback_title: &str) -> PresentationSlide {
    let title = first_string(&[
        &slide["title"],
        &slide["heading"],
        &slide["name"],
        &slide["topic"],
        &slide["label"],
    ]);
    let title = if title.is_empty() {
        slide["bullets"]
            .as_array()
            .and_then(|b| b.first())
            .map(string_or_empty)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if index == 0 && !fallback_title.is_empty() {
                    fallback_title.to_string()
                } else {
                    format!("Slide {}", index + 1)
                }
            })
    } else {
        title
    };

    let bullets: Vec<String> = slide["bullets"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(string_or_empty)
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let layout = parse_layout(&slide["layout"], index);

    PresentationSlide {
        title,
        layout,
        bullets,
        notes: slide
            .get("notes")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        image_index: slide
            .get("image_index")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32),
        left_title: slide
            .get("left_title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        right_title: slide
            .get("right_title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

fn is_placeholder_slide(slide: &PresentationSlide) -> bool {
    let title = slide.title.trim();
    let empty_bullets = slide.bullets.iter().all(|b| b.trim().is_empty());
    let empty_notes = slide
        .notes
        .as_ref()
        .map(|n| n.trim().is_empty())
        .unwrap_or(true);

    if title.is_empty() && empty_bullets && empty_notes {
        return true;
    }
    let placeholder_title = {
        let lower = title.to_lowercase();
        lower.starts_with("slide ")
            && lower
                .split_whitespace()
                .nth(1)
                .map(|s| s.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or(false)
    };
    if placeholder_title && empty_bullets {
        return true;
    }

    // Title/section/centered with no body → drop (do not invent filler).
    if matches!(
        slide.layout,
        SlideLayout::Title | SlideLayout::Section | SlideLayout::Centered
    ) && empty_bullets
        && empty_notes
    {
        return true;
    }

    let needs_content = matches!(
        slide.layout,
        SlideLayout::Bullet
            | SlideLayout::TwoColumn
            | SlideLayout::ImageLeft
            | SlideLayout::Stat
            | SlideLayout::Quote
            | SlideLayout::Cards
            | SlideLayout::Comparison
    );
    needs_content && empty_bullets && empty_notes
}

fn clean_topic(prompt: &str) -> String {
    let mut t = prompt.trim().to_string();
    for prefix in [
        "/ppt ",
        "/ppt",
        "/slides ",
        "/slides",
        "/presentation ",
        "/presentation",
        "/deck ",
        "/deck",
    ] {
        let lower = t.to_lowercase();
        let p = prefix.to_lowercase();
        if lower.starts_with(&p) {
            t = t[prefix.len()..].trim().to_string();
            break;
        }
    }
    let lower = t.to_lowercase();
    for prefix in ["on ", "about ", "regarding ", "concerning "] {
        if lower.starts_with(prefix) {
            t = t[prefix.len()..].trim().to_string();
            break;
        }
    }
    let t = t.trim();
    if t.is_empty() {
        "Presentation".to_string()
    } else {
        t.chars().take(120).collect()
    }
}

fn strip_legacy_filler(bullets: Vec<String>) -> Vec<String> {
    bullets
        .into_iter()
        .filter(|b| {
            let lower = b.to_lowercase();
            !(lower.starts_with("an introduction to")
                || lower.starts_with("core themes, turning points")
                || lower.starts_with("this section frames how")
                || lower.starts_with("point ")
                    && lower.contains("how it connects to the broader topic")
                || lower.contains("how it connects to the broader topic"))
        })
        .collect()
}

/// Repair a presentation plan JSON value and deserialize it.
///
/// Keeps model content. Drops empty slides. Never invents domain boilerplate
/// by injecting the topic into industrial-history templates.
pub fn parse_presentation_plan(mut value: Value, prompt: &str) -> Result<PresentationPlan, String> {
    if !value.is_object() {
        value = serde_json::json!({ "slides": [] });
    }

    let topic = clean_topic(prompt);

    let slides_value = value
        .get("slides")
        .cloned()
        .unwrap_or(Value::Array(vec![]));

    let mut slides: Vec<PresentationSlide> = slides_value
        .as_array()
        .map(|arr| {
            arr.iter()
                .enumerate()
                .map(|(i, slide)| {
                    let mut s = normalize_slide_value(slide, i, &topic);
                    s.bullets = strip_legacy_filler(std::mem::take(&mut s.bullets));
                    s
                })
                .collect()
        })
        .unwrap_or_default();

    slides.retain(|s| !is_placeholder_slide(s));

    // Keep only the first TITLE slide.
    let mut saw_title = false;
    slides.retain(|s| {
        if s.layout == SlideLayout::Title {
            if saw_title {
                return false;
            }
            saw_title = true;
        }
        true
    });

    if slides.is_empty() {
        slides.push(PresentationSlide {
            title: topic.clone(),
            layout: SlideLayout::Title,
            bullets: vec![
                format!("Presentation on {topic}"),
                "Regenerate if this deck looks incomplete — content could not be recovered from the model output."
                    .to_string(),
            ],
            notes: None,
            image_index: None,
            left_title: None,
            right_title: None,
        });
    } else if slides[0].layout != SlideLayout::Title {
        slides[0].layout = SlideLayout::Title;
    }

    let theme = value
        .get("theme")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let output_name = value
        .get("output_name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let images = value.get("images").cloned();

    let mut plan = PresentationPlan {
        slides,
        theme,
        output_name,
        images: None,
    };

    if let Some(imgs) = images {
        if let Ok(parsed) = serde_json::from_value(imgs) {
            plan.images = Some(parsed);
        }
    }

    Ok(plan)
}

fn normalize_spreadsheet_op(op: &mut Value) {
    let Some(obj) = op.as_object_mut() else {
        return;
    };

    if let Some(op_name) = obj.get("op").and_then(|v| v.as_str()) {
        obj.insert("op".to_string(), Value::String(op_name.to_uppercase()));
    }

    // COUNT_BY_GROUP / AVERAGE_BY_GROUP: col → group_col
    let op_upper = obj
        .get("op")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_uppercase();
    if matches!(op_upper.as_str(), "COUNT_BY_GROUP" | "AVERAGE_BY_GROUP") {
        if obj.get("group_col").is_none() {
            if let Some(col) = obj.get("col").cloned() {
                obj.insert("group_col".to_string(), col);
            }
        }
    }
}

/// Repair a spreadsheet plan JSON value and deserialize it.
pub fn parse_spreadsheet_plan(mut value: Value) -> Result<SpreadsheetPlan, String> {
    if !value.is_object() {
        value = serde_json::json!({ "ops": [] });
    }

    // Accept cloud-tool shape: { title, sheets: [{ name, headers, rows }] }
    if value.get("ops").is_none() {
        value["ops"] = Value::Array(vec![]);
    }

    if let Some(title) = value.get("title").and_then(|v| v.as_str()) {
        if value.get("output_name").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
            value["output_name"] = Value::String(title.to_string());
        }
    }

    if let Some(sheets) = value.get_mut("sheets").and_then(|v| v.as_array_mut()) {
        for sheet in sheets.iter_mut() {
            if let Some(obj) = sheet.as_object_mut() {
                // Normalize rows alias
                if obj.get("rows").is_none() {
                    if let Some(sr) = obj.remove("source_rows") {
                        obj.insert("rows".to_string(), sr);
                    }
                }
                if let Some(ops) = obj.get_mut("ops").and_then(|v| v.as_array_mut()) {
                    for op in ops.iter_mut() {
                        normalize_spreadsheet_op(op);
                    }
                }
                // Lift bare headers/rows into WRITE_DATA when ops empty
                let has_ops = obj
                    .get("ops")
                    .and_then(|v| v.as_array())
                    .is_some_and(|a| !a.is_empty());
                if !has_ops {
                    let headers = obj.get("headers").cloned().unwrap_or(Value::Array(vec![]));
                    let rows = obj
                        .get("rows")
                        .cloned()
                        .unwrap_or(Value::Array(vec![]));
                    if headers.as_array().is_some_and(|h| !h.is_empty()) {
                        obj.insert(
                            "ops".to_string(),
                            Value::Array(vec![serde_json::json!({
                                "op": "WRITE_DATA",
                                "headers": headers,
                                "rows": rows,
                            })]),
                        );
                    }
                }
            }
        }
    }

    if let Some(ops) = value.get_mut("ops").and_then(|v| v.as_array_mut()) {
        for op in ops.iter_mut() {
            normalize_spreadsheet_op(op);
        }
    } else {
        value["ops"] = Value::Array(vec![]);
    }

    let mut plan: SpreadsheetPlan = serde_json::from_value(value)
        .map_err(|e| format!("Invalid spreadsheet plan after repair: {e}"))?;

    let has_sheets = plan
        .sheets
        .as_ref()
        .is_some_and(|s| !s.is_empty());

    if !has_sheets && plan.ops.is_empty() {
        plan.ops.push(SpreadsheetOp::WriteData {
            headers: vec!["Item".to_string(), "Details".to_string()],
            rows: vec![vec![
                "Generated".to_string(),
                "Add data via WRITE_DATA".to_string(),
            ]],
        });
    }

    Ok(plan)
}
