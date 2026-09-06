//! Connector catalog loaded from `connectors.toml` (embedded at compile time).
//!
//! UI listing comes from this file. Runtime ops require a matching
//! [`crate::connectors::backend::ConnectorBackend`] registration.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const CONNECTORS_TOML: &str = include_str!("../config/connectors.toml");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorStatus {
    Available,
    ComingSoon,
    Disabled,
}

#[derive(Debug, Clone, Deserialize)]
struct RawConnector {
    id: String,
    display_name: String,
    #[serde(default = "default_category")]
    category: String,
    status: ConnectorStatus,
    #[serde(default = "default_auth")]
    auth_kind: String,
    #[serde(default)]
    oauth: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    description: String,
    #[serde(default = "default_show_in_attach_menu")]
    show_in_attach_menu: bool,
    #[serde(default = "default_connect_flow")]
    connect_flow: String,
}

fn default_category() -> String {
    "storage".into()
}
fn default_auth() -> String {
    "oauth2".into()
}
fn default_show_in_attach_menu() -> bool {
    true
}
fn default_connect_flow() -> String {
    "cloud_broker".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDefinition {
    pub id: String,
    pub display_name: String,
    pub category: String,
    pub status: ConnectorStatus,
    pub auth_kind: String,
    pub oauth: Option<String>,
    pub capabilities: Vec<String>,
    pub description: String,
    pub show_in_attach_menu: bool,
    pub connect_flow: String,
}

impl From<RawConnector> for ConnectorDefinition {
    fn from(r: RawConnector) -> Self {
        Self {
            id: r.id,
            display_name: r.display_name,
            category: r.category,
            status: r.status,
            auth_kind: r.auth_kind,
            oauth: r.oauth,
            capabilities: r.capabilities,
            description: r.description,
            show_in_attach_menu: r.show_in_attach_menu,
            connect_flow: r.connect_flow,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawCatalog {
    connector: Vec<RawConnector>,
}

static CATALOG: OnceLock<Vec<ConnectorDefinition>> = OnceLock::new();

pub fn load_connector_catalog() -> Result<&'static [ConnectorDefinition], String> {
    if CATALOG.get().is_none() {
        let raw: RawCatalog = toml::from_str(CONNECTORS_TOML)
            .map_err(|e| format!("Failed to parse connectors.toml: {e}"))?;
        let defs: Vec<ConnectorDefinition> =
            raw.connector.into_iter().map(ConnectorDefinition::from).collect();
        let _ = CATALOG.set(defs);
    }
    Ok(CATALOG.get().map(|v| v.as_slice()).unwrap_or(&[]))
}

pub fn catalog_or_empty() -> &'static [ConnectorDefinition] {
    load_connector_catalog().unwrap_or(&[])
}

pub fn find_definition(id: &str) -> Option<&'static ConnectorDefinition> {
    catalog_or_empty().iter().find(|c| c.id == id)
}
