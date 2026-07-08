//! Albion Online public gameinfo API client.
//!
//! Reusable, generic wrapper around the unauthenticated Albion Online gameinfo REST API
//! (see <https://www.tools4albion.com/api_info.php>). The upstream API has no documented
//! authentication or rate limiting. Response structs only capture the fields this backend
//! actually uses; unknown fields are ignored by serde and missing/null fields fall back to
//! `Option`/`#[serde(default)]` since the upstream schema mixes PascalCase and camelCase keys
//! and occasionally returns `null` for numeric fields (verified via live requests).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use crate::errors::AppError;

/// Supported Albion Online API regions, each backed by a distinct gameinfo server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlbionRegion {
    Americas,
    Europe,
    Asia,
}

impl AlbionRegion {
    /// Parses a region from a loosely-cased env value, defaulting to Europe.
    #[must_use]
    pub fn from_env_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "americas" | "america" | "us" => Self::Americas,
            "asia" | "sgp" => Self::Asia,
            _ => Self::Europe,
        }
    }

    #[must_use]
    pub fn base_url(self) -> &'static str {
        match self {
            Self::Americas => "https://gameinfo.albiononline.com/api/gameinfo",
            Self::Europe => "https://gameinfo-ams.albiononline.com/api/gameinfo",
            Self::Asia => "https://gameinfo-sgp.albiononline.com/api/gameinfo",
        }
    }
}

/// A player entry as returned by the global `/search` endpoint. JSON keys on the wire are
/// PascalCase (`Id`, `Name`, ...) — this app re-exposes them as snake_case; the `#[serde(alias)]`
/// on each field accepts the upstream PascalCase name when deserializing from Albion's API, but
/// this app's own JSON output (what the frontend receives) is always the snake_case shown here.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionPlayerSummary {
    /// Albion Online's opaque player id.
    #[serde(alias = "Id")]
    #[schema(example = "aPngkjfLT2CGiZoWXLr8UQ")]
    pub id: String,
    /// The player's in-game display name.
    #[serde(alias = "Name")]
    #[schema(example = "Kay")]
    pub name: String,
    #[serde(alias = "GuildId", default)]
    #[schema(example = "i014P6l3THS-HtXDlUHVdA")]
    pub guild_id: Option<String>,
    #[serde(alias = "GuildName", default)]
    #[schema(example = "Ukraine Defence Forces")]
    pub guild_name: Option<String>,
    /// Lifetime PvP kill fame. Sometimes `null` upstream for low-activity players.
    #[serde(alias = "KillFame", default)]
    #[schema(example = 102244.0)]
    pub kill_fame: Option<f64>,
    #[serde(alias = "DeathFame", default)]
    #[schema(example = 570792.0)]
    pub death_fame: Option<f64>,
}

/// A guild entry as returned by the global `/search` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionGuildSummary {
    /// Albion Online's opaque guild id.
    #[serde(alias = "Id")]
    #[schema(example = "Nb-9mG2eTfOTzVfE9YDB-A")]
    pub id: String,
    /// The guild's in-game name.
    #[serde(alias = "Name")]
    #[schema(example = "KAYA")]
    pub name: String,
    #[serde(alias = "KillFame", default)]
    #[schema(example = 0.0)]
    pub kill_fame: Option<f64>,
    #[serde(alias = "DeathFame", default)]
    #[schema(example = 8467981.0)]
    pub death_fame: Option<f64>,
}

/// Combined result of `GET /albion/search`: every matching guild and every matching player,
/// either array possibly empty.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct AlbionSearchResult {
    #[serde(default)]
    pub guilds: Vec<AlbionGuildSummary>,
    #[serde(default)]
    pub players: Vec<AlbionPlayerSummary>,
}

/// A single member entry as returned by `GET /albion/guild/roster` (this app's wrapper around
/// Albion's `/guilds/<id>/members`) — always scoped to the one guild configured via
/// `ALBION_GUILD_ID`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionGuildMember {
    /// Albion Online's opaque player id — pass this as `albion_player_id` to `POST /albion/link`.
    #[serde(alias = "Id")]
    #[schema(example = "Uo3eaSQOQeiS4akPWd5WCg")]
    pub id: String,
    /// The player's in-game display name — pass this as `albion_player_name` to `POST /albion/link`.
    #[serde(alias = "Name")]
    #[schema(example = "MonkeyLing")]
    pub name: String,
    #[serde(alias = "GuildId", default)]
    #[schema(example = "QG5EcSgfSLWGfUtr6d5AWw")]
    pub guild_id: Option<String>,
    #[serde(alias = "GuildName", default)]
    #[schema(example = "Weaklings")]
    pub guild_name: Option<String>,
    #[serde(alias = "KillFame", default)]
    #[schema(example = 58940.0)]
    pub kill_fame: Option<f64>,
    #[serde(alias = "DeathFame", default)]
    #[schema(example = 124373.0)]
    pub death_fame: Option<f64>,
}

