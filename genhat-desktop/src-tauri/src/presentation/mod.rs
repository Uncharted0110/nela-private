//! Presentation artifact rendering (HTML slide decks).

mod enrich;
mod edit;
mod parse;
mod write;

pub use edit::{
    append_slides_to_deck, apply_ops_to_deck, edited_output_name, insert_slides_to_deck,
    load_presentation_plan, rewrite_deck_from_plan, PresentationEditOp,
};
pub use parse::{is_nela_presentation_html, parse_presentation_html};
pub use write::write_presentation_plan;
