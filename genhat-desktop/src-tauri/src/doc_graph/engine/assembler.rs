//! Format expanded subgraph hits into LLM-ready Markdown.

use crate::doc_graph::graph::traversal::ExpandedSource;

pub fn assemble_markdown(sources: &[ExpandedSource]) -> String {
    if sources.is_empty() {
        return "No relevant structural context found.".to_string();
    }

    let mut out = String::new();
    for (i, src) in sources.iter().enumerate() {
        if i > 0 {
            out.push_str("\n---\n\n");
        }
        out.push_str(&format!(
            "### Source {}: {} > {}: {}\n",
            i + 1,
            src.file_name,
            src.container_label,
            src.container_title
        ));
        out.push_str(&format!(
            "- **Location:** {} (File: {})\n",
            src.container_label, src.file_path
        ));
        out.push_str("- **Context:**\n");
        for block in &src.context_blocks {
            for line in block.lines() {
                out.push_str(&format!("  - {}\n", line.trim()));
            }
        }
        if !src.related_cross_doc.is_empty() {
            out.push_str("- **Related (cross-doc):**\n");
            for rel in &src.related_cross_doc {
                out.push_str(&format!("  - {rel}\n"));
            }
        }
    }
    out
}
