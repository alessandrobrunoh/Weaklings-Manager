//! `AlbionBB` service logic module.
//!
//! `AlbionBbService` wraps the generic `AlbionBB` API client and owns the
//! process-wide caches for upstream lookups. Every clone shares those caches,
//! so a service built per request or per sync tick still hits them.
//!
//! * Battle details: cached for a day once the battle has settled, and for
//!   two minutes while it is still running (its totals keep changing).
//! * Guild info: cached for a day.
//! * Guild battle catalogs (the list pages the battles module pages through):
//!   cached for a minute, single-flight per query.
//! * Battle list and kill feed reads are not cached.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};

use super::client::{
    AlbionBbApiClient, AlbionBbBattleDetail, AlbionBbBattleSummary, AlbionBbBattlesFilters,
    AlbionBbGuildInfo, AlbionBbKillEvent, AlbionBbPageMeta, normalize_server,
};
use crate::errors::AppError;
use crate::ttl_cache::TtlCache;

/// How long a settled battle or a guild stays cached.
const RESOURCE_CACHE_TTL: Duration = Duration::from_hours(24);
/// How long a battle that has not settled yet stays cached.
const IN_PROGRESS_BATTLE_TTL: Duration = Duration::from_mins(2);
/// A battle counts as settled once it ended this long ago; kills still arrive
/// for a while after the end time.
const BATTLE_SETTLE_WINDOW: chrono::Duration = chrono::Duration::minutes(15);
/// How long a guild battle catalog is reused.
const CATALOG_CACHE_TTL: Duration = Duration::from_mins(1);
/// Entries kept per cache before the oldest is evicted.
const MAX_CACHE_ENTRIES: usize = 2_000;

/// Filters that define one guild battle catalog.
#[derive(Debug, Clone)]
pub struct GuildCatalogQuery {
    pub guild_id: String,
    pub min_players: i64,
    pub min_guild_players: i64,
    /// Upstream list pages to walk, starting at page 1. Stops early on an empty page.
    pub max_pages: u64,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct CatalogKey {
    server: String,
    query_guild_id: String,
    min_players: i64,
    min_guild_players: i64,
    max_pages: u64,
}

/// Service exposing `AlbionBB` operations, with shared, cached lookups.
#[derive(Clone)]
pub struct AlbionBbService {
    client: AlbionBbApiClient,
    battle_cache: Arc<TtlCache<(String, i64), Arc<AlbionBbBattleDetail>>>,
    guild_cache: Arc<TtlCache<(String, String), AlbionBbGuildInfo>>,
    catalog_cache: Arc<TtlCache<CatalogKey, Arc<Vec<AlbionBbBattleSummary>>>>,
}

impl AlbionBbService {
    #[must_use]
    pub fn new(client: AlbionBbApiClient) -> Self {
        Self {
            client,
            battle_cache: Arc::new(TtlCache::new(MAX_CACHE_ENTRIES)),
            guild_cache: Arc::new(TtlCache::new(MAX_CACHE_ENTRIES)),
            catalog_cache: Arc::new(TtlCache::new(MAX_CACHE_ENTRIES)),
        }
    }

    /// Fetches battles matching the given filters (uncached — list views must
    /// reflect new battles as they happen).
    pub async fn get_battles(
        &self,
        server: Option<&str>,
        filters: &AlbionBbBattlesFilters,
    ) -> Result<(Vec<AlbionBbBattleSummary>, AlbionBbPageMeta), AppError> {
        self.client.get_battles(server, filters).await
    }

