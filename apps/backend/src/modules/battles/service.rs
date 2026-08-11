//! `Battles` service logic module.
//!
//! `BattlesService` wraps [`AlbionBbService`] and scopes it to the configured
//! Weaklings guild. Provides the three operations the frontend needs:
//! paginated battle list, single-battle detail (battle + kills combined), and
//! the `/me` endpoint filtered by the calling user's linked Albion character.

use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use crate::errors::AppError;
use crate::modules::albion::service::AlbionLinkService;
use crate::modules::albionbb::client::{AlbionBbBattlesFilters, AlbionBbKillEvent};
use crate::modules::albionbb::service::AlbionBbService;
use crate::modules::albiondata::client::AlbionDataMarketPrice;
use crate::modules::albiondata::service::AlbionDataService;
use crate::pagination::{PaginatedData, PaginationParams};

use super::entities::Entity as GuildBattleSnapshotEntity;
use super::entities::{
    ActiveModel as GuildBattleSnapshotActiveModel, Column as GuildBattleSnapshotColumn,
};
use super::models::{
    BattleDetail, BattleLossEstimate, BattleSummary, GuildLossEstimate, PlayerLossEstimate,
};

/// Upper bound on how many upstream battle-list pages `/me` will scan before
/// giving up. Keeps the endpoint from scanning AlbionBB's entire history.
const MY_BATTLES_MAX_UPSTREAM_PAGES: u64 = 5;

/// Minimum number of players from the configured guild required for a battle to
/// be considered relevant to the Weaklings wrapper.
const DEFAULT_MIN_GUILD_PLAYERS: i64 = 5;

/// How long a hydrated `/battles` page stays fresh in the local cache.
const LIST_CACHE_TTL: Duration = Duration::from_secs(60);
const LOSS_ESTIMATE_LOCATIONS: &str =
    "Caerleon,Bridgewatch,Fort Sterling,Lymhurst,Martlock,Thetford,Brecilien";

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

    /// Fetches battle detail and enriches it with Albion Data loss estimates.
    ///
    /// The kill feed carries victim equipment in the preserved raw JSON. We price those item types
    /// in one batched Albion Data call and then roll losses up by player and guild. If Albion Data
    /// is unavailable, the caller still receives the full battle with an empty estimate instead of
    /// losing the analytics page.
    pub async fn get_battle_detail_with_losses(
        &self,
        db: &DatabaseConnection,
        battle_id: i64,
        albiondata: &AlbionDataService,
    ) -> Result<BattleDetail, AppError> {
        let detail = self
            .albionbb
            .get_battle(self.server.as_deref(), battle_id)
            .await?;
        let kills = self
            .albionbb
            .get_battle_kills(self.server.as_deref(), battle_id)
            .await?;
        let mut battle = BattleDetail::from_upstream(&detail, &kills);
        let loss_scope = LossEstimateScope::from_battle(&self.guild_id, &detail.summary.guilds);
        battle.estimated_losses = estimate_losses(albiondata, &kills, &loss_scope)
            .await
            .unwrap_or_default();
        if let Err(error) = persist_battle_snapshot(db, &battle).await {
            tracing::warn!(battle_id = battle.summary.battle_id, error = %error, "failed to persist guild battle snapshot");
        }
        Ok(battle)
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

/// Persists the enriched battle payload for future local analytics.
async fn persist_battle_snapshot(
    db: &DatabaseConnection,
    battle: &BattleDetail,
) -> Result<(), AppError> {
    let existing = GuildBattleSnapshotEntity::find()
        .filter(GuildBattleSnapshotColumn::BattleId.eq(battle.summary.battle_id))
        .one(db)
        .await
        .map_err(AppError::Database)?;
    let start_time = chrono::DateTime::parse_from_rfc3339(&battle.summary.start_time)
        .map_err(|error| AppError::Validation(format!("Invalid battle start time: {error}")))?;
    let end_time = chrono::DateTime::parse_from_rfc3339(&battle.summary.end_time).ok();

    let mut row: GuildBattleSnapshotActiveModel =
        existing.map_or_else(Default::default, Into::into);
    row.battle_id = Set(battle.summary.battle_id);
    row.start_time = Set(start_time.into());
    row.end_time = Set(end_time.map(Into::into));
    row.total_players = Set(battle.summary.total_players);
    row.total_kills = Set(battle.summary.total_kills);
    row.total_fame = Set(battle.summary.total_fame);
    row.guilds_json = Set(serialize_snapshot(&battle.summary.guilds)?);
    row.players_json = Set(serialize_snapshot(&battle.players)?);
    row.kills_json = Set(serialize_snapshot(&battle.kills)?);
    row.losses_json = Set(serialize_snapshot(&battle.estimated_losses)?);
    row.fetched_at = Set(chrono::Utc::now().into());
    row.save(db).await.map_err(AppError::Database)?;
    Ok(())
}

fn serialize_snapshot<T: serde::Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value).map_err(|error| {
        AppError::Internal(format!("Failed to serialize battle snapshot: {error}"))
    })
}

