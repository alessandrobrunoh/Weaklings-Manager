//! `AlbionBB` public API client.
//!
//! Thin typed HTTP client for the undocumented public `AlbionBB` REST API
//! (base URL `https://api.albionbb.com`, server segment `/{server}` with `server`
//! in `eu`/`na`/`asia`). Upstream JSON mixes `PascalCase` and camelCase keys, so
//! response structs use `#[serde(alias = ...)]` and `#[serde(default)]` liberally
//! to absorb shape drift. Unknown fields are silently ignored.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use utoipa::ToSchema;

use crate::albion_common::normalize_server;
use crate::errors::AppError;
use crate::modules::battles::entities::BattlePlayer;
use crate::runtime::backoff::BackoffPolicy;

/// Default base URL of the public `AlbionBB` API.
const DEFAULT_BASE_URL: &str = "https://api.albionbb.com";

/// Default request timeout if the caller does not specify one.
const DEFAULT_TIMEOUT_SECS: u64 = 60;

/// Requests in flight at once across every clone of one client, so a burst of
/// tenant workers and HTTP callers cannot overrun the shared upstream.
const MAX_CONCURRENT_REQUESTS: usize = 4;

/// Retries after the first attempt for HTTP 429, 5xx and connection failures.
/// Timeouts are not retried: a slow upstream would multiply the caller's wait.
const MAX_RETRIES: u32 = 2;

/// Delay between attempts when the upstream sends no usable `Retry-After`.
const RETRY_POLICY: BackoffPolicy = BackoffPolicy {
    base: Duration::from_millis(500),
    cap: Duration::from_secs(8),
    max_exponent: 4,
    jitter: 0.2,
};

/// Upper bound honoured for a `Retry-After` header.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(30);

/// Pagination metadata returned alongside a list of battles.
///
/// `AlbionBB`'s `/battles` endpoint currently returns a raw array, not a wrapped
/// envelope with totals. We still keep this struct so the service layer can use
/// a stable return type; the fields are simply `None` for now.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AlbionBbPageMeta {
    /// Total number of results across all pages, if known.
    pub total_results: Option<i64>,
    /// Total number of pages, if known.
    pub total_pages: Option<i64>,
}

fn deserialize_non_empty_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt = Option::<String>::deserialize(deserializer)?;
    Ok(opt.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }))
}

/// A guild entry nested inside an `AlbionBB` battle.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionBbGuild {
    /// `AlbionBB` opaque guild id.
    #[serde(
        alias = "AlbionId",
        alias = "albionId",
        alias = "Id",
        alias = "id",
        default
    )]
    pub id: String,
    /// Guild name.
    #[serde(alias = "Name", alias = "name", default)]
    pub name: String,
    /// Alliance name, if in an alliance.
    #[serde(
        alias = "Alliance",
        alias = "alliance",
        alias = "AllianceName",
        alias = "allianceName",
        alias = "AllianceTag",
        alias = "allianceTag",
        alias = "alliance_name",
        alias = "alliance_tag",
        alias = "Alliance_Name",
        alias = "Alliance_Tag",
        alias = "Tag",
        alias = "tag",
        default,
        deserialize_with = "deserialize_non_empty_string"
    )]
    pub alliance_name: Option<String>,
    /// Alliance id, if in an alliance.
    #[serde(
        alias = "AllianceId",
        alias = "allianceId",
        alias = "alliance_id",
        default,
        deserialize_with = "deserialize_non_empty_string"
    )]
    pub alliance_id: Option<String>,
    /// Number of players from this guild in the battle.
    #[serde(alias = "Players", alias = "players", default)]
    pub players: i64,
    /// Kills attributable to this guild.
    #[serde(alias = "Kills", alias = "kills", default)]
    pub kills: i64,
    /// Deaths attributable to this guild.
    #[serde(alias = "Deaths", alias = "deaths", default)]
    pub deaths: i64,
    /// Kill fame attributable to this guild.
    #[serde(alias = "KillFame", alias = "killFame", alias = "fame", default)]
    pub kill_fame: i64,
    /// Whether this guild was the winner of the battle.
    #[serde(alias = "Winner", alias = "winner", alias = "won", default)]
    pub winner: bool,
    /// Average item power of guild members.
    #[serde(
        alias = "Ip",
        alias = "ip",
        alias = "ItemPower",
        alias = "itemPower",
        alias = "AverageItemPower",
        alias = "averageItemPower",
        default
    )]
    pub average_item_power: f64,
}

