//! Write a rendered HTML artifact to disk.

use std::path::PathBuf;

use crate::grammar::schema::HtmlPlan;

use super::render_html_plan;

/// Render `plan` and persist it under the system temp directory.
pub fn write_html_plan(plan: HtmlPlan) -> Result<PathBuf, String> {
    let output_name = plan
        .output_name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if plan.title.trim().is_empty() {
                "nela_html"
            } else {
                plan.title.as_str()
            }
        });

    let slug: String = output_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else if c.is_whitespace() {
                '-'
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(80)
        .collect();

    let slug = if slug.is_empty() {
        "nela_html".to_string()
    } else {
        slug
    };

    let out_dir = std::env::temp_dir().join("nela_artifacts");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Create output dir: {e}"))?;
    let path = out_dir.join(format!("{slug}.html"));

    let html = render_html_plan(plan);
    if html.trim().is_empty() {
        return Err("Rendered HTML was empty".to_string());
    }

    std::fs::write(&path, &html).map_err(|e| format!("Failed to write HTML: {e}"))?;

    Ok(path)
}