/// Guild profile as returned by `GET /albion/guilds/{id}`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionGuild {
    /// Albion Online's opaque guild id.
    #[serde(alias = "Id")]
    #[schema(example = "QG5EcSgfSLWGfUtr6d5AWw")]
    pub id: String,
    /// The guild's in-game name.
    #[serde(alias = "Name")]
    #[schema(example = "Weaklings")]
    pub name: String,
    #[serde(alias = "FounderId", default)]
    #[schema(example = "XUBkSg3CTn2q3Cz3H2nEXQ")]
    pub founder_id: Option<String>,
    #[serde(alias = "FounderName", default)]
    #[schema(example = "Galvdon")]
    pub founder_name: Option<String>,
    #[serde(alias = "MemberCount", default)]
    #[schema(example = 3)]
    pub member_count: Option<i64>,
}

/// Player profile as returned by `GET /albion/players/{id}`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionPlayer {
    /// Albion Online's opaque player id.
    #[serde(alias = "Id")]
    #[schema(example = "aPngkjfLT2CGiZoWXLr8UQ")]
    pub id: String,
    /// The player's in-game display name.
    #[serde(alias = "Name")]
    #[schema(example = "Kay")]
    pub name: String,
    #[serde(alias = "GuildId", default)]
    #[schema(example = "i014P6l3THS-HtXDlUHVdA")]
    pub guild_id: Option<String>,
    #[serde(alias = "GuildName", default)]
    #[schema(example = "Ukraine Defence Forces")]
    pub guild_name: Option<String>,
    #[serde(alias = "KillFame", default)]
    #[schema(example = 102244.0)]
    pub kill_fame: Option<f64>,
    #[serde(alias = "DeathFame", default)]
    #[schema(example = 570792.0)]
    pub death_fame: Option<f64>,
}

/// Alliance profile as returned by Albion's `/alliances/<id>` (fetched by `AlbionService`, not
/// currently exposed as its own HTTP route — reserved for future use).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionAlliance {
    #[serde(alias = "Id")]
    pub id: String,
    #[serde(alias = "Name")]
    pub name: Option<String>,
    #[serde(alias = "Tag", default)]
    pub tag: Option<String>,
}

/// Thin typed HTTP client for the Albion Online gameinfo API.
#[derive(Clone)]
pub struct AlbionApiClient {
    http: reqwest::Client,
    base_url: &'static str,
}

impl AlbionApiClient {
    #[must_use]
    pub fn new(region: AlbionRegion) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: region.base_url(),
        }
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, AppError> {
        let url = format!("{}{}", self.base_url, path);

        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::UpstreamService(format!("Failed to contact Albion API: {e}")))?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(AppError::NotFound(format!("Albion resource not found: {url}")));
        }

        if !response.status().is_success() {
            return Err(AppError::UpstreamService(format!(
                "Albion API returned {} for {url}",
                response.status()
            )));
        }

        response.json::<T>().await.map_err(|e| {
            AppError::UpstreamService(format!("Failed to parse Albion API response from {url}: {e}"))
        })
    }

    pub async fn search(&self, query: &str) -> Result<AlbionSearchResult, AppError> {
        self.get_json(&format!("/search?q={}", urlencoding::encode(query)))
            .await
    }

    pub async fn get_player(&self, id: &str) -> Result<AlbionPlayer, AppError> {
        self.get_json(&format!("/players/{id}")).await
    }

    pub async fn get_guild(&self, id: &str) -> Result<AlbionGuild, AppError> {
        self.get_json(&format!("/guilds/{id}")).await
    }

    pub async fn get_guild_members(&self, id: &str) -> Result<Vec<AlbionGuildMember>, AppError> {
        self.get_json(&format!("/guilds/{id}/members")).await
    }

    pub async fn get_alliance(&self, id: &str) -> Result<AlbionAlliance, AppError> {
        self.get_json(&format!("/alliances/{id}")).await
    }
}