/// A player entry nested inside an `AlbionBB` battle.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionBbPlayer {
    /// `AlbionBB` opaque player id. Not currently exposed by `AlbionBB`'s battle-detail player list.
    #[serde(alias = "Id", alias = "id", default)]
    pub id: String,
    /// Player display name.
    #[serde(alias = "Name", alias = "name", default)]
    pub name: String,
    /// Guild id the player belonged to during the battle. Not currently exposed by `AlbionBB` here.
    #[serde(alias = "GuildId", alias = "guildId", default)]
    pub guild_id: String,
    /// Guild name the player belonged to during the battle.
    #[serde(alias = "GuildName", alias = "guildName", default)]
    pub guild_name: String,
    /// Alliance name the player belonged to during the battle.
    #[serde(
        alias = "Alliance",
        alias = "alliance",
        alias = "AllianceName",
        alias = "allianceName",
        alias = "AllianceTag",
        alias = "allianceTag",
        alias = "alliance_name",
        alias = "alliance_tag",
        alias = "Alliance_Name",
        alias = "Alliance_Tag",
        alias = "Tag",
        alias = "tag",
        default,
        deserialize_with = "deserialize_non_empty_string"
    )]
    pub alliance_name: Option<String>,
    /// Alliance id the player belonged to during the battle.
    #[serde(
        alias = "AllianceId",
        alias = "allianceId",
        alias = "alliance_id",
        default,
        deserialize_with = "deserialize_non_empty_string"
    )]
    pub alliance_id: Option<String>,
    /// Kills attributable to this player.
    #[serde(alias = "Kills", alias = "kills", default)]
    pub kills: i64,
    /// Deaths attributable to this player.
    #[serde(alias = "Deaths", alias = "deaths", default)]
    pub deaths: i64,
    /// Kill fame attributable to this player.
    #[serde(alias = "KillFame", alias = "killFame", default)]
    pub kill_fame: i64,
    /// Death fame attributable to this player.
    #[serde(alias = "DeathFame", alias = "deathFame", default)]
    pub death_fame: i64,
    /// Average item power of this player during the battle.
    #[serde(
        alias = "Ip",
        alias = "ip",
        alias = "ItemPower",
        alias = "itemPower",
        default
    )]
    pub item_power: f64,
}

impl From<&AlbionBbPlayer> for BattlePlayer {
    fn from(p: &AlbionBbPlayer) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            guild_id: p.guild_id.clone(),
            guild_name: p.guild_name.clone(),
            alliance_name: p.alliance_name.clone(),
            alliance_id: p.alliance_id.clone(),
            kills: p.kills,
            deaths: p.deaths,
            kill_fame: p.kill_fame,
            death_fame: p.death_fame,
            item_power: p.item_power,
            is_friendly: false,
        }
    }
}

