//! Parse ambient file-search queries into structured hints for retrieval.

/// Hints extracted from a natural-language file search query.
#[derive(Debug, Clone, Default)]
pub struct SearchHints {
    /// Meaningful search terms (stop words and hint-only tokens removed).
    pub terms: Vec<String>,
    /// User asked for the newest matching file (e.g. "latest resume").
    pub wants_latest: bool,
    /// Document-type tokens that should appear in the filename (resume, cv, …).
    pub doc_type_tokens: Vec<String>,
    /// Concrete filename with extension, if the user typed one.
    pub filename_literal: Option<String>,
    /// Absolute path to a file if the user pasted one in the message.
    pub absolute_path: Option<String>,
}

const STOP_WORDS: &[&str] = &[
    "can", "you", "tell", "me", "about", "from", "my", "files", "to", "and", "the", "a", "an",
    "for", "in", "on", "of", "with", "at", "by", "this", "that", "these", "those", "is", "are",
    "was", "were", "be", "been", "have", "has", "had", "do", "does", "did", "please", "find",
    "show", "get", "open", "read", "where", "what", "i", "want", "all", "any", "some", "each",
    "every", "file", "folder", "folders", "directory", "directories", "path", "paths",
    "location", "locations", "document", "documents", "named", "called", "titled", "containing",
    "contains", "content", "contents", "here", "there", "give", "overview", "looking", "look",
    "using", "use", "via", "through", "into", "an", "into", "system", "computer", "machine",
    "laptop", "pc", "disk", "drive", "local", "stored", "saved",
];

/// Maps user phrasing to filename tokens we should require or strongly prefer.
const DOC_TYPE_ALIASES: &[(&str, &[&str])] = &[
    ("resume", &["resume", "resumes", "résumé", "resumé"]),
    ("cv", &["cv", "curriculum"]),
    ("cover", &["cover", "letter"]),
    ("transcript", &["transcript"]),
    ("invoice", &["invoice"]),
    ("report", &["report"]),
    ("tax", &["tax", "w2", "w-2", "1099"]),
    ("payslip", &["payslip", "paystub", "salary"]),
    ("contract", &["contract", "agreement"]),
];

fn normalize_token(raw: &str) -> String {
    raw.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_')
        .to_lowercase()
}

fn extract_filename_literal(query: &str) -> Option<String> {
    let re = regex::Regex::new(
        r"(?i)\b([\w][\w.\-_]{0,200}\.(pdf|docx?|pptx?|xlsx?|xls|csv|tsv|txt|md|json|rtf|odt|ods))\b",
    )
    .ok()?;
    re.captures(query)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_lowercase())
}

fn extract_absolute_path(query: &str) -> Option<String> {
    use crate::indexer::paths::normalize_index_path;
    use std::path::Path;

    let unix = regex::Regex::new(
        r"(?i)(/(?:[\w.\-]+/)+[\w.\-]+\.(pdf|docx?|pptx?|xlsx?|xls|csv|tsv|txt|md|json|rtf|odt|ods))",
    )
    .ok()?;
    if let Some(m) = unix.find(query) {
        return Some(normalize_index_path(Path::new(m.as_str())));
    }

    let win = regex::Regex::new(
        r"(?i)([A-Za-z]:\\(?:[\w.\-\\]+\\)+[\w.\-]+\.(pdf|docx?|pptx?|xlsx?|xls|csv|tsv|txt|md|json|rtf|odt|ods))",
    )
    .ok()?;
    win.find(query)
        .map(|m| normalize_index_path(Path::new(m.as_str())))
}

/// Parse a raw user query into structured retrieval hints.
pub fn parse_search_hints(query_str: &str) -> SearchHints {
    let lower = query_str.to_lowercase();
    let absolute_path = extract_absolute_path(query_str);
    let wants_latest = lower.contains("latest")
        || lower.contains("newest")
        || lower.contains("most recent")
        || lower.contains("last updated")
        || lower.contains("recent version");

    let filename_literal = extract_filename_literal(query_str);

    let mut doc_type_tokens: Vec<String> = Vec::new();
    for (canonical, aliases) in DOC_TYPE_ALIASES {
        if aliases.iter().any(|a| lower.contains(a)) {
            doc_type_tokens.push((*canonical).to_string());
        }
    }
    doc_type_tokens.sort();
    doc_type_tokens.dedup();

    let latest_only = ["latest", "newest", "recent"];
    let words: Vec<String> = query_str
        .split_whitespace()
        .map(|w| normalize_token(w))
        .filter(|w| {
            !w.is_empty()
                && !STOP_WORDS.contains(&w.as_str())
                && !latest_only.contains(&w.as_str())
                && w.len() >= 2
        })
        .collect();

    SearchHints {
        terms: words,
        wants_latest,
        doc_type_tokens,
        filename_literal,
        absolute_path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_resume_latest_query() {
        let hints = parse_search_hints(
            "Give me an overview of the CS grad by looking at the latest resume in the system",
        );
        assert!(hints.wants_latest);
        assert!(hints.doc_type_tokens.contains(&"resume".to_string()));
        assert!(hints.terms.iter().any(|t| t == "grad" || t == "cs"));
    }

    #[test]
    fn extracts_absolute_path() {
        let hints = parse_search_hints(
            "/home/amogh/Documents/uselessdocs/resumes/amogh_latest_resume.pdf can you explain this file",
        );
        assert!(hints.absolute_path.is_some());
        assert!(
            hints
                .absolute_path
                .as_ref()
                .unwrap()
                .contains("amogh_latest_resume.pdf")
        );
    }
}