    /// Returns the battles of a guild across up to `query.max_pages` upstream
    /// pages, deduplicated by battle id, in upstream order.
    ///
    /// The result is shared by every clone of this service and cached for
    /// [`CATALOG_CACHE_TTL`]. Concurrent misses for the same query wait for one
    /// walk of the pages instead of starting their own.
    ///
    /// # Errors
    /// Returns the first upstream error of the walk; nothing is cached then.
    pub async fn guild_battle_catalog(
        &self,
        server: Option<&str>,
        query: &GuildCatalogQuery,
    ) -> Result<Arc<Vec<AlbionBbBattleSummary>>, AppError> {
        let server = normalize_server(server);
        let key = CatalogKey {
            server: server.clone(),
            query_guild_id: query.guild_id.clone(),
            min_players: query.min_players,
            min_guild_players: query.min_guild_players,
            max_pages: query.max_pages,
        };
        let query = query.clone();
        self.catalog_cache
            .get_or_fetch(key, move || async move {
                tracing::debug!(
                    server = %server,
                    guild_id = %query.guild_id,
                    max_pages = query.max_pages,
                    "fetching AlbionBB guild battle catalog"
                );
                let mut items = Vec::new();
                let mut seen = HashSet::new();
                for page in 1..=query.max_pages {
                    let filters = AlbionBbBattlesFilters {
                        search: None,
                        guild_id: Some(query.guild_id.clone()),
                        min_players: Some(query.min_players),
                        min_guild_players: Some(query.min_guild_players),
                        page: Some(page),
                    };
                    let (raw_battles, _meta) =
                        self.client.get_battles(Some(&server), &filters).await?;
                    if raw_battles.is_empty() {
                        break;
                    }
                    for raw in raw_battles {
                        if seen.insert(raw.id) {
                            items.push(raw);
                        }
                    }
                }
                Ok((Arc::new(items), CATALOG_CACHE_TTL))
            })
            .await
    }

    /// Fetches a single battle by id, serving it from cache while fresh. The
    /// cache lifetime depends on whether the battle has settled.
    pub async fn get_battle(
        &self,
        server: Option<&str>,
        battle_id: i64,
    ) -> Result<Arc<AlbionBbBattleDetail>, AppError> {
        let server = normalize_server(server);
        let key = (server.clone(), battle_id);
        self.battle_cache
            .get_or_fetch(key, move || async move {
                let detail = self.client.get_battle(Some(&server), battle_id).await?;
                let ttl = battle_cache_ttl(&detail, Utc::now());
                Ok((Arc::new(detail), ttl))
            })
            .await
    }

    /// Fetches kill events for a battle (uncached — kill feeds are real-time).
    pub async fn get_battle_kills(
        &self,
        server: Option<&str>,
        battle_id: i64,
    ) -> Result<Vec<AlbionBbKillEvent>, AppError> {
        self.client.get_battle_kills(server, battle_id).await
    }

    /// Fetches player career stats (uncached passthrough).
    pub async fn get_player_stats(
        &self,
        server: Option<&str>,
        player_id: &str,
        min_players: Option<i64>,
    ) -> Result<serde_json::Value, AppError> {
        self.client
            .get_player_stats(server, player_id, min_players)
            .await
    }

