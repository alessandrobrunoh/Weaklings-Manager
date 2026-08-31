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
use crate::pagination::{
    PaginatedData, PaginationParams, SortOrder, paginate_vec, resolve_sort_key,
};

use super::entities::Entity as GuildBattleSnapshotEntity;
use super::entities::{
    ActiveModel as GuildBattleSnapshotActiveModel, Column as GuildBattleSnapshotColumn,
};
use super::models::{
    BattleDetail, BattleLossEstimate, BattleSummary, GuildLossEstimate, LinkedEvent,
    PlayerLossEstimate,
};

/// Upper bound on how many upstream battle-list pages `/me` will scan before
/// giving up. Keeps the endpoint from scanning AlbionBB's entire history.
const MY_BATTLES_MAX_UPSTREAM_PAGES: u64 = 5;

/// Minimum number of players from the configured guild required for a battle to
/// be considered relevant to the Weaklings wrapper. `1` means any battle with
/// at least one Weaklings participant is included.
const DEFAULT_MIN_GUILD_PLAYERS: i64 = 1;

/// How long a hydrated guild-battle catalog stays fresh in the local cache.
const LIST_CACHE_TTL: Duration = Duration::from_secs(60);
/// AlbionBB has no sort API, so we hydrate several recent pages and page/sort locally.
const GUILD_CATALOG_MAX_PAGES: u64 = 20;
const LOSS_ESTIMATE_LOCATIONS: &str =
    "Caerleon,Bridgewatch,Fort Sterling,Lymhurst,Martlock,Thetford,Brecilien";

type BattleCatalogCache = Arc<RwLock<HashMap<i64, (Instant, Vec<BattleSummary>)>>>;

/// Service exposing guild-scoped battle operations.
#[derive(Clone)]
pub struct BattlesService {
    albionbb: AlbionBbService,
    guild_id: String,
    server: Option<String>,
    catalog_cache: BattleCatalogCache,
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
            catalog_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Lists recent battles of the configured guild.
    ///
    /// AlbionBB cannot sort or search, so we hydrate a short catalog of recent
    /// pages, cache it, then filter/sort/paginate in memory.
    pub async fn list_guild_battles(
        &self,
        min_players: Option<i64>,
        pagination: &PaginationParams,
        search: Option<&str>,
        sort: Option<&str>,
        order: SortOrder,
        outcome: Option<&str>,
    ) -> Result<PaginatedData<BattleSummary>, AppError> {
        let min_players = min_players.unwrap_or(10);
        let catalog = self.guild_catalog(min_players).await?;
        let mut page = filter_sort_page_battles(
            catalog,
            &self.guild_id,
            search,
            outcome,
            sort,
            order,
            pagination,
        )?;
        self.hydrate_page(&mut page.items).await;
        Ok(page)
    }

    /// Hydrates up to [`GUILD_CATALOG_MAX_PAGES`] of recent guild battles.
    ///
    /// Uses AlbionBB list payloads only. Per-battle detail is fetched later for
    /// the visible page so search/sort can cover the catalog without N detail
    /// calls per list page.
    async fn guild_catalog(&self, min_players: i64) -> Result<Vec<BattleSummary>, AppError> {
        if let Some((fetched_at, cached)) = self.catalog_cache.read().await.get(&min_players)
            && fetched_at.elapsed() < LIST_CACHE_TTL
        {
            return Ok(cached.clone());
        }

        let mut items = Vec::new();
        let mut seen = HashSet::new();
        for page in 1..=GUILD_CATALOG_MAX_PAGES {
            let filters = AlbionBbBattlesFilters {
                search: None,
                guild_id: Some(self.guild_id.clone()),
                min_players: Some(min_players),
                min_guild_players: Some(DEFAULT_MIN_GUILD_PLAYERS),
                page: Some(page),
            };
            let (raw_battles, _meta) = self
                .albionbb
                .get_battles(self.server.as_deref(), &filters)
                .await?;
            if raw_battles.is_empty() {
                break;
            }
            for raw in raw_battles {
                if seen.insert(raw.id) {
                    items.push(BattleSummary::from(raw));
                }
            }
        }

        self.catalog_cache
            .write()
            .await
            .insert(min_players, (Instant::now(), items.clone()));
        Ok(items)
    }

    /// Enriches the visible page with single-battle detail (guild kills/deaths).
    async fn hydrate_page(&self, items: &mut [BattleSummary]) {
        for item in items.iter_mut() {
            match self
                .albionbb
                .get_battle(self.server.as_deref(), item.battle_id)
                .await
            {
                Ok(detail) => *item = BattleSummary::from_detail(&detail),
                Err(error) => {
                    tracing::warn!(
                        battle_id = item.battle_id,
                        error = %error,
                        "failed to hydrate guild battle summary"
                    );
                }
            }
        }
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
        battle.linked_event = find_linked_event(db, battle_id).await.unwrap_or(None);
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
        search: Option<&str>,
        sort: Option<&str>,
        order: SortOrder,
        outcome: Option<&str>,
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

        filter_sort_page_battles(
            matched,
            &self.guild_id,
            search,
            outcome,
            sort,
            order,
            pagination,
        )
    }
}

fn battle_deaths(battle: &BattleSummary) -> i64 {
    battle.guilds.iter().map(|guild| guild.deaths).sum()
}