/// A battle entry as returned by `AlbionBB`'s battle-listing endpoints.
///
/// Only the fields used downstream are modelled; unknown fields are ignored.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionBbBattleSummary {
    /// `AlbionBB` opaque battle id (numeric upstream).
    #[serde(
        alias = "AlbionId",
        alias = "albionId",
        alias = "Id",
        alias = "BattleId",
        alias = "battleId",
        alias = "id",
        default
    )]
    pub id: i64,
    /// Battle start time as an ISO 8601 string.
    #[serde(
        alias = "StartedAt",
        alias = "startedAt",
        alias = "StartTime",
        alias = "startTime",
        default
    )]
    pub start_time: String,
    /// Battle end time as an ISO 8601 string.
    #[serde(
        alias = "FinishedAt",
        alias = "finishedAt",
        alias = "EndTime",
        alias = "endTime",
        default
    )]
    pub end_time: String,
    /// Total number of players across all guilds.
    #[serde(
        alias = "TotalPlayers",
        alias = "totalPlayers",
        alias = "players",
        default
    )]
    pub total_players: i64,
    /// Total number of kills in the battle.
    #[serde(alias = "TotalKills", alias = "totalKills", alias = "kills", default)]
    pub total_kills: i64,
    /// Total fame generated by the battle.
    #[serde(alias = "TotalFame", alias = "totalFame", alias = "fame", default)]
    pub total_fame: i64,
    /// Per-guild breakdown. May be partial on list endpoints and richer on detail.
    #[serde(alias = "Guilds", alias = "guilds", default)]
    pub guilds: Vec<AlbionBbGuild>,
}

/// A full battle detail entry, extending the summary with per-player breakdown.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionBbBattleDetail {
    /// All summary fields inlined.
    #[serde(flatten)]
    pub summary: AlbionBbBattleSummary,
    /// Per-player breakdown (may be empty if upstream omits it from detail).
    #[serde(alias = "Players", alias = "players", default)]
    pub players: Vec<AlbionBbPlayer>,
}

/// A kill participant (killer or victim) inside a kill event.
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct AlbionBbKillParticipant {
    /// `AlbionBB` opaque player id.
    #[serde(alias = "Id", alias = "id", default)]
    pub id: String,
    /// Player display name.
    #[serde(alias = "Name", alias = "name", default)]
    pub name: String,
    /// Guild id, if upstream includes it.
    #[serde(
        alias = "GuildId",
        alias = "guildId",
        alias = "guild_id",
        default,
        deserialize_with = "deserialize_non_empty_string"
    )]
    pub guild_id: Option<String>,
    /// Guild name, if upstream includes it.
    #[serde(
        alias = "GuildName",
        alias = "guildName",
        alias = "guild_name",
        default,
        deserialize_with = "deserialize_non_empty_string"
    )]
    pub guild_name: Option<String>,
    /// Alliance name, if upstream includes it.
    #[serde(
        alias = "Alliance",
        alias = "alliance",
        alias = "AllianceName",
        alias = "allianceName",
        alias = "AllianceTag",
        alias = "allianceTag",
        alias = "alliance_name",
        alias = "alliance_tag",
        alias = "Alliance_Name",
        alias = "Alliance_Tag",
        alias = "Tag",
        alias = "tag",
        default,
        deserialize_with = "deserialize_non_empty_string"
    )]
    pub alliance_name: Option<String>,
    /// Alliance id, if upstream includes it.
    #[serde(
        alias = "AllianceId",
        alias = "allianceId",
        alias = "alliance_id",
        default,
        deserialize_with = "deserialize_non_empty_string"
    )]
    pub alliance_id: Option<String>,
    /// Average item power of this participant in the kill event.
    #[serde(
        alias = "AverageItemPower",
        alias = "averageItemPower",
        alias = "Ip",
        alias = "ip",
        default
    )]
    pub average_item_power: f64,
}