    /// Fetches guild info, serving from cache when fresh.
    pub async fn get_guild(
        &self,
        server: Option<&str>,
        guild_id: &str,
    ) -> Result<AlbionBbGuildInfo, AppError> {
        let server = normalize_server(server);
        let key = (server.clone(), guild_id.to_string());
        let guild_id = guild_id.to_string();
        self.guild_cache
            .get_or_fetch(key, move || async move {
                let info = self.client.get_guild(Some(&server), &guild_id).await?;
                Ok((info, RESOURCE_CACHE_TTL))
            })
            .await
    }
}

/// Cache lifetime of a battle detail. A battle is final only once it ended more
/// than [`BATTLE_SETTLE_WINDOW`] ago; before that, or when the end time is
/// missing or unparseable, the detail is kept for [`IN_PROGRESS_BATTLE_TTL`].
#[must_use]
pub fn battle_cache_ttl(detail: &AlbionBbBattleDetail, now: DateTime<Utc>) -> Duration {
    let settled = DateTime::parse_from_rfc3339(&detail.summary.end_time)
        .is_ok_and(|ended| now.signed_duration_since(ended) >= BATTLE_SETTLE_WINDOW);
    if settled {
        RESOURCE_CACHE_TTL
    } else {
        IN_PROGRESS_BATTLE_TTL
    }
}

impl Default for AlbionBbService {
    fn default() -> Self {
        Self::new(AlbionBbApiClient::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::albionbb::test_support::{json_ok, serve};
    use std::sync::Arc;

    const BATTLE_JSON: &str = r#"{"albionId": 42, "startedAt": "2026-08-01T00:00:00Z", "finishedAt": "2026-08-01T00:30:00Z", "totalFame": 1000, "totalKills": 5, "totalPlayers": 10, "guilds": [], "players": []}"#;

    fn detail_ending(end_time: &str) -> AlbionBbBattleDetail {
        serde_json::from_str(&format!(
            r#"{{"albionId": 1, "startedAt": "2026-08-01T00:00:00Z", "finishedAt": "{end_time}", "guilds": [], "players": []}}"#
        ))
        .expect("detail json")
    }

    #[test]
    fn settled_battle_is_cached_for_a_day() {
        let now = DateTime::parse_from_rfc3339("2026-08-01T01:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            battle_cache_ttl(&detail_ending("2026-08-01T00:30:00Z"), now),
            RESOURCE_CACHE_TTL
        );
    }

    #[test]
    fn running_or_just_ended_battle_gets_a_short_ttl() {
        let now = DateTime::parse_from_rfc3339("2026-08-01T01:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        // Ended five minutes ago: still inside the settle window.
        assert_eq!(
            battle_cache_ttl(&detail_ending("2026-08-01T00:55:00Z"), now),
            IN_PROGRESS_BATTLE_TTL
        );
        // No end time yet: still running.
        assert_eq!(
            battle_cache_ttl(&detail_ending(""), now),
            IN_PROGRESS_BATTLE_TTL
        );
    }

    #[tokio::test]
    async fn battle_detail_is_fetched_once_while_fresh() {
        let upstream = serve(vec![json_ok(BATTLE_JSON)]).await;
        let service = AlbionBbService::new(AlbionBbApiClient::new(
            Some(upstream.base_url.clone()),
            None,
        ));

        let first = service.get_battle(Some("eu"), 42).await.expect("first");
        let second = service
            .get_battle(Some("europe"), 42)
            .await
            .expect("second");

        assert_eq!(first.summary.id, 42);
        assert!(
            Arc::ptr_eq(&first, &second),
            "cache hands out the shared value"
        );
        assert_eq!(upstream.request_count(), 1);
    }

    #[tokio::test]
    async fn guild_battle_catalog_is_walked_once_and_shared_by_clones() {
        // List payloads carry `players` as a count, not as the detail's array.
        let summary = BATTLE_JSON.replace(", \"players\": []", "");
        let page_one = format!(
            "[{}]",
            summary.replace("\"albionId\": 42", "\"albionId\": 1")
        );
        let page_two = format!(
            "[{}]",
            summary.replace("\"albionId\": 42", "\"albionId\": 2")
        );
        let upstream = serve(vec![json_ok(&page_one), json_ok(&page_two), json_ok("[]")]).await;
        let service = AlbionBbService::new(AlbionBbApiClient::new(
            Some(upstream.base_url.clone()),
            None,
        ));
        let query = GuildCatalogQuery {
            guild_id: "guild-1".to_string(),
            min_players: 10,
            min_guild_players: 1,
            max_pages: 20,
        };

        let first = service
            .guild_battle_catalog(Some("eu"), &query)
            .await
            .expect("first walk");
        let second = service
            .clone()
            .guild_battle_catalog(Some("eu"), &query)
            .await
            .expect("second walk from a clone");

        assert_eq!(first.iter().map(|b| b.id).collect::<Vec<_>>(), vec![1, 2]);
        assert!(Arc::ptr_eq(&first, &second));
        // Pages 1, 2 and the empty page 3 that ends the walk; no second walk.
        assert_eq!(upstream.request_count(), 3);
    }

    #[tokio::test]
    async fn catalog_queries_are_cached_separately() {
        let upstream = serve(vec![json_ok("[]")]).await;
        let service = AlbionBbService::new(AlbionBbApiClient::new(
            Some(upstream.base_url.clone()),
            None,
        ));
        let mut query = GuildCatalogQuery {
            guild_id: "guild-1".to_string(),
            min_players: 10,
            min_guild_players: 1,
            max_pages: 20,
        };
        service
            .guild_battle_catalog(Some("eu"), &query)
            .await
            .unwrap();
        query.min_players = 5;
        service
            .guild_battle_catalog(Some("eu"), &query)
            .await
            .unwrap();
        assert_eq!(upstream.request_count(), 2);
    }
}
