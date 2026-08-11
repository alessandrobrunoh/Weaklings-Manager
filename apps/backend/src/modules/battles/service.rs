//! `Battles` service logic module.
//!
//! `BattlesService` wraps [`AlbionBbService`] and scopes it to the configured
//! Weaklings guild. Provides the three operations the frontend needs:
//! paginated battle list, single-battle detail (battle + kills combined), and
//! the `/me` endpoint filtered by the calling user's linked Albion character.

use sea_orm::DatabaseConnection;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use crate::errors::AppError;
use crate::modules::albion::service::AlbionLinkService;
use crate::modules::albionbb::client::AlbionBbBattlesFilters;
use crate::modules::albionbb::service::AlbionBbService;
use crate::pagination::{PaginatedData, PaginationParams};

use super::models::{BattleDetail, BattleSummary};

/// Upper bound on how many upstream battle-list pages `/me` will scan before
/// giving up. Keeps the endpoint from scanning AlbionBB's entire history.
const MY_BATTLES_MAX_UPSTREAM_PAGES: u64 = 5;

/// Minimum number of players from the configured guild required for a battle to
/// be considered relevant to the Weaklings wrapper.
const DEFAULT_MIN_GUILD_PLAYERS: i64 = 5;

/// How long a hydrated `/battles` page stays fresh in the local cache.
const LIST_CACHE_TTL: Duration = Duration::from_secs(60);

type BattleListCache = Arc<RwLock<HashMap<(u64, i64), (Instant, PaginatedData<BattleSummary>)>>>;

/// Service exposing guild-scoped battle operations.
#[derive(Clone)]
pub struct BattlesService {
    albionbb: AlbionBbService,
    guild_id: String,
    server: Option<String>,
    list_cache: BattleListCache,
}

impl BattlesService {
    #[must_use]
    pub fn new(albionbb: AlbionBbService, guild_id: String, server: String) -> Self {
        Self {
            albionbb,
            guild_id,
            server: if server.is_empty() {
                None
            } else {
                Some(server)
            },
            list_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Lists recent battles of the configured guild, paginated.
    /// `page` is passed straight through to AlbionBB (1-indexed). When upstream
    /// does not report totals, we synthesize conservative values from the
    /// current page so the frontend's pagination controls stay sensible.
    pub async fn list_guild_battles(
        &self,
        min_players: Option<i64>,
        page: u64,
    ) -> Result<PaginatedData<BattleSummary>, AppError> {
        let min_players = min_players.unwrap_or(10);
        let cache_key = (page, min_players);
        if let Some((fetched_at, cached)) = self.list_cache.read().await.get(&cache_key)
            && fetched_at.elapsed() < LIST_CACHE_TTL
        {
            return Ok(cached.clone());
        }

        let filters = AlbionBbBattlesFilters {
            search: None,
            guild_id: Some(self.guild_id.clone()),
            min_players: Some(min_players),
            min_guild_players: Some(DEFAULT_MIN_GUILD_PLAYERS),
            page: Some(page),
        };
        let (raw_battles, meta) = self
            .albionbb
            .get_battles(self.server.as_deref(), &filters)
            .await?;

        // AlbionBB's list payload is intentionally sparse (guilds only expose
        // name/alliance/killFame there), so hydrate each summary with the cached
        // single-battle detail to return richer guild breakdowns.
        let mut items = Vec::with_capacity(raw_battles.len());
        for raw in &raw_battles {
            let detail = self
                .albionbb
                .get_battle(self.server.as_deref(), raw.id)
                .await?;
            items.push(BattleSummary::from(&detail.summary));
        }
        let limit = raw_battles.len().max(1) as u64;
        let total_pages = meta.total_pages.map_or(page, |v| v.max(page as i64) as u64);
        let total_items = meta.total_results.unwrap_or(items.len() as i64).max(0) as u64;

        let paginated = PaginatedData::new(items, total_items, total_pages, page, limit);
        self.list_cache
            .write()
            .await
            .insert(cache_key, (Instant::now(), paginated.clone()));
        Ok(paginated)
    }

    /// Fetches full detail for a battle (battle + kills combined), cached
    /// server-side by the underlying AlbionBB service.
    pub async fn get_battle_detail(&self, battle_id: i64) -> Result<BattleDetail, AppError> {
        let detail = self
            .albionbb
            .get_battle(self.server.as_deref(), battle_id)
            .await?;
        let kills = self
            .albionbb
            .get_battle_kills(self.server.as_deref(), battle_id)
            .await?;
        Ok(BattleDetail::from_upstream(&detail, &kills))
    }

    /// Lists battles the calling user participated in.
    ///
    /// Pages through the configured guild's battles (capped at
    /// `MY_BATTLES_MAX_UPSTREAM_PAGES` upstream pages), fetches each battle's
    /// detail, and keeps only those whose players list contains the linked
    /// Albion player name. AlbionBB's battle-detail player list currently does
    /// not expose the player id, so name matching is the most reliable signal
    /// available here. The resulting set is paginated locally.
    pub async fn list_my_battles(
        &self,
        db: &DatabaseConnection,
        discord_id: &str,
        pagination: &PaginationParams,
    ) -> Result<PaginatedData<BattleSummary>, AppError> {
        let link = AlbionLinkService::new()
            .get_link_for_discord_user(db, discord_id)
            .await?
            .ok_or_else(|| {
                AppError::Validation(
                    "Albion character not linked — visit Profile to link first.".to_string(),
                )
            })?;

        let linked_name = link.albion_player_name.to_lowercase();
        let mut matched: Vec<BattleSummary> = Vec::new();
        for upstream_page in 1..=MY_BATTLES_MAX_UPSTREAM_PAGES {
            let filters = AlbionBbBattlesFilters {
                search: None,
                guild_id: Some(self.guild_id.clone()),
                min_players: Some(10),
                min_guild_players: Some(DEFAULT_MIN_GUILD_PLAYERS),
                page: Some(upstream_page),
            };
            let (raw_battles, _meta) = self
                .albionbb
                .get_battles(self.server.as_deref(), &filters)
                .await?;
            if raw_battles.is_empty() {
                break;
            }

            for raw in &raw_battles {
                // Fetch detail to inspect participants. Cheap thanks to the 24h cache.
                let detail = self
                    .albionbb
                    .get_battle(self.server.as_deref(), raw.id)
                    .await?;
                if detail
                    .players
                    .iter()
                    .any(|p| p.name.to_lowercase() == linked_name)
                {
                    matched.push(BattleSummary::from(&detail.summary));
                }
            }
        }

        // Sort newest-first by start_time (string comparison works for ISO 8601).
        matched.sort_by(|a, b| b.start_time.cmp(&a.start_time));

        let total_items = matched.len() as u64;
        let limit = pagination.limit();
        let page = pagination.offset_page();
        let total_pages = if limit == 0 {
            0
        } else {
            total_items.div_ceil(limit)
        };

        let start = (page * limit) as usize;
        let items = matched
            .into_iter()
            .skip(start)
            .take(limit as usize)
            .collect();

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }
}