/// A kill event inside a battle, as returned by `/battles/kills?ids=`.
///
/// `raw` captures the entire upstream JSON object verbatim, so the frontend can
/// render any `AlbionBB` field we did not model explicitly.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionBbKillEvent {
    /// `AlbionBB` kill event id.
    #[serde(
        alias = "EventId",
        alias = "eventId",
        alias = "id",
        alias = "Id",
        default
    )]
    pub event_id: i64,
    /// Kill timestamp as an ISO 8601 string.
    #[serde(
        alias = "TimeStamp",
        alias = "timeStamp",
        alias = "Time",
        alias = "time",
        default
    )]
    pub time: String,
    /// The killer.
    #[serde(alias = "Killer", alias = "killer", default)]
    pub killer: AlbionBbKillParticipant,
    /// The victim.
    #[serde(alias = "Victim", alias = "victim", default)]
    pub victim: AlbionBbKillParticipant,
    /// Killer average item power.
    #[serde(
        alias = "KillerItemPower",
        alias = "killerItemPower",
        alias = "killerAverageItemPower",
        default
    )]
    pub killer_item_power: f64,
    /// Victim average item power.
    #[serde(
        alias = "VictimItemPower",
        alias = "victimItemPower",
        alias = "victimAverageItemPower",
        default
    )]
    pub victim_item_power: f64,
    /// Total fame awarded for this kill.
    #[serde(
        alias = "TotalVictimKillFame",
        alias = "totalVictimKillFame",
        alias = "TotalKillFame",
        alias = "totalKillFame",
        alias = "KillFame",
        alias = "killFame",
        alias = "Fame",
        alias = "fame",
        default
    )]
    pub total_kill_fame: i64,
    /// The entire upstream kill event preserved verbatim.
    #[serde(default, skip_serializing)]
    pub raw: serde_json::Value,
}

/// Generic guild info as returned by `/guilds/{id}`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AlbionBbGuildInfo {
    /// `AlbionBB` opaque guild id.
    #[serde(
        alias = "AlbionId",
        alias = "albionId",
        alias = "Id",
        alias = "id",
        default
    )]
    pub id: String,
    /// Guild name.
    #[serde(alias = "Name", alias = "name", default)]
    pub name: String,
    /// Raw payload preserved verbatim.
    #[serde(default, skip_serializing)]
    pub raw: serde_json::Value,
}

/// Optional filters accepted by `/battles`.
#[derive(Debug, Clone, Default)]
pub struct AlbionBbBattlesFilters {
    /// Free-text search string (sets the `search` query param).
    pub search: Option<String>,
    /// Restrict to battles involving this guild (sets `guildId`).
    pub guild_id: Option<String>,
    /// Minimum total players threshold.
    pub min_players: Option<i64>,
    /// Minimum players from the queried guild.
    pub min_guild_players: Option<i64>,
    /// 1-indexed page number.
    pub page: Option<u64>,
}

/// Thin typed HTTP client for the public `AlbionBB` API.
#[derive(Clone)]
pub struct AlbionBbApiClient {
    http: reqwest::Client,
    base_url: String,
    gate: Arc<Semaphore>,
    retry: BackoffPolicy,
}

