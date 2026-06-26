//! Deterministic HTML page renderer for /html artifacts.
//!
//! The model emits a compact JSON plan (title, archetype, sections); this module
//! assembles a complete, styled HTML document every time.

pub mod render;
pub mod write;
pub mod layout;
pub mod interactive;
pub mod charts;

pub use render::render_html_plan;
pub use write::write_html_plan;
