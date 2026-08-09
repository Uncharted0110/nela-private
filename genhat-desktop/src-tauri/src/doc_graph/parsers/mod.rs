pub mod docx;
pub mod html;
pub mod pdf;
pub mod pptx;
pub mod registry;
pub mod traits;
pub mod txt;
pub mod xlsx;

pub use registry::ParserRegistry;
pub use traits::{DocumentParser, ParsedContainer, ParsedContentBlock, ParsedDocument};
pub use pdf::parse_pass2_fallback;
