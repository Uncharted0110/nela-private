//! Per-user desktop connectors. Tokens stay on-device (app data + keychain).
//! NELA Cloud is never a long-term vault for connector credentials.
//!
//! Catalog: `config/connectors.toml` — UI listing + connect_flow.
//! Backends: `providers/*` registered in `providers::register_all`.
//!
//! Auth flows (from catalog `connect_flow`):
//! - `cloud_broker` — OAuth code exchange via nela-backend (optional / legacy)
//! - `desktop_pkce` — on-device PKCE loopback (Gmail + Drive); no cloud broker
//! - `none` — no OAuth

pub mod desktop_pkce;
pub mod gmail;
pub mod google_oauth;

pub mod connections;
pub mod credentials;
pub mod catalog;
pub mod backend;
pub mod error;
pub mod fileindexer_bridge;
pub mod mirror;
pub mod oauth_client;
pub mod providers;
pub mod registry;
pub mod types;

pub use error::ConnectorError;
pub use registry::Registry;
pub use types::*;

/// Initialize connector catalog backends (safe to call multiple times).
pub fn init() {
    Registry::ensure_initialized();
}