/// Estimates battle losses from victim equipment using Albion Data market prices.
async fn estimate_losses(
    albiondata: &AlbionDataService,
    kills: &[AlbionBbKillEvent],
    scope: &LossEstimateScope,
) -> Result<BattleLossEstimate, AppError> {
    let loss_items = collect_loss_items(kills, scope);
    if loss_items.is_empty() {
        return Ok(BattleLossEstimate::default());
    }

    let item_ids = loss_items
        .iter()
        .map(|item| item.item_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let prices = albiondata
        .prices(
            None,
            &item_ids.join(","),
            Some(LOSS_ESTIMATE_LOCATIONS),
            None,
        )
        .await?;
    let price_index = build_price_index(&prices);

    let mut total_estimated_loss = 0;
    let mut priced_items = 0;
    let mut player_rollups: HashMap<String, PlayerLossEstimate> = HashMap::new();
    let mut guild_rollups: HashMap<String, GuildLossEstimate> = HashMap::new();

    for item in &loss_items {
        let estimated_value = price_index.get(&item.item_id).copied().unwrap_or_default()
            * i64::from(item.quantity.max(1));
        let is_priced = estimated_value > 0;
        total_estimated_loss += estimated_value;
        priced_items += i64::from(is_priced);

        let player = player_rollups
            .entry(item.player_name.clone())
            .or_insert_with(|| PlayerLossEstimate {
                player_name: item.player_name.clone(),
                guild_name: item.guild_name.clone(),
                ..Default::default()
            });
        player.estimated_loss += estimated_value;
        player.priced_items += i64::from(is_priced);
        player.total_items += 1;

        let guild_name = item
            .guild_name
            .clone()
            .unwrap_or_else(|| "Unknown guild".to_string());
        let guild = guild_rollups
            .entry(guild_name.clone())
            .or_insert_with(|| GuildLossEstimate {
                guild_name,
                ..Default::default()
            });
        guild.estimated_loss += estimated_value;
        guild.priced_items += i64::from(is_priced);
        guild.total_items += 1;
    }

    for kill in kills {
        let player_name = kill.victim.name.clone();
        if let Some(player) = player_rollups.get_mut(&player_name) {
            player.deaths += 1;
        }
        let guild_name = kill
            .victim
            .guild_name
            .clone()
            .unwrap_or_else(|| "Unknown guild".to_string());
        if let Some(guild) = guild_rollups.get_mut(&guild_name) {
            guild.deaths += 1;
        }
    }

    let mut players = player_rollups.into_values().collect::<Vec<_>>();
    players.sort_by(|left, right| right.estimated_loss.cmp(&left.estimated_loss));
    let mut guilds = guild_rollups.into_values().collect::<Vec<_>>();
    guilds.sort_by(|left, right| right.estimated_loss.cmp(&left.estimated_loss));

    Ok(BattleLossEstimate {
        total_estimated_loss,
        priced_items,
        total_items: loss_items.len() as i64,
        players,
        guilds,
    })
}

/// Restricts economic loss estimates to the configured guild only.
///
/// Opponent deaths may be interesting for fight outcome, but silver-loss accounting must describe
/// our members only. The scope prefers Albion guild IDs and uses the configured guild name only as a
/// fallback when AlbionBB omits IDs in the kill feed.
struct LossEstimateScope {
    guild_id: String,
    guild_name: Option<String>,
}

impl LossEstimateScope {
    fn from_battle(
        guild_id: &str,
        guilds: &[crate::modules::albionbb::client::AlbionBbGuild],
    ) -> Self {
        let guild_name = guilds
            .iter()
            .find(|guild| guild.id == guild_id)
            .map(|guild| guild.name.to_ascii_lowercase());
        Self {
            guild_id: guild_id.to_string(),
            guild_name,
        }
    }

    fn is_own_guild_victim(&self, kill: &AlbionBbKillEvent) -> bool {
        if kill.victim.guild_id.as_deref() == Some(self.guild_id.as_str()) {
            return true;
        }
        let Some(expected_name) = &self.guild_name else {
            return false;
        };
        kill.victim
            .guild_name
            .as_deref()
            .is_some_and(|guild_name| guild_name.eq_ignore_ascii_case(expected_name))
    }
}

#[derive(Debug, Clone)]
struct LossItem {
    item_id: String,
    quantity: i32,
    player_name: String,
    guild_name: Option<String>,
}

fn collect_loss_items(kills: &[AlbionBbKillEvent], scope: &LossEstimateScope) -> Vec<LossItem> {
    let mut items = Vec::new();
    for kill in kills {
        if !scope.is_own_guild_victim(kill) {
            continue;
        }
        let Some(victim) =
            read_object(&kill.raw, "Victim").or_else(|| read_object(&kill.raw, "victim"))
        else {
            continue;
        };
        let Some(equipment) =
            read_object(victim, "Equipment").or_else(|| read_object(victim, "equipment"))
        else {
            continue;
        };
        collect_equipment_items(equipment, kill, &mut items);
    }
    items
}

fn collect_equipment_items(equipment: &Value, kill: &AlbionBbKillEvent, items: &mut Vec<LossItem>) {
    let Some(slots) = equipment.as_object() else {
        return;
    };
    for value in slots.values() {
        collect_item_value(value, kill, items);
    }
}

fn collect_item_value(value: &Value, kill: &AlbionBbKillEvent, items: &mut Vec<LossItem>) {
    if let Some(item_id) = read_string(value, "Type").or_else(|| read_string(value, "type")) {
        items.push(LossItem {
            item_id,
            quantity: read_i32(value, "Count")
                .or_else(|| read_i32(value, "count"))
                .unwrap_or(1),
            player_name: kill.victim.name.clone(),
            guild_name: kill.victim.guild_name.clone(),
        });
        return;
    }

    if let Some(array) = value.as_array() {
        for nested in array {
            collect_item_value(nested, kill, items);
        }
        return;
    }

    if let Some(object) = value.as_object() {
        for nested in object.values() {
            collect_item_value(nested, kill, items);
        }
    }
}

fn build_price_index(prices: &[AlbionDataMarketPrice]) -> HashMap<String, i64> {
    let mut index = HashMap::new();
    for price in prices {
        let value = [
            price.sell_price_min,
            price.sell_price_max,
            price.buy_price_max,
        ]
        .into_iter()
        .filter(|price| *price > 0)
        .min()
        .unwrap_or_default();
        if value > 0 {
            index.insert(price.item_id.clone(), value);
        }
    }
    index
}

fn read_object<'a>(source: &'a Value, key: &str) -> Option<&'a Value> {
    source
        .as_object()?
        .get(key)
        .filter(|value| value.is_object())
}

fn read_string(source: &Value, key: &str) -> Option<String> {
    source
        .as_object()?
        .get(key)?
        .as_str()
        .map(ToOwned::to_owned)
}

fn read_i32(source: &Value, key: &str) -> Option<i32> {
    source.as_object()?.get(key)?.as_i64()?.try_into().ok()
}