impl AlbionBbApiClient {
    #[must_use]
    pub fn new(base_url: Option<String>, timeout_secs: Option<u64>) -> Self {
        let base_url = base_url
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        let timeout = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS));
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            gate: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
            retry: RETRY_POLICY,
        }
    }

    /// Replaces the retry delays, so tests do not wait on real backoff.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn with_retry_policy(mut self, retry: BackoffPolicy) -> Self {
        self.retry = retry;
        self
    }

    /// Builds a query string from a slice of `(key, optional value)` pairs.
    fn build_query(params: &[(&str, Option<String>)]) -> String {
        let pairs: Vec<String> = params
            .iter()
            .filter_map(|(k, v)| {
                v.as_ref()
                    .map(|val| format!("{k}={}", urlencoding::encode(val)))
            })
            .collect();
        if pairs.is_empty() {
            String::new()
        } else {
            format!("?{}", pairs.join("&"))
        }
    }

    /// GETs `path` and decodes the JSON body.
    ///
    /// Each attempt holds one permit of the shared gate. 429, 5xx and connection
    /// failures are retried up to `MAX_RETRIES` times, waiting for the
    /// `Retry-After` header when present and for the jittered `retry` policy
    /// otherwise. A 404 maps to `NotFound`; everything else to `UpstreamService`.
    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, AppError> {
        let url = format!("{}{path}", self.base_url);
        let mut attempt: u32 = 0;
        loop {
            let response = {
                let _permit =
                    self.gate.acquire().await.map_err(|_| {
                        AppError::UpstreamService("AlbionBB gate closed".to_string())
                    })?;
                self.http.get(&url).send().await
            };

            let retry_after = match response {
                Err(error) if error.is_connect() && attempt < MAX_RETRIES => None,
                Err(error) => {
                    return Err(AppError::UpstreamService(format!(
                        "Failed to contact AlbionBB API: {error}"
                    )));
                }
                Ok(response) => {
                    let status = response.status();
                    if status == reqwest::StatusCode::NOT_FOUND {
                        return Err(AppError::NotFound(format!(
                            "AlbionBB resource not found: {url}"
                        )));
                    }
                    if status.is_success() {
                        return response.json::<T>().await.map_err(|e| {
                            AppError::UpstreamService(format!(
                                "Failed to parse AlbionBB API response from {url}: {e}"
                            ))
                        });
                    }
                    let retryable = status == reqwest::StatusCode::TOO_MANY_REQUESTS
                        || status.is_server_error();
                    if !retryable || attempt >= MAX_RETRIES {
                        return Err(AppError::UpstreamService(format!(
                            "AlbionBB API returned {status} for {url}"
                        )));
                    }
                    retry_after_header(&response)
                }
            };

            let delay =
                retry_after.unwrap_or_else(|| self.retry.delay(attempt, &mut rand::thread_rng()));
            tracing::warn!(
                attempt = attempt + 1,
                delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                path,
                "AlbionBB request failed transiently, retrying"
            );
            tokio::time::sleep(delay).await;
            attempt += 1;
        }
    }

    /// Fetches battles matching the given filters. `AlbionBB` currently returns a
    /// raw array for this endpoint, so page metadata is unavailable.
    pub async fn get_battles(
        &self,
        server: Option<&str>,
        filters: &AlbionBbBattlesFilters,
    ) -> Result<(Vec<AlbionBbBattleSummary>, AlbionBbPageMeta), AppError> {
        let server = normalize_server(server);
        let query = Self::build_query(&[
            ("search", filters.search.clone()),
            ("guildId", filters.guild_id.clone()),
            ("minPlayers", filters.min_players.map(|v| v.to_string())),
            (
                "minGuildPlayers",
                filters.min_guild_players.map(|v| v.to_string()),
            ),
            ("page", filters.page.map(|v| v.to_string())),
        ]);
        let path = format!("/{server}/battles{query}");

        let data: Vec<AlbionBbBattleSummary> = self.get_json(&path).await?;
        Ok((
            data,
            AlbionBbPageMeta {
                total_results: None,
                total_pages: None,
            },
        ))
    }

    /// Fetches a single battle by id, including per-player breakdown.
    pub async fn get_battle(
        &self,
        server: Option<&str>,
        battle_id: i64,
    ) -> Result<AlbionBbBattleDetail, AppError> {
        let server = normalize_server(server);
        let path = format!("/{server}/battles/{battle_id}");
        self.get_json(&path).await
    }

    /// Fetches kill events for a battle.
    pub async fn get_battle_kills(
        &self,
        server: Option<&str>,
        battle_id: i64,
    ) -> Result<Vec<AlbionBbKillEvent>, AppError> {
        let server = normalize_server(server);
        let query = Self::build_query(&[("ids", Some(battle_id.to_string()))]);
        let path = format!("/{server}/battles/kills{query}");
        let raw_items: Vec<serde_json::Value> = self.get_json(&path).await?;

        raw_items
            .into_iter()
            .map(|raw| {
                let mut event: AlbionBbKillEvent =
                    serde_json::from_value(raw.clone()).map_err(|e| {
                        AppError::UpstreamService(format!(
                            "Failed to parse AlbionBB kill event from {path}: {e}"
                        ))
                    })?;
                event.raw = raw;
                if event.killer_item_power == 0.0 {
                    event.killer_item_power = event.killer.average_item_power;
                }
                if event.victim_item_power == 0.0 {
                    event.victim_item_power = event.victim.average_item_power;
                }
                Ok(event)
            })
            .collect()
    }

    /// Fetches player career stats. Returned raw because the payload shape is
    /// unstable and we don't model it yet.
    pub async fn get_player_stats(
        &self,
        server: Option<&str>,
        player_id: &str,
        min_players: Option<i64>,
    ) -> Result<serde_json::Value, AppError> {
        let server = normalize_server(server);
        let query = Self::build_query(&[("minPlayers", min_players.map(|v| v.to_string()))]);
        let path = format!(
            "/{server}/stats/players/{}{query}",
            urlencoding::encode(player_id)
        );
        self.get_json(&path).await
    }

    /// Fetches guild info.
    pub async fn get_guild(
        &self,
        server: Option<&str>,
        guild_id: &str,
    ) -> Result<AlbionBbGuildInfo, AppError> {
        let server = normalize_server(server);
        let path = format!("/{server}/guilds/{}", urlencoding::encode(guild_id));
        self.get_json(&path).await
    }
}

