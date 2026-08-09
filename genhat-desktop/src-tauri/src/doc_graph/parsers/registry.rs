//! Format → parser registry.

use super::traits::DocumentParser;
use std::path::Path;
use std::sync::Arc;

#[derive(Default)]
pub struct ParserRegistry {
    parsers: Vec<Arc<dyn DocumentParser>>,
}

impl ParserRegistry {
    pub fn new() -> Self {
        let mut reg = Self::default();
        reg.register(Arc::new(super::docx::DocxParser));
        reg.register(Arc::new(super::pptx::PptxParser));
        reg.register(Arc::new(super::xlsx::XlsxParser));
        reg.register(Arc::new(super::pdf::PdfParser));
        reg.register(Arc::new(super::html::HtmlParser));
        reg.register(Arc::new(super::txt::TxtParser));
        reg
    }

    pub fn register(&mut self, parser: Arc<dyn DocumentParser>) {
        self.parsers.push(parser);
    }

    pub fn get_parser(&self, path: &Path) -> Option<Arc<dyn DocumentParser>> {
        let ext = path.extension()?.to_str()?.to_lowercase();
        self.parsers.iter().find(|p| p.can_parse(&ext)).cloned()
    }

    pub fn supported_extension(ext: &str) -> bool {
        matches!(
            ext.to_lowercase().as_str(),
            "pdf" | "docx" | "pptx" | "xlsx" | "xls" | "ods" | "html" | "htm" | "txt" | "md" | "markdown"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn registry_matches_extensions() {
        let reg = ParserRegistry::new();
        assert!(reg.get_parser(&PathBuf::from("a.docx")).is_some());
        assert!(reg.get_parser(&PathBuf::from("b.PPTX")).is_some());
        assert!(reg.get_parser(&PathBuf::from("c.pdf")).is_some());
        assert!(reg.get_parser(&PathBuf::from("d.xlsx")).is_some());
        assert!(reg.get_parser(&PathBuf::from("e.html")).is_some());
        assert!(reg.get_parser(&PathBuf::from("f.txt")).is_some());
        assert!(reg.get_parser(&PathBuf::from("g.bin")).is_none());
    }
}
