//! Shared Google connector OAuth client (Desktop / PKCE).
//!
//! Used by Gmail and Google Drive (`connect_flow = "desktop_pkce"`).
//! Optional cloud OAuth broker remains for legacy / server-side exchange.
//!
//! Distinct from NELA Cloud website login. Tokens stay on-device.
//! End users never configure client IDs — NELA ships one Desktop client.

/// Public Desktop OAuth client ID (PKCE, no secret).
/// Not the website login client (`GOOGLE_CLIENT_ID` on nela-backend).
///
/// Release/CI: set `NELA_GOOGLE_CONNECTOR_CLIENT_ID` at compile time.
/// Local: set the same var (or `NELA_GMAIL_OAUTH_CLIENT_ID`) in `.env`.
const SHIPPED_GOOGLE_CONNECTOR_CLIENT_ID: &str =
    match option_env!("NELA_GOOGLE_CONNECTOR_CLIENT_ID") {
        Some(id) => id,
        None => "",
    };

const USER_UNAVAILABLE: &str =
    "Gmail isn't available in this copy of NELA. Update the app and try Connect again.";

/// Resolve the public connector client ID: runtime env (dev) then shipped/compile-time.
pub fn connector_client_id() -> Result<String, String> {
    crate::cloud::load_dotenv_files();
    for key in [
        "NELA_GOOGLE_CONNECTOR_CLIENT_ID",
        "NELA_GMAIL_OAUTH_CLIENT_ID",
    ] {
        if let Ok(id) = std::env::var(key) {
            let id = id.trim().to_string();
            if !id.is_empty() {
                return Ok(id);
            }
        }
    }
    let shipped = SHIPPED_GOOGLE_CONNECTOR_CLIENT_ID.trim();
    if !shipped.is_empty() {
        return Ok(shipped.to_string());
    }
    Err(USER_UNAVAILABLE.to_string())
}

/// Google Desktop clients include a client_secret that is not confidential
/// (it ships in the app) but the token endpoint still requires it.
pub fn connector_client_secret() -> Option<String> {
    crate::cloud::load_dotenv_files();
    for key in [
        "NELA_GOOGLE_CONNECTOR_CLIENT_SECRET",
        "NELA_GMAIL_OAUTH_CLIENT_SECRET",
    ] {
        if let Ok(secret) = std::env::var(key) {
            let secret = secret.trim().to_string();
            if !secret.is_empty() {
                return Some(secret);
            }
        }
    }
    option_env!("NELA_GOOGLE_CONNECTOR_CLIENT_SECRET")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::USER_UNAVAILABLE;

    #[test]
    fn user_error_does_not_mention_env_or_gcp() {
        let lower = USER_UNAVAILABLE.to_lowercase();
        assert!(!lower.contains(".env"));
        assert!(!lower.contains("client_id"));
        assert!(!lower.contains("google cloud"));
    }
}
