/// Application configuration loaded from environment variables.
///
/// Uses `dotenvy` to load a `.env` file at startup and `serde` to
/// deserialize typed config from environment variables.
use axum_extra::extract::cookie::Key as CookieKey;
use serde::Deserialize;

/// Compiled-in version from `Cargo.toml` — set automatically at compile time.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The Discord channel/role IDs that used to live here (audit log, transaction spam, CTA
/// announcements, event-ping role) now live in the `guild_settings` DB table instead — see
/// `modules::admin::service::AdminService` — so an admin can change them from the web app
/// without a redeploy. `discord_bot_token` below stays here: it is a deployment secret, not a
/// setting.
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
    /// Shared secret for bot-to-backend authentication (optional).
    ///
    /// When set, HTTP requests carrying the `X-Bot-Secret` header with this value are
    /// treated as authenticated bot requests and resolved to a local user via the
    /// `X-Discord-Id` header. Leave unset to disable bot header auth entirely.
    pub bot_api_secret: Option<String>,
    /// Discord Bot Token (optional).
    pub discord_bot_token: Option<String>,
    /// Super Admin Discord User ID.
    pub super_admin_discord_id: String,
    /// Secret used to encrypt/authenticate the `session_user` cookie (see [`Config::session_key`]).
    ///
    /// Must be at least 64 bytes of random data — generate one with `openssl rand -hex 64` and
    /// keep it stable across deploys (rotating it invalidates every active session). Required:
    /// the server refuses to start without a sufficiently long secret, so a broken deployment
    /// fails fast instead of ever serving forgeable sessions.
    pub session_secret: String,
    /// URL of the frontend for redirection (default: http://localhost:5173, Vite dev).
    #[serde(default = "default_frontend_url")]
    pub frontend_url: String,
    /// Albion Online API region to query (americas|europe|asia). Defaults to "europe".
    #[serde(default = "default_albion_api_region")]
    pub albion_api_region: String,
    /// The Albion Online guild ID whose roster is used for self-service player linking.
    pub albion_guild_id: String,
    /// Comma-separated Albion guild IDs that fight on our side and must not be counted as opponents.
    #[serde(default)]
    pub albion_allied_guild_ids: String,
    /// Comma-separated Albion guild names used as a fallback when an upstream battle omits guild IDs.
    #[serde(default)]
    pub albion_allied_guild_names: String,
    /// Mistral AI API key, used by the `/utils/ocr` endpoint to extract text from images.
    pub mistral_api_key: String,
    /// Base URL for the AlbionBB API. Defaults to the public endpoint.
    #[serde(default = "default_albionbb_base_url")]
    pub albionbb_base_url: String,
    /// Request timeout in seconds for AlbionBB API requests. Defaults to 60.
    #[serde(default = "default_albionbb_timeout")]
    pub albionbb_request_timeout_secs: u64,
    /// Request timeout in seconds for Albion Online Data requests. Defaults to 30.
    #[serde(default = "default_albiondata_timeout")]
    pub albiondata_request_timeout_secs: u64,
}

fn default_backend_port() -> u16 {
    3000
}

fn default_frontend_url() -> String {
    "http://localhost:5173".to_string()
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

fn default_albiondata_timeout() -> u64 {
    30
}

impl Config {
    /// Loads configuration from environment variables.
    ///
    /// # Panics
    ///
    /// Panics when a required variable is missing or malformed — appropriate at startup, where a
    /// broken deployment should fail fast.
    pub fn from_env() -> Self {
        Self::try_from_env().expect("Failed to parse config from environment")
    }

    /// Best-effort config load for optional side effects (e.g. Discord notifications).
    ///
    /// Returns the underlying `envy` error when required variables are absent so callers can skip
    /// non-critical work instead of aborting — the audit log rows themselves are never lost.
    pub fn try_from_env() -> Result<Self, envy::Error> {
        envy::from_env()
    }

    /// Derives the [`cookie::Key`](CookieKey) used to encrypt and authenticate the
    /// `session_user` cookie from `session_secret`.
    ///
    /// Intended to be called once at startup (see `main.rs`) and shared via app state/extension
    /// so every request reuses the same key instead of re-deriving it.
    ///
    /// # Panics
    ///
    /// Panics if `session_secret` is shorter than 64 bytes — the minimum `cookie::Key` accepts
    /// for already-random input. This is deliberate: it must fail the deployment at startup,
    /// never mid-request. Generate a valid secret with `openssl rand -hex 64`.
    #[must_use]
    pub fn session_key(&self) -> CookieKey {
        CookieKey::try_from(self.session_secret.as_bytes()).unwrap_or_else(|e| {
            panic!(
                "SESSION_SECRET is invalid ({e}): it must be at least 64 bytes of random data \
                 (generate one with `openssl rand -hex 64`)"
            )
        })
    }

    /// Parses optional comma-separated allied guild IDs without forcing deployment-specific state
    /// into the codebase.
    ///
    /// The value comes from `ALBION_ALLIED_GUILD_IDS`, for example
    /// `guild-id-1,guild-id-2`. Empty items are ignored so operators can keep readable env files.
    ///
    /// # Example
    /// ```ignore
    /// let allied_ids = cfg.albion_allied_guild_ids();
    /// assert!(allied_ids.iter().any(|id| id == "guild-id-1"));
    /// ```
    #[must_use]
    pub fn albion_allied_guild_ids(&self) -> Vec<String> {
        split_csv(&self.albion_allied_guild_ids)
    }

    /// Parses optional comma-separated allied guild names as a fallback for incomplete upstream
    /// battle payloads.
    ///
    /// IDs are preferred because names can change, but AlbionBB can occasionally omit IDs in
    /// summary rows. Keeping names configurable prevents allies from leaking into opponent charts.
    ///
    /// # Example
    /// ```ignore
    /// let allied_names = cfg.albion_allied_guild_names();
    /// assert!(allied_names.iter().any(|name| name == "BetterGetBack"));
    /// ```
    #[must_use]
    pub fn albion_allied_guild_names(&self) -> Vec<String> {
        split_csv(&self.albion_allied_guild_names)
    }
}

/// Normalizes comma-separated env values while preserving the original item spelling.
///
/// This helper avoids allocating empty tokens and keeps configuration parsing consistent across
/// IDs and names. It performs no I/O and is safe to call from any thread.
///
/// # Example
/// ```ignore
/// let items = split_csv("a, b,,c");
/// assert_eq!(items, vec!["a", "b", "c"]);
/// ```
#[must_use]
fn split_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}
