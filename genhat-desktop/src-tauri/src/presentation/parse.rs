//! Parse NELA-generated HTML slide decks back into a `PresentationPlan`.

use scraper::{ElementRef, Html, Selector};

use crate::grammar::schema::{
    ArtifactImageAsset, PresentationPlan, PresentationSlide, SlideLayout,
};

/// Returns true when the HTML looks like a NELA interactive slide deck.
pub fn is_nela_presentation_html(html: &str) -> bool {
    html.contains("deck-container")
        && html.contains("slide-stage")
        && html.contains("class=\"slide")
}

/// Best-effort reverse of `write.rs` — enough to preserve content across edits.
pub fn parse_presentation_html(html: &str) -> Result<PresentationPlan, String> {
    if !is_nela_presentation_html(html) {
        return Err("File is not a NELA presentation deck".to_string());
    }

    let doc = Html::parse_document(html);
    let body_sel = Selector::parse("body").map_err(|e| e.to_string())?;
    let theme = doc
        .select(&body_sel)
        .next()
        .and_then(|body| {
            body.value()
                .classes()
                .find_map(|c| c.strip_prefix("theme-").map(String::from))
        });

    let slide_sel = Selector::parse("div.slide").map_err(|e| e.to_string())?;
    let mut slides = Vec::new();
    let mut images: Vec<ArtifactImageAsset> = Vec::new();
    let mut image_index_by_uri: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();

    for slide_el in doc.select(&slide_sel) {
        let class = slide_el.value().classes().collect::<Vec<_>>().join(" ");
        let layout = layout_from_class(&class);
        let (title, bullets, notes, image_index) =
            extract_slide_content(&slide_el, &mut images, &mut image_index_by_uri);
        slides.push(PresentationSlide {
            title,
            layout,
            bullets,
            notes,
            image_index,
            left_title: None,
            right_title: None,
        });
    }

    if slides.is_empty() {
        return Err("No slides found in presentation deck".to_string());
    }

    Ok(PresentationPlan {
        slides,
        theme,
        output_name: None,
        images: if images.is_empty() {
            None
        } else {
            Some(images)
        },
    })
}

fn layout_from_class(class: &str) -> SlideLayout {
    if class.contains("layout-title") {
        SlideLayout::Title
    } else if class.contains("layout-section") {
        SlideLayout::Section
    } else if class.contains("layout-twocolumn") {
        SlideLayout::TwoColumn
    } else if class.contains("layout-imageleft") {
        SlideLayout::ImageLeft
    } else if class.contains("layout-stat") {
        SlideLayout::Stat
    } else if class.contains("layout-quote") {
        SlideLayout::Quote
    } else if class.contains("layout-cards") {
        SlideLayout::Cards
    } else if class.contains("layout-comparison") {
        SlideLayout::Comparison
    } else if class.contains("layout-centered") {
        SlideLayout::Centered
    } else if class.contains("layout-blank") {
        SlideLayout::Blank
    } else {
        SlideLayout::Bullet
    }
}

fn extract_slide_content(
    slide: &ElementRef<'_>,
    images: &mut Vec<ArtifactImageAsset>,
    image_index_by_uri: &mut std::collections::HashMap<String, u32>,
) -> (String, Vec<String>, Option<String>, Option<u32>) {
    let h1_sel = Selector::parse("h1.title-gradient").unwrap();
    let h2_sel = Selector::parse("h2.title-gradient").unwrap();
    let h3_sel = Selector::parse("h3.title-gradient").unwrap();
    let li_sel = Selector::parse("ul.bullets-list li").unwrap();
    let p_sel = Selector::parse("p").unwrap();
    let stat_sel = Selector::parse(".stat-value").unwrap();
    let img_sel = Selector::parse("img.slide-image").unwrap();
    let detail_sel = Selector::parse("p.slide-detail").unwrap();

    let title = slide
        .select(&h1_sel)
        .next()
        .map(|el| text_content(&el))
        .filter(|s| !s.is_empty())
        .or_else(|| {
            slide
                .select(&h2_sel)
                .next()
                .map(|el| text_content(&el))
                .filter(|s| !s.is_empty())
        })
        .or_else(|| slide.select(&h3_sel).next().map(|el| text_content(&el)))
        .unwrap_or_else(|| "Slide".to_string());

    let mut bullets: Vec<String> = slide
        .select(&li_sel)
        .map(|el| text_content(&el))
        .filter(|s| !s.is_empty())
        .collect();

    if bullets.is_empty() {
        if let Some(stat) = slide.select(&stat_sel).next() {
            bullets.push(text_content(&stat));
        }
        for p in slide.select(&p_sel) {
            let class = p.value().classes().collect::<Vec<_>>().join(" ");
            if class.contains("slide-detail")
                || class.contains("quote-attr")
                || class.contains("stat-label")
            {
                continue;
            }
            let t = text_content(&p);
            if !t.is_empty() {
                bullets.push(t);
            }
        }
    }

    let notes = slide
        .select(&detail_sel)
        .next()
        .map(|el| text_content(&el))
        .filter(|s| s.len() > 15);

    let mut image_index = None;
    if let Some(img) = slide.select(&img_sel).next() {
        if let Some(src) = img.value().attr("src") {
            if src.starts_with("data:") {
                let idx = if let Some(&existing) = image_index_by_uri.get(src) {
                    existing
                } else {
                    let alt = img
                        .value()
                        .attr("alt")
                        .unwrap_or("")
                        .to_string();
                    let next = images.len() as u32;
                    images.push(ArtifactImageAsset {
                        data_uri: src.to_string(),
                        caption: String::new(),
                        alt: if alt.is_empty() { None } else { Some(alt) },
                    });
                    image_index_by_uri.insert(src.to_string(), next);
                    next
                };
                image_index = Some(idx);
            }
        }
    }

    (title, bullets, notes, image_index)
}

fn text_content(el: &ElementRef<'_>) -> String {
    el.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_nela_deck_marker() {
        assert!(is_nela_presentation_html(
            r#"<div class="deck-container"><div class="slide-stage" id="stage"><div class="slide active">"#
        ));
        assert!(!is_nela_presentation_html("<html><body><p>Hello</p></body></html>"));
    }
}
