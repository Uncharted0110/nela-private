//! mcp-server-presentation — MCP tool sidecar for presentation slide synthesis.
//!
//! Reads one JSON-RPC 2.0 request from stdin, generates an `.html` interactive presentation
//! slide deck, and writes one JSON-RPC 2.0 response to stdout, then exits.

use std::io::{self, BufRead};
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum SlideLayout {
    Title,
    Bullet,
    TwoColumn,
    ImageLeft,
    Blank,
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

// ─────────────────────────────────────────────────────────────────────────────
// HTML generation
// ─────────────────────────────────────────────────────────────────────────────

fn generate_html(plan: PresentationPlan) -> Result<PathBuf, String> {
    let output_name = plan.output_name.as_deref().unwrap_or("nela_presentation");
    let out_dir = std::env::temp_dir().join("nela_artifacts");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Create output dir: {e}"))?;
    let path = out_dir.join(format!("{output_name}.html"));

    let slides_html = render_slides(&plan.slides);
    
    let html_content = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Presentation</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Plus+Jakarta+Sans:wght@300;400;500;700&display=swap" rel="stylesheet">
    <style>
        * {{
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }}
        body {{
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: #0d0d11;
            color: #e4e4eb;
            overflow: hidden;
            height: 100vh;
            width: 100vw;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
        }}
        .deck-container {{
            position: relative;
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            background: radial-gradient(circle at top left, #1a1a24 0%, #0d0d11 100%);
        }}
        .slides-wrapper {{
            position: relative;
            flex-grow: 1;
            width: 100%;
            overflow: hidden;
        }}
        .slide {{
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
        }}
        .slide.active {{
            opacity: 1;
            visibility: visible;
            transform: scale(1) translateY(0);
            z-index: 10;
        }}
        
        /* Typography */
        h1, h2, h3 {{
            font-family: 'Outfit', sans-serif;
            font-weight: 800;
        }}
        
        /* Gradient Titles */
        .title-gradient {{
            background: linear-gradient(135deg, #a5b4fc 0%, #6366f1 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }}

        /* Slide Layouts */
        .layout-title {{
            align-items: center;
            text-align: center;
            gap: 24px;
        }}
        .layout-title h1 {{
            font-size: clamp(2.5rem, 5vw, 4.5rem);
            line-height: 1.15;
            letter-spacing: -0.03em;
        }}
        .layout-title p {{
            font-size: clamp(1.1rem, 2vw, 1.8rem);
            color: #94a3b8;
            font-weight: 300;
            max-width: 800px;
        }}

        .layout-bullet, .layout-twocolumn, .layout-imageleft {{
            justify-content: flex-start;
            gap: 30px;
        }}
        .slide-header {{
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            padding-bottom: 20px;
            margin-bottom: 10px;
        }}
        .slide-header h2 {{
            font-size: clamp(2rem, 3.5vw, 3rem);
            letter-spacing: -0.02em;
        }}
        
        .bullets-list {{
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }}
        .bullets-list li {{
            font-size: clamp(1.1rem, 1.8vw, 1.5rem);
            line-height: 1.5;
            color: #cbd5e1;
            position: relative;
            padding-left: 35px;
        }}
        .bullets-list li::before {{
            content: "";
            position: absolute;
            left: 10px;
            top: 12px;
            width: 8px;
            height: 8px;
            background-color: #6366f1;
            border-radius: 50%;
            box-shadow: 0 0 10px rgba(99, 102, 241, 0.8);
        }}

        /* Two Column Layout */
        .two-column-grid {{
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 50px;
            height: 100%;
        }}
        
        /* Image Left Layout */
        .image-left-grid {{
            display: grid;
            grid-template-columns: 4fr 5fr;
            gap: 50px;
            align-items: center;
            height: 100%;
        }}
        .mock-image {{
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(165, 180, 252, 0.05) 100%);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 16px;
            height: 320px;
            display: flex;
            justify-content: center;
            align-items: center;
            position: relative;
            overflow: hidden;
        }}
        .mock-image::after {{
            content: "🎨 Visual Panel";
            font-family: 'Outfit', sans-serif;
            color: #a5b4fc;
            font-size: 1.2rem;
            font-weight: 600;
        }}

        /* Slide Footer Controls */
        .deck-footer {{
            padding: 24px 40px;
            background: rgba(13, 13, 17, 0.5);
            backdrop-filter: blur(10px);
            border-top: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            justify-content: space-between;
            align-items: center;
            z-index: 100;
        }}
        .controls {{
            display: flex;
            gap: 12px;
        }}
        .btn {{
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: #cbd5e1;
            padding: 8px 16px;
            border-radius: 8px;
            cursor: pointer;
            font-family: inherit;
            font-weight: 500;
            font-size: 0.9rem;
            transition: all 0.2s ease;
        }}
        .btn:hover {{
            background: rgba(255, 255, 255, 0.1);
            color: #ffffff;
            border-color: rgba(99, 102, 241, 0.5);
        }}
        .progress-bar-container {{
            flex-grow: 1;
            margin: 0 40px;
            height: 4px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 2px;
            position: relative;
            overflow: hidden;
        }}
        .progress-bar {{
            height: 100%;
            background: linear-gradient(90deg, #6366f1, #a5b4fc);
            width: 0%;
            transition: width 0.3s ease;
        }}
        .slide-counter {{
            font-size: 0.9rem;
            color: #64748b;
            font-weight: 500;
        }}
    </style>
</head>
<body>
    <div class="deck-container">
        <div class="slides-wrapper">
            {slides_html}
        </div>
        <div class="deck-footer">
            <div class="slide-counter" id="counter">1 / 1</div>
            <div class="progress-bar-container">
                <div class="progress-bar" id="progress"></div>
            </div>
            <div class="controls">
                <button class="btn" onclick="prevSlide()">Prev</button>
                <button class="btn" onclick="nextSlide()">Next</button>
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
            
            // Update UI
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

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {{
            if (e.key === 'ArrowRight' || e.key === 'Space' || e.key === 'PageDown') {{
                nextSlide();
            }} else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {{
                prevSlide();
            }}
        }});

        // Init
        showSlide(0);
    </script>
</body>
</html>"#,
        slides_html = slides_html
    );

    std::fs::write(&path, html_content)
        .map_err(|e| format!("Failed to write presentation HTML: {e}"))?;

    Ok(path)
}

fn render_slides(slides: &[PresentationSlide]) -> String {
    let mut html = String::new();
    for (i, slide) in slides.iter().enumerate() {
        let active_class = if i == 0 { "active" } else { "" };
        let layout_class = match slide.layout {
            SlideLayout::Title => "layout-title",
            SlideLayout::Bullet => "layout-bullet",
            SlideLayout::TwoColumn => "layout-twocolumn",
            SlideLayout::ImageLeft => "layout-imageleft",
            SlideLayout::Blank => "layout-blank",
        };

        html.push_str(&format!(
            r#"<div class="slide {active_class} {layout_class}">"#
        ));

        match slide.layout {
            SlideLayout::Title => {
                html.push_str(&format!(
                    r#"<h1 class="title-gradient">{}</h1>"#,
                    slide.title
                ));
                if let Some(subtitle) = slide.bullets.first() {
                    html.push_str(&format!(r#"<p>{}</p>"#, subtitle));
                }
            }
            SlideLayout::Bullet => {
                html.push_str(&format!(
                    r#"<div class="slide-header"><h2 class="title-gradient">{}</h2></div>"#,
                    slide.title
                ));
                html.push_str(r#"<ul class="bullets-list">"#);
                for bullet in &slide.bullets {
                    html.push_str(&format!("<li>{}</li>", bullet));
                }
                html.push_str("</ul>");
            }
            SlideLayout::TwoColumn => {
                html.push_str(&format!(
                    r#"<div class="slide-header"><h2 class="title-gradient">{}</h2></div>"#,
                    slide.title
                ));
                html.push_str(r#"<div class="two-column-grid">"#);
                
                // Split bullets between column 1 and column 2
                let mid = (slide.bullets.len() + 1) / 2;
                
                html.push_str(r#"<ul class="bullets-list">"#);
                for bullet in &slide.bullets[..mid] {
                    html.push_str(&format!("<li>{}</li>", bullet));
                }
                html.push_str("</ul>");

                html.push_str(r#"<ul class="bullets-list">"#);
                for bullet in &slide.bullets[mid..] {
                    html.push_str(&format!("<li>{}</li>", bullet));
                }
                html.push_str("</ul>");
                
                html.push_str("</div>");
            }
            SlideLayout::ImageLeft => {
                html.push_str(&format!(
                    r#"<div class="slide-header"><h2 class="title-gradient">{}</h2></div>"#,
                    slide.title
                ));
                html.push_str(r#"<div class="image-left-grid">"#);
                html.push_str(r#"<div class="mock-image"></div>"#);
                
                html.push_str(r#"<ul class="bullets-list">"#);
                for bullet in &slide.bullets {
                    html.push_str(&format!("<li>{}</li>", bullet));
                }
                html.push_str("</ul>");
                
                html.push_str("</div>");
            }
            SlideLayout::Blank => {
                html.push_str(&format!(
                    r#"<h3 style="font-size: 2rem; color: #64748b;">{}</h3>"#,
                    slide.title
                ));
            }
        }

        html.push_str("</div>\n");
    }
    html
}
