//! Application configuration loaded from environment variables.
//!
//! Uses `dotenvy` to load a `.env` file at startup and `serde` to
//! deserialize typed config from environment variables.
use axum_extra::extract::cookie::Key as CookieKey;
use serde::Deserialize;

/// Compiled-in version from `Cargo.toml` — set automatically at compile time.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Default Discord REST base URL (`Config.discord_api_base` overrides it).
pub const DEFAULT_DISCORD_API_BASE: &str = "https://discord.com/api/v10";

/// The Discord channel/role IDs that used to live here (audit log, transaction spam, CTA
/// announcements, event-ping role) now live in the `guild_settings` DB table instead — see
/// `modules::admin::service::AdminService` — so an admin can change them from the web app
/// without a redeploy. `discord_bot_token` below stays here: it is a deployment secret, not a
/// setting.
#[derive(Deserialize, Clone)]
pub struct Config {
    /// Port the HTTP server binds to (default: 3000).
    #[serde(default = "default_backend_port")]
    pub backend_port: u16,
    /// Connection string for the cluster holding the per-tenant schemas.
    pub database_url: String,
    /// Optional dedicated DSN for the control-plane schema.
    ///
    /// When unset or empty, [`Config::control_plane_url`] falls back to
    /// [`Self::database_url`]. Same cluster is the expected MVP layout; a
    /// separate URL is only useful if the control-plane is hosted elsewhere.
    #[serde(default)]
    pub control_database_url: Option<String>,
    /// Discord `OAuth2` Client ID.
    pub discord_client_id: String,
    /// Discord `OAuth2` Client Secret.
    pub discord_client_secret: String,
    /// Discord `OAuth2` Redirect URI.
    pub discord_redirect_uri: String,
    /// Shared secret for bot-to-backend authentication (optional).
    ///
    /// When set, HTTP requests carrying the `X-Bot-Secret` header with this value are
    /// treated as authenticated bot requests and resolved to a local user via the
    /// `X-Discord-Id` header. Leave unset (or blank) to disable bot header auth entirely;
    /// always read it through [`Config::bot_secret`], which treats a blank value as unset.
    ///
    /// This is a platform-wide master key, not an ordinary API token: a request that
    /// presents it correctly but omits `X-Discord-Id` runs as `bot_system` with
    /// `UserContext::is_superadmin`
    /// true (see `try_from_bot_headers`), bypassing every permission check on whichever
    /// tenant `X-Guild-Id` names. Treat it like a root credential — generate it with the
    /// same care as `SESSION_SECRET`, store it only in the backend's and the bot's own
    /// secret store, and rotate it if either deployment is compromised.
    pub bot_api_secret: Option<String>,
    /// Discord Bot Token (optional).
    pub discord_bot_token: Option<String>,
    /// Base URL of the Discord REST API (default: `https://discord.com/api/v10`).
    ///
    /// Overridable so staging and tests can point the backend at a stub server.
    #[serde(default = "default_discord_api_base")]
    pub discord_api_base: String,
    /// Per-call timeout in seconds for Discord REST requests (default: 10).
    #[serde(default = "default_discord_api_timeout")]
    pub discord_api_timeout_secs: u64,
    /// Super Admin Discord User ID.
    pub super_admin_discord_id: String,
    /// Secret used to encrypt/authenticate the `session_user` cookie (see [`Config::session_key`]).
    ///
    /// Must be at least 64 bytes of random data — generate one with `openssl rand -hex 64` and
    /// keep it stable across deploys (rotating it invalidates every active session). Required:
    /// the server refuses to start without a sufficiently long secret, so a broken deployment
    /// fails fast instead of ever serving forgeable sessions.
    pub session_secret: String,
    /// URL of the frontend for redirection (default: <http://localhost:5173>, Vite dev).
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
    /// Base URL for the `AlbionBB` API. Defaults to the public endpoint.
    #[serde(default = "default_albionbb_base_url")]
    pub albionbb_base_url: String,
    /// Request timeout in seconds for `AlbionBB` API requests. Defaults to 60.
    #[serde(default = "default_albionbb_timeout")]
    pub albionbb_request_timeout_secs: u64,
    /// Request timeout in seconds for Albion Online Data requests. Defaults to 30.
    #[serde(default = "default_albiondata_timeout")]
    pub albiondata_request_timeout_secs: u64,
    /// What to do with a request whose tenant kind the module is not offered to
    /// (`log` or `enforce`, see `modules::capabilities::gate`). Defaults to `log`.
    #[serde(default = "default_module_kind_enforcement")]
    pub module_kind_enforcement: String,
}

