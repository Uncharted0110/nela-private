use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorError {
    pub code: String,
    pub message: String,
}

impl ConnectorError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn not_implemented(provider: &str) -> Self {
        Self::new(
            "NOT_IMPLEMENTED",
            format!("{provider} is coming soon."),
        )
    }

    pub fn needs_reauth() -> Self {
        Self::new(
            "NEEDS_REAUTH",
            "This connection expired. Please connect again.",
        )
    }

    pub fn not_found(what: &str) -> Self {
        Self::new("NOT_FOUND", format!("{what} was not found."))
    }

    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::new("INVALID", msg)
    }

    pub fn network(msg: impl Into<String>) -> Self {
        Self::new("NETWORK", msg)
    }

    pub fn io(msg: impl Into<String>) -> Self {
        Self::new("IO", msg)
    }
}

impl std::fmt::Display for ConnectorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ConnectorError {}

impl From<ConnectorError> for String {
    fn from(value: ConnectorError) -> Self {
        value.message
    }
}