fn battle_outcome(battle: &BattleSummary, guild_id: &str) -> &'static str {
    let Some(our) = battle.guilds.iter().find(|guild| guild.id == guild_id) else {
        return "contested";
    };
    if our.winner || (our.kills > our.deaths && our.kill_fame * 20 >= battle.total_fame * 7) {
        return "victory";
    }
    if our.deaths > our.kills && our.kill_fame * 4 < battle.total_fame {
        return "defeat";
    }
    "contested"
}

fn battle_matches_search(battle: &BattleSummary, query: &str) -> bool {
    if battle.battle_id.to_string().contains(query) {
        return true;
    }
    battle.guilds.iter().any(|guild| {
        guild.name.to_lowercase().contains(query)
            || guild
                .alliance_name
                .as_deref()
                .is_some_and(|name| name.to_lowercase().contains(query))
    })
}

fn filter_sort_page_battles(
    mut items: Vec<BattleSummary>,
    guild_id: &str,
    search: Option<&str>,
    outcome: Option<&str>,
    sort: Option<&str>,
    order: SortOrder,
    pagination: &PaginationParams,
) -> Result<PaginatedData<BattleSummary>, AppError> {
    if let Some(query) = search.map(str::trim).filter(|value| !value.is_empty()) {
        let query = query.to_lowercase();
        items.retain(|battle| battle_matches_search(battle, &query));
    }
    if let Some(wanted) = outcome.map(str::trim).filter(|value| !value.is_empty()) {
        items.retain(|battle| battle_outcome(battle, guild_id) == wanted);
    }

    let sort_key = resolve_sort_key(
        sort,
        &[
            ("start_time", "start_time"),
            ("time", "start_time"),
            ("fame", "fame"),
            ("kills", "kills"),
            ("deaths", "deaths"),
            ("players", "players"),
            ("id", "id"),
            ("outcome", "outcome"),
        ],
        "start_time",
    )?;
    items.sort_by(|left, right| {
        let ordering = match sort_key {
            "fame" => left.total_fame.cmp(&right.total_fame),
            "kills" => left.total_kills.cmp(&right.total_kills),
            "deaths" => battle_deaths(left).cmp(&battle_deaths(right)),
            "players" => left.total_players.cmp(&right.total_players),
            "id" => left.battle_id.cmp(&right.battle_id),
            "outcome" => battle_outcome(left, guild_id).cmp(battle_outcome(right, guild_id)),
            _ => left.start_time.cmp(&right.start_time),
        };
        match order {
            SortOrder::Asc => ordering,
            SortOrder::Desc => ordering.reverse(),
        }
    });
    Ok(paginate_vec(items, pagination))
}

#[cfg(test)]
mod filter_tests {
    use super::{battle_outcome, filter_sort_page_battles};
    use crate::modules::battles::models::{BattleGuildSummary, BattleSummary};
    use crate::pagination::{PaginationParams, SortOrder};

    fn guild(
        id: &str,
        name: &str,
        kills: i64,
        deaths: i64,
        fame: i64,
        winner: bool,
    ) -> BattleGuildSummary {
        BattleGuildSummary {
            id: id.to_string(),
            name: name.to_string(),
            alliance_name: None,
            alliance_id: None,
            players: 20,
            kills,
            deaths,
            kill_fame: fame,
            winner,
            average_item_power: 0.0,
        }
    }

    fn battle(id: i64, start: &str, fame: i64, guilds: Vec<BattleGuildSummary>) -> BattleSummary {
        BattleSummary {
            battle_id: id,
            start_time: start.to_string(),
            end_time: start.to_string(),
            total_players: guilds.iter().map(|g| g.players).sum(),
            total_kills: guilds.iter().map(|g| g.kills).sum(),
            total_fame: fame,
            guilds,
        }
    }

    #[test]
    fn filters_by_search_and_sorts_by_fame() {
        let ours = "g1";
        let items = vec![
            battle(
                1,
                "2026-01-01T00:00:00Z",
                100,
                vec![guild(ours, "Weaklings", 10, 2, 80, true)],
            ),
            battle(
                2,
                "2026-01-02T00:00:00Z",
                500,
                vec![
                    guild(ours, "Weaklings", 1, 8, 10, false),
                    guild("g2", "Enemy", 8, 1, 400, true),
                ],
            ),
        ];
        let page = filter_sort_page_battles(
            items,
            ours,
            Some("enemy"),
            None,
            Some("fame"),
            SortOrder::Desc,
            &PaginationParams {
                page: Some(1),
                limit: Some(10),
            },
        )
        .unwrap();
        assert_eq!(page.total_items, 1);
        assert_eq!(page.items[0].battle_id, 2);
        assert_eq!(battle_outcome(&page.items[0], ours), "defeat");
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

/// Resolves the guild event a battle was fought under, if any.
///
/// Two hops, because `event_battles` stores the AlbionBB id as a string while
/// callers hold it as an integer — a SQL cast would be Postgres-only and break
/// the SQLite test backend.
async fn find_linked_event(
    db: &DatabaseConnection,
    battle_id: i64,
) -> Result<Option<LinkedEvent>, AppError> {
    use crate::modules::events::entities::{event, event_battle};

    let Some(link) = event_battle::Entity::find()
        .filter(event_battle::Column::AlbionbbBattleId.eq(battle_id.to_string()))
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    Ok(event::Entity::find_by_id(link.event_id)
        .one(db)
        .await?
        .map(|row| LinkedEvent {
            id: row.id,
            title: row.title,
            call_to_arms: row.call_to_arms,
        }))
}