/// Hand-written so a stray `{cfg:?}` in a log line, panic message, or error
/// wrapper can never print a live secret. `derive(Debug)` printed every field
/// verbatim, `database_url`, `session_secret`, `bot_api_secret`,
/// `discord_client_secret`, `discord_bot_token` and `mistral_api_key`
/// included — `database_url` in particular embeds the Postgres password
/// (`postgres://user:pass@host/db`), not just a hostname.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        /// `Some("<redacted>")`/`None` for an optional secret, so presence is
        /// still visible without the value.
        fn redact_option(value: &Option<String>) -> Option<&'static str> {
            value.as_ref().map(|_| "<redacted>")
        }
        f.debug_struct("Config")
            .field("backend_port", &self.backend_port)
            .field("database_url", &"<redacted>")
            .field(
                "control_database_url",
                &redact_option(&self.control_database_url),
            )
            .field("discord_client_id", &self.discord_client_id)
            .field("discord_client_secret", &"<redacted>")
            .field("discord_redirect_uri", &self.discord_redirect_uri)
            .field("bot_api_secret", &redact_option(&self.bot_api_secret))
            .field("discord_bot_token", &redact_option(&self.discord_bot_token))
            .field("discord_api_base", &self.discord_api_base)
            .field("discord_api_timeout_secs", &self.discord_api_timeout_secs)
            .field("super_admin_discord_id", &self.super_admin_discord_id)
            .field("session_secret", &"<redacted>")
            .field("frontend_url", &self.frontend_url)
            .field("albion_api_region", &self.albion_api_region)
            .field("albion_guild_id", &self.albion_guild_id)
            .field("albion_allied_guild_ids", &self.albion_allied_guild_ids)
            .field("albion_allied_guild_names", &self.albion_allied_guild_names)
            .field("mistral_api_key", &"<redacted>")
            .field("albionbb_base_url", &self.albionbb_base_url)
            .field(
                "albionbb_request_timeout_secs",
                &self.albionbb_request_timeout_secs,
            )
            .field(
                "albiondata_request_timeout_secs",
                &self.albiondata_request_timeout_secs,
            )
            .field("module_kind_enforcement", &self.module_kind_enforcement)
            .finish()
    }
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

fn default_discord_api_base() -> String {
    DEFAULT_DISCORD_API_BASE.to_string()
}

fn default_discord_api_timeout() -> u64 {
    10
}

fn default_albionbb_timeout() -> u64 {
    60
}

fn default_albiondata_timeout() -> u64 {
    30
}

fn default_module_kind_enforcement() -> String {
    "log".to_string()
}

impl Config {
    /// Loads configuration from environment variables.
    ///
    /// # Panics
    ///
    /// Panics when a required variable is missing or malformed — appropriate at startup, where a
    /// broken deployment should fail fast.
    #[must_use]
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

    /// The shared bot secret, or `None` when bot header auth is disabled.
    ///
    /// A blank value counts as unset. `envy` turns `BOT_API_SECRET=` (set but empty, which is
    /// what `docker-compose` passes for an undefined `${BOT_API_SECRET}`) into `Some("")`, and
    /// an empty `X-Bot-Secret:` header would then match it and run as `bot_system` superadmin.
    /// Every bot-auth check must read the secret through this accessor, never the raw field.
    #[must_use]
    pub fn bot_secret(&self) -> Option<&str> {
        self.bot_api_secret
            .as_deref()
            .filter(|secret| !secret.trim().is_empty())
    }

