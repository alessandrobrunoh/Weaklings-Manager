/// Application configuration loaded from environment variables.
///
/// Uses `dotenvy` to load a `.env` file at startup and `serde` to
/// deserialize typed config from environment variables.
use serde::Deserialize;

/// Compiled-in version from `Cargo.toml` — set automatically at compile time.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    /// Port the HTTP server binds to (default: 3000).
    #[serde(default = "default_backend_port")]
    pub backend_port: u16,
    /// Connection string for Postgres.
    pub database_url: String,
    /// Discord `OAuth2` Client ID.
    pub discord_client_id: String,
    /// Discord `OAuth2` Client Secret.
    pub discord_client_secret: String,
    /// Discord `OAuth2` Redirect URI.
    pub discord_redirect_uri: String,
    /// Discord Guild (Server) ID.
    pub discord_guild_id: String,
    /// Discord Bot Token (optional).
    pub discord_bot_token: Option<String>,
    /// Super Admin Discord User ID.
    pub super_admin_discord_id: String,
    /// URL of the frontend for redirection (default: http://localhost:3001).
    #[serde(default = "default_frontend_url")]
    pub frontend_url: String,
    /// Albion Online API region to query (americas|europe|asia). Defaults to "europe".
    #[serde(default = "default_albion_api_region")]
    pub albion_api_region: String,
    /// The Albion Online guild ID whose roster is used for self-service player linking.
    pub albion_guild_id: String,
    /// Mistral AI API key, used by the `/utils/ocr` endpoint to extract text from images.
    pub mistral_api_key: String,
    /// Base URL for the AlbionBB API. Defaults to the public endpoint.
    #[serde(default = "default_albionbb_base_url")]
    pub albionbb_base_url: String,
    /// Request timeout in seconds for AlbionBB API requests. Defaults to 60.
    #[serde(default = "default_albionbb_timeout")]
    pub albionbb_request_timeout_secs: u64,
}

fn default_backend_port() -> u16 {
    3000
}

fn default_frontend_url() -> String {
    "http://localhost:3001".to_string()
}

fn default_albion_api_region() -> String {
    "europe".to_string()
}

fn default_albionbb_base_url() -> String {
    "https://api.albionbb.com".to_string()
}

fn default_albionbb_timeout() -> u64 {
    60
}

impl Config {
    pub fn from_env() -> Self {
        envy::from_env().expect("Failed to parse config from environment")
    }
}
