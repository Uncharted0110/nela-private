//! Error types for the structural knowledge-graph engine.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ParserError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Unsupported or empty document: {0}")]
    Unsupported(String),
    #[error("Parse failure: {0}")]
    Parse(String),
    /// Explicit alias used by generic panic / extraction failure paths.
    #[error("Parse failure: {0}")]
    ParseFailure(String),
    #[error("Unextractable text: {0}")]
    UnextractableText(String),
    #[error("ZIP error: {0}")]
    Zip(String),
    /// Soft failure — file is deferred to Pass 2 background retry.
    #[error("parse timed out ({0}ms)")]
    Timeout(u64),
    /// Password-protected / encrypted PDF — not recoverable without credentials.
    #[error("encrypted PDF: {0}")]
    EncryptedPdf(String),
    /// Image-only / scanned PDF with no extractable text objects.
    #[error("scanned image PDF: {0}")]
    ScannedImage(String),
    /// Transient PDF extraction failure (pdf-extract panic / soft error) — Pass 2 retry.
    #[error("retriable PDF error: {0}")]
    RetriablePdfError(String),
}

impl ParserError {
    /// Timeouts and retriable PDF failures are deferred to Pass 2.
    /// Encrypted / scanned / hard parse errors are permanent.
    pub fn is_retriable(&self) -> bool {
        matches!(
            self,
            ParserError::Timeout(_)
                | ParserError::RetriablePdfError(_)
                | ParserError::ParseFailure(_)
        )
    }
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("Parser: {0}")]
    Parser(#[from] ParserError),
    #[error("Search index: {0}")]
    Search(String),
    #[error("Embedding: {0}")]
    Embedding(String),
    #[error("Serialization: {0}")]
    Serde(String),
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

impl From<EngineError> for String {
    fn from(value: EngineError) -> Self {
        value.to_string()
    }
}