/// Parses a `Retry-After` header given in seconds, capped at `MAX_RETRY_AFTER`.
fn retry_after_header(response: &reqwest::Response) -> Option<Duration> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(|seconds| Duration::from_secs(seconds).min(MAX_RETRY_AFTER))
}

impl Default for AlbionBbApiClient {
    fn default() -> Self {
        Self::new(None, None)
    }
}

#[cfg(test)]
mod tests {
    use super::{AlbionBbBattleDetail, AlbionBbBattleSummary, AlbionBbKillEvent};

    #[test]
    fn deserializes_real_battle_list_payload() {
        let json = r#"[
          {
            "albionId": 397700308,
            "startedAt": "2026-07-07T22:43:17.865Z",
            "totalFame": 9220600,
            "totalKills": 28,
            "totalPlayers": 83,
            "guilds": [
              { "name": "Weaklings", "alliance": "TVG", "killFame": 2392340 },
              { "name": "Black Sentinels", "alliance": "TVG", "killFame": 1386555 }
            ]
          }
        ]"#;

        let battles: Vec<AlbionBbBattleSummary> =
            serde_json::from_str(json).expect("battle list payload should deserialize");

        assert_eq!(battles.len(), 1);
        assert_eq!(battles[0].id, 397700308);
        assert_eq!(battles[0].start_time, "2026-07-07T22:43:17.865Z");
        assert_eq!(battles[0].total_players, 83);
        assert_eq!(battles[0].total_kills, 28);
        assert_eq!(battles[0].total_fame, 9220600);
        assert_eq!(battles[0].guilds[0].name, "Weaklings");
        assert_eq!(battles[0].guilds[0].kill_fame, 2392340);
    }

    #[test]
    fn deserializes_real_battle_detail_payload() {
        let json = r#"{
          "albionId": 397700308,
          "startedAt": "2026-07-07T22:43:17.865Z",
          "finishedAt": "2026-07-07T22:52:55.508Z",
          "totalFame": 9220600,
          "totalKills": 28,
          "totalPlayers": 83,
          "guilds": [
            {
              "albionId": "QG5EcSgfSLWGfUtr6d5AWw",
              "name": "Weaklings",
              "alliance": "TVG",
              "kills": 4,
              "deaths": 0,
              "killFame": 2392340,
              "players": 6,
              "ip": 1486
            }
          ],
          "players": [
            {
              "name": "Galvdon",
              "guildName": "Weaklings",
              "allianceName": "TVG",
              "kills": 3,
              "deaths": 0,
              "killFame": 394796,
              "deathFame": 0,
              "ip": 1396,
              "role": "range"
            }
          ]
        }"#;

        let battle: AlbionBbBattleDetail =
            serde_json::from_str(json).expect("battle detail payload should deserialize");

        assert_eq!(battle.summary.id, 397700308);
        assert_eq!(battle.summary.end_time, "2026-07-07T22:52:55.508Z");
        assert_eq!(battle.summary.guilds[0].id, "QG5EcSgfSLWGfUtr6d5AWw");
        assert_eq!(battle.summary.guilds[0].players, 6);
        assert_eq!(battle.players[0].name, "Galvdon");
        assert_eq!(battle.players[0].guild_name, "Weaklings");
        assert_eq!(battle.players[0].item_power, 1396.0);
    }

    #[test]
    fn deserializes_real_kill_feed_payload() {
        let json = r#"[
          {
            "EventId": 397702801,
            "TimeStamp": "2026-07-07T22:50:44.983Z",
            "TotalVictimKillFame": 380726,
            "Killer": {
              "Id": "XUBkSg3CTn2q3Cz3H2nEXQ",
              "Name": "Galvdon",
              "GuildName": "Weaklings",
              "AllianceName": "TVG",
              "AverageItemPower": 1396.40137
            },
            "Victim": {
              "Id": "gp83apeWRoyUkGdkC5xjiQ",
              "Name": "Coqo",
              "GuildName": "NoRules",
              "AllianceName": "ST4",
              "AverageItemPower": 1557.20251
            }
          }
        ]"#;

        let kills: Vec<AlbionBbKillEvent> =
            serde_json::from_str(json).expect("kill feed payload should deserialize");

        assert_eq!(kills.len(), 1);
        assert_eq!(kills[0].event_id, 397702801);
        assert_eq!(kills[0].killer.name, "Galvdon");
        assert_eq!(kills[0].killer.guild_name.as_deref(), Some("Weaklings"));
        assert_eq!(kills[0].killer.average_item_power, 1396.40137);
        assert_eq!(kills[0].total_kill_fame, 380726);
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;
    use crate::modules::albionbb::test_support::{json_ok, serve, status};

    const BATTLE_JSON: &str = r#"{"albionId": 7, "startedAt": "2026-08-01T00:00:00Z", "finishedAt": "2026-08-01T00:30:00Z", "totalFame": 0, "totalKills": 0, "totalPlayers": 0, "guilds": [], "players": []}"#;

    /// Near-zero delays so the retry tests stay fast.
    fn instant_retry() -> BackoffPolicy {
        BackoffPolicy {
            base: Duration::from_millis(1),
            cap: Duration::from_millis(1),
            max_exponent: 0,
            jitter: 0.0,
        }
    }

    #[tokio::test]
    async fn rate_limited_response_is_retried_until_success() {
        let upstream = serve(vec![
            status("429 Too Many Requests", "Retry-After: 0\r\n"),
            json_ok(BATTLE_JSON),
        ])
        .await;
        let client = AlbionBbApiClient::new(Some(upstream.base_url.clone()), None)
            .with_retry_policy(instant_retry());

        let battle = client.get_battle(Some("eu"), 7).await.expect("retried");

        assert_eq!(battle.summary.id, 7);
        assert_eq!(upstream.request_count(), 2);
    }

    #[tokio::test]
    async fn server_errors_give_up_after_the_retry_budget() {
        let upstream = serve(vec![status("503 Service Unavailable", "")]).await;
        let client = AlbionBbApiClient::new(Some(upstream.base_url.clone()), None)
            .with_retry_policy(instant_retry());

        let error = client.get_battle(Some("eu"), 7).await.unwrap_err();

        assert!(matches!(error, AppError::UpstreamService(_)));
        assert_eq!(upstream.request_count(), (MAX_RETRIES + 1) as usize);
    }

    #[tokio::test]
    async fn not_found_is_not_retried() {
        let upstream = serve(vec![status("404 Not Found", "")]).await;
        let client = AlbionBbApiClient::new(Some(upstream.base_url.clone()), None)
            .with_retry_policy(instant_retry());

        let error = client.get_battle(Some("eu"), 7).await.unwrap_err();

        assert!(matches!(error, AppError::NotFound(_)));
        assert_eq!(upstream.request_count(), 1);
    }
}