    /// DSN used to open the control-plane pool.
    ///
    /// Falls back to [`Self::database_url`] so existing deployments keep a
    /// single `DATABASE_URL`. The connection still pins `search_path` to
    /// [`crate::postgres::CONTROL_SCHEMA`].
    #[must_use]
    pub fn control_plane_url(&self) -> &str {
        self.control_database_url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .unwrap_or(self.database_url.as_str())
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
    /// IDs are preferred because names can change, but `AlbionBB` can occasionally omit IDs in
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
pub fn split_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(any(test, feature = "test-support"))]
impl Config {
    #[must_use]
    pub fn for_tests() -> Self {
        Self {
            backend_port: 3000,
            database_url: "postgres://localhost/weaklings".to_string(),
            control_database_url: None,
            discord_client_id: "id".to_string(),
            discord_client_secret: "secret".to_string(),
            discord_redirect_uri: "http://localhost/callback".to_string(),
            bot_api_secret: None,
            discord_bot_token: None,
            // Unroutable on purpose: a test that forgets to stub Discord fails fast.
            discord_api_base: "http://127.0.0.1:1/api/v10".to_string(),
            discord_api_timeout_secs: 10,
            super_admin_discord_id: "admin".to_string(),
            session_secret: "x".repeat(64),
            frontend_url: "http://localhost".to_string(),
            albion_api_region: "europe".to_string(),
            albion_guild_id: "albion".to_string(),
            albion_allied_guild_ids: String::new(),
            albion_allied_guild_names: String::new(),
            mistral_api_key: String::new(),
            albionbb_base_url: "http://localhost".to_string(),
            albionbb_request_timeout_secs: 60,
            albiondata_request_timeout_secs: 30,
            module_kind_enforcement: "log".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stub() -> Config {
        Config::for_tests()
    }

    #[test]
    fn control_plane_url_falls_back_to_database_url() {
        let cfg = stub();
        assert_eq!(cfg.control_plane_url(), "postgres://localhost/weaklings");
    }

    #[test]
    fn control_plane_url_uses_dedicated_dsn_when_set() {
        let mut cfg = stub();
        cfg.control_database_url = Some("postgres://localhost/control".to_string());
        assert_eq!(cfg.control_plane_url(), "postgres://localhost/control");
    }

    #[test]
    fn control_plane_url_treats_blank_as_unset() {
        let mut cfg = stub();
        cfg.control_database_url = Some("   ".to_string());
        assert_eq!(cfg.control_plane_url(), "postgres://localhost/weaklings");
    }

    #[test]
    fn bot_secret_treats_blank_as_unset() {
        let mut cfg = stub();
        assert_eq!(cfg.bot_secret(), None);
        for blank in ["", "   ", "\t\n"] {
            cfg.bot_api_secret = Some(blank.to_owned());
            assert_eq!(cfg.bot_secret(), None, "{blank:?} must disable bot auth");
        }
        cfg.bot_api_secret = Some("real-secret".to_owned());
        assert_eq!(cfg.bot_secret(), Some("real-secret"));
    }

    /// A stray `{cfg:?}` in a log line, panic message, or error wrapper must
    /// never print a live secret — see the `Debug` impl above.
    #[test]
    fn debug_output_redacts_every_secret_but_not_the_rest() {
        let mut cfg = stub();
        cfg.database_url = "postgres://weaklings:sup3r_secret@db.internal/weaklings".to_owned();
        cfg.discord_client_secret = "client-secret-value".to_owned();
        cfg.session_secret = "s".repeat(64);
        cfg.mistral_api_key = "mistral-key-value".to_owned();
        cfg.bot_api_secret = Some("bot-secret-value".to_owned());
        cfg.discord_bot_token = Some("bot-token-value".to_owned());
        cfg.control_database_url = Some("postgres://weaklings:other_secret@db2/control".to_owned());

        let printed = format!("{cfg:?}");

        for secret in [
            "sup3r_secret",
            "client-secret-value",
            cfg.session_secret.as_str(),
            "mistral-key-value",
            "bot-secret-value",
            "bot-token-value",
            "other_secret",
        ] {
            assert!(
                !printed.contains(secret),
                "Debug output leaked a secret: {printed}"
            );
        }
        // Presence of an optional secret is still visible, just not its value —
        // an operator debugging "why is bot auth 401ing" can see it's set.
        assert!(printed.contains("bot_api_secret: Some(\"<redacted>\")"));
        // Non-secret fields are unaffected.
        assert!(printed.contains("super_admin_discord_id: \"admin\""));
        assert!(printed.contains("albion_guild_id: \"albion\""));
    }
}
