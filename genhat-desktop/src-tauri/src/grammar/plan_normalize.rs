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

/// Repair a presentation plan JSON value and deserialize it.
pub fn parse_presentation_plan(mut value: Value, prompt: &str) -> Result<PresentationPlan, String> {
    if !value.is_object() {
        value = serde_json::json!({ "slides": [] });
    }

    let fallback_title = prompt.trim().chars().take(120).collect::<String>();
    let slides_value = value
        .get("slides")
        .cloned()
        .unwrap_or(Value::Array(vec![]));

    let mut slides: Vec<PresentationSlide> = slides_value
        .as_array()
        .map(|arr| {
            arr.iter()
                .enumerate()
                .map(|(i, slide)| normalize_slide_value(slide, i, &fallback_title))
                .collect()
        })
        .unwrap_or_default();

    if slides.is_empty() {
        slides.push(PresentationSlide {
            title: if fallback_title.is_empty() {
                "Presentation".to_string()
            } else {
                fallback_title.clone()
            },
            layout: SlideLayout::Title,
            bullets: vec![prompt.trim().chars().take(200).collect()],
            notes: None,
            image_index: None,
            left_title: None,
            right_title: None,
        });
    }

    if slides[0].layout != SlideLayout::Title {
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

    if let Some(ops) = value.get_mut("ops").and_then(|v| v.as_array_mut()) {
        for op in ops.iter_mut() {
            normalize_spreadsheet_op(op);
        }
    } else {
        value["ops"] = Value::Array(vec![]);
    }

    let mut plan: SpreadsheetPlan = serde_json::from_value(value)
        .map_err(|e| format!("Invalid spreadsheet plan after repair: {e}"))?;

    if plan.ops.is_empty() {
        plan.ops.push(SpreadsheetOp::WriteData {
            headers: vec!["Item".to_string(), "Details".to_string()],
            rows: vec![vec!["Generated".to_string(), "Add data via WRITE_DATA".to_string()]],
        });
    }

    Ok(plan)
}
