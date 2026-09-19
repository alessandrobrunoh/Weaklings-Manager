//! Read-only queries backing the enemy dossier endpoints.
//!
//! `enemy_guilds`/`enemy_players` carry no rollup columns (see
//! `entities.rs`'s module doc comment) — every tally here (`battles_fought`,
//! `our_kills`, `their_kills`, "latest observed role/weapon", weapon
//! histograms) is computed from `enemy_player_battles` at read time.
//!
//! Two different techniques are used, deliberately:
//! - For a **single** guild/player dossier, the relevant `enemy_player_battles`
//!   rows are fetched in full and folded in Rust (count-distinct / sum /
//!   "last write wins" for latest-per-player). The detail view already needs
//!   the individual rows (battle history, weapon histogram), so this avoids a
//!   second round trip.
//! - For a **list page**, only the tallies for that page's ids are needed, so
//!   they are computed with one `GROUP BY` aggregate query per page (never
//!   N+1) via `SeaORM`'s query builder — `COUNT(DISTINCT ..)` / `SUM(..)` are
//!   plain, portable SQL, no backend-specific casts or window functions (see
//!   `intel::matchups`'s doc comment for why this codebase avoids those).
//!
//! `EnemyRollup::battles_fought` counts raw `enemy_player_battles.battle_id`
//! values — i.e. raw `AlbionBB` battle segments, which over-counts a single
//! real engagement whenever `AlbionBB` split it into more than one technical
//! battle record. `EnemyRollup::distinct_fights` is the deduplicated fix:
//! every `battle_id` is resolved to its canonical Fight via the
//! table-wide-unique `fight_battles.battle_id -> fight_id` mapping, and the
//! reported count is (distinct `fight_id`s among `battle_id`s that resolve to
//! one) + (distinct `battle_id`s that do NOT resolve to any `fight_battles`
//! row at all, each counted as one engagement of its own). A `battle_id`
//! nobody has grouped into a Fight yet is still one real engagement — it
//! must never be silently dropped from the count, just because it is not yet
//! formally recognized as a Fight. That resolution is always one extra
//! batched query (never per-row), folded in Rust the same way as everything
//! else in this file — see `fight_ids_for_battles` and `count_distinct_fights`.
//!
//! "Latest observed role/weapon per player" is resolved by fetching that
//! player's battle rows ordered oldest-first and letting the last insert into
//! a `HashMap` win, rather than a correlated `MAX(occurred_at)` subquery or a
//! window function — simpler, and just as portable across Postgres/SQLite.

use std::collections::{BTreeMap, HashMap, HashSet};

use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, FromQueryResult, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
    sea_query::{Expr, Func},
};

use crate::errors::AppError;
use crate::modules::events::entities::fight_battle;
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

use super::entities::{enemy_guild, enemy_guild_alias, enemy_player, enemy_player_battle};
use super::models::{
    EnemyAliasGroup, EnemyAliasValue, EnemyGuildDossier, EnemyGuildRosterPlayer, EnemyGuildSummary,
    EnemyPlayerBattleEntry, EnemyPlayerDossier, EnemyPlayerSummary, EnemyRollup,
    WeaponHistogramEntry,
};

/// Stateless enemy-dossier read operations.
pub struct EnemiesService;

impl Default for EnemiesService {
    fn default() -> Self {
        Self
    }
}

impl EnemiesService {
    /// Creates a new instance.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Paginated list of enemy guilds, newest-seen first by default.
    ///
    /// # Errors
    ///
    /// `400` for an unknown `sort` column; database errors otherwise.
    pub async fn list_guilds(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        search: Option<&str>,
        sort: Option<&str>,
        order: SortOrder,
    ) -> Result<PaginatedData<EnemyGuildSummary>, AppError> {
        let mut query = enemy_guild::Entity::find();
        if let Some(pattern) = like_pattern(search) {
            query = query.filter(
                Expr::expr(Func::lower(Expr::col(enemy_guild::Column::Name))).like(pattern),
            );
        }

        let sort_column = resolve_sort_key(
            sort,
            &[
                ("last_seen_at", enemy_guild::Column::LastSeenAt),
                ("name", enemy_guild::Column::Name),
            ],
            enemy_guild::Column::LastSeenAt,
        )?;
        query = match order {
            SortOrder::Asc => query
                .order_by_asc(sort_column)
                .order_by_asc(enemy_guild::Column::Id),
            SortOrder::Desc => query
                .order_by_desc(sort_column)
                .order_by_desc(enemy_guild::Column::Id),
        };

        let limit = pagination.limit();
        let page = pagination.offset_page();
        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;

        let ids: Vec<i64> = models.iter().map(|m| m.id).collect();
        let rollups = guild_rollups_batch(db, &ids).await?;

        let items = models
            .into_iter()
            .map(|m| {
                let rollup = rollups.get(&m.id).cloned().unwrap_or_default();
                EnemyGuildSummary {
                    id: m.id,
                    guild_key: m.guild_key,
                    name: m.name,
                    current_alliance_name: m.current_alliance_name,
                    first_seen_at: m.first_seen_at.to_rfc3339(),
                    last_seen_at: m.last_seen_at.to_rfc3339(),
                    is_watchlisted: m.is_watchlisted,
                    rollup,
                }
            })
            .collect();

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Full dossier for one enemy guild: identity, alias history, battle-derived
    /// tallies, current roster (with each player's latest observed build), and a
    /// weapon histogram across the roster's whole battle history.
    ///
    /// # Errors
    ///
    /// `404` if `id` does not exist; database errors otherwise.
    pub async fn get_guild(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<EnemyGuildDossier, AppError> {
        let guild = enemy_guild::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("enemy guild {id} not found")))?;

        let alias_models = enemy_guild_alias::Entity::find()
            .filter(enemy_guild_alias::Column::EnemyGuildId.eq(id))
            .order_by_asc(enemy_guild_alias::Column::FirstSeenAt)
            .order_by_asc(enemy_guild_alias::Column::Id)
            .all(db)
            .await?;
        let aliases = group_aliases(alias_models);

        // Battles fought *as* this guild — enemy_player_battles.enemy_guild_id
        // is exactly this, so no join through the roster is needed here.
        let guild_battles = enemy_player_battle::Entity::find()
            .filter(enemy_player_battle::Column::EnemyGuildId.eq(id))
            .all(db)
            .await?;
        let rollup = rollup_from_battles(db, &guild_battles).await?;

        let roster_models = enemy_player::Entity::find()
            .filter(enemy_player::Column::CurrentEnemyGuildId.eq(id))
            .order_by_asc(enemy_player::Column::Name)
            .order_by_asc(enemy_player::Column::Id)
            .all(db)
            .await?;
        let roster_ids: Vec<i64> = roster_models.iter().map(|m| m.id).collect();

        // Every battle ever fought by a roster player, in any guild — this is
        // what "latest observed build" and the weapon histogram are drawn
        // from, deliberately distinct from `guild_battles` above.
        let roster_battles = battles_for_players(db, &roster_ids).await?;
        let mut latest_by_player: HashMap<i64, &enemy_player_battle::Model> = HashMap::new();
        for battle in &roster_battles {
            // roster_battles is ordered oldest-first, so the last write here
            // is always the most recent one for that player.
            latest_by_player.insert(battle.enemy_player_id, battle);
        }
        let weapon_histogram = weapon_histogram(&roster_battles);

        let roster = roster_models
            .into_iter()
            .map(|model| {
                let latest = latest_by_player.get(&model.id).copied();
                roster_player_view(model, latest)
            })
            .collect();

        Ok(EnemyGuildDossier {
            id: guild.id,
            guild_key: guild.guild_key,
            albion_guild_id: guild.albion_guild_id,
            name: guild.name,
            current_alliance_id: guild.current_alliance_id,
            current_alliance_name: guild.current_alliance_name,
            first_seen_at: guild.first_seen_at.to_rfc3339(),
            last_seen_at: guild.last_seen_at.to_rfc3339(),
            is_watchlisted: guild.is_watchlisted,
            notes: guild.notes,
            aliases,
            rollup,
            roster,
            weapon_histogram,
        })
    }

    /// Paginated list of enemy players, newest-seen first by default.
    ///
    /// `role` filters on the *latest observed* role, a derived field — see the
    /// module doc comment for why that path fetches every player matching
    /// `search`/`guild_id` and paginates the filtered set in Rust instead of
    /// pushing the filter into the database query.
    ///
    /// # Errors
    ///
    /// `400` for an unknown `sort` column; database errors otherwise.
    #[allow(clippy::too_many_arguments, clippy::too_many_lines)]
    pub async fn list_players(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        search: Option<&str>,
        guild_id: Option<i64>,
        role: Option<&str>,
        sort: Option<&str>,
        order: SortOrder,
    ) -> Result<PaginatedData<EnemyPlayerSummary>, AppError> {
        let mut query = enemy_player::Entity::find();
        if let Some(pattern) = like_pattern(search) {
            query = query.filter(
                Expr::expr(Func::lower(Expr::col(enemy_player::Column::Name))).like(pattern),
            );
        }
        if let Some(guild_id) = guild_id {
            query = query.filter(enemy_player::Column::CurrentEnemyGuildId.eq(guild_id));
        }

        let sort_column = resolve_sort_key(
            sort,
            &[
                ("last_seen_at", enemy_player::Column::LastSeenAt),
                ("name", enemy_player::Column::Name),
            ],
            enemy_player::Column::LastSeenAt,
        )?;
        query = match order {
            SortOrder::Asc => query
                .order_by_asc(sort_column)
                .order_by_asc(enemy_player::Column::Id),
            SortOrder::Desc => query
                .order_by_desc(sort_column)
                .order_by_desc(enemy_player::Column::Id),
        };

        let limit = pagination.limit();
        let zero_based_page = pagination.offset_page();
        let role_filter = role.map(str::trim).filter(|r| !r.is_empty());

        let (total_items, total_pages, current_page, page_models) = match role_filter {
            None => {
                let paginator = query.paginate(db, limit);
                let total_items = paginator.num_items().await?;
                let total_pages = paginator.num_pages().await?;
                let models = paginator.fetch_page(zero_based_page).await?;
                (total_items, total_pages, zero_based_page + 1, models)
            }
            Some(role_filter) => {
                let all_models = query.all(db).await?;
                let ids: Vec<i64> = all_models.iter().map(|m| m.id).collect();
                let latest = latest_battle_per_player(db, &ids).await?;
                let filtered: Vec<enemy_player::Model> = all_models
                    .into_iter()
                    .filter(|m| {
                        latest
                            .get(&m.id)
                            .and_then(|b| b.role.as_deref())
                            .is_some_and(|r| r.eq_ignore_ascii_case(role_filter))
                    })
                    .collect();
                let total_items = filtered.len() as u64;
                let total_pages = total_items.div_ceil(limit).max(1);
                let limit_usize = usize::try_from(limit).unwrap_or(usize::MAX);
                let start = usize::try_from(zero_based_page)
                    .unwrap_or(usize::MAX)
                    .saturating_mul(limit_usize);
                let page_models = if start >= filtered.len() {
                    Vec::new()
                } else {
                    filtered.into_iter().skip(start).take(limit_usize).collect()
                };
                (total_items, total_pages, zero_based_page + 1, page_models)
            }
        };

        let result_ids: Vec<i64> = page_models.iter().map(|m| m.id).collect();
        let latest_for_page = latest_battle_per_player(db, &result_ids).await?;
        let rollups = player_rollups_batch(db, &result_ids).await?;

        let guild_ids: Vec<i64> = page_models
            .iter()
            .filter_map(|m| m.current_enemy_guild_id)
            .collect();
        let guild_names = guild_names_by_id(db, &guild_ids).await?;

        let items = page_models
            .into_iter()
            .map(|m| {
                let latest = latest_for_page.get(&m.id);
                let rollup = rollups.get(&m.id).cloned().unwrap_or_default();
                let current_enemy_guild_name = m
                    .current_enemy_guild_id
                    .and_then(|gid| guild_names.get(&gid).cloned());
                EnemyPlayerSummary {
                    id: m.id,
                    player_key: m.player_key,
                    name: m.name,
                    current_enemy_guild_id: m.current_enemy_guild_id,
                    current_enemy_guild_name,
                    role: latest.and_then(|b| b.role.clone()),
                    main_hand_item_id: latest.and_then(|b| b.main_hand_item_id.clone()),
                    item_power: latest.map(|b| b.item_power),
                    first_seen_at: m.first_seen_at.to_rfc3339(),
                    last_seen_at: m.last_seen_at.to_rfc3339(),
                    rollup,
                }
            })
            .collect();

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            current_page,
            limit,
        ))
    }

    /// Full dossier for one enemy player: identity, current guild, full
    /// battle-by-battle history (newest first), and battle-derived tallies.
    ///
    /// # Errors
    ///
    /// `404` if `id` does not exist; database errors otherwise.
    pub async fn get_player(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<EnemyPlayerDossier, AppError> {
        let player = enemy_player::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("enemy player {id} not found")))?;

        let current_enemy_guild_name = match player.current_enemy_guild_id {
            Some(guild_id) => enemy_guild::Entity::find_by_id(guild_id)
                .one(db)
                .await?
                .map(|g| g.name),
            None => None,
        };

        let history_models = enemy_player_battle::Entity::find()
            .filter(enemy_player_battle::Column::EnemyPlayerId.eq(id))
            .order_by_desc(enemy_player_battle::Column::OccurredAt)
            .order_by_desc(enemy_player_battle::Column::Id)
            .all(db)
            .await?;
        let rollup = rollup_from_battles(db, &history_models).await?;

        let battles = history_models
            .into_iter()
            .map(|b| EnemyPlayerBattleEntry {
                battle_id: b.battle_id,
                occurred_at: b.occurred_at.to_rfc3339(),
                role: b.role,
                main_hand_item_id: b.main_hand_item_id,
                item_power: b.item_power,
                our_kills_on_them: b.our_kills_on_them,
                their_kills_on_us: b.their_kills_on_us,
            })
            .collect();

        Ok(EnemyPlayerDossier {
            id: player.id,
            player_key: player.player_key,
            albion_player_id: player.albion_player_id,
            name: player.name,
            identity_source: player.identity_source,
            current_enemy_guild_id: player.current_enemy_guild_id,
            current_enemy_guild_name,
            first_seen_at: player.first_seen_at.to_rfc3339(),
            last_seen_at: player.last_seen_at.to_rfc3339(),
            is_watchlisted: player.is_watchlisted,
            notes: player.notes,
            battles,
            rollup,
        })
    }
}

/// Normalizes a search term into a `LIKE`-ready, lowercased pattern. `None`
/// for absent/blank input, so callers can skip filtering entirely.
fn like_pattern(search: Option<&str>) -> Option<String> {
    search
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{}%", s.to_lowercase()))
}

/// Groups alias rows (already ordered oldest-first) by `kind`, preserving
/// chronological order of `values` within each group.
fn group_aliases(models: Vec<enemy_guild_alias::Model>) -> Vec<EnemyAliasGroup> {
    let mut groups: BTreeMap<String, Vec<EnemyAliasValue>> = BTreeMap::new();
    for m in models {
        groups.entry(m.kind).or_default().push(EnemyAliasValue {
            value: m.value,
            first_seen_at: m.first_seen_at.to_rfc3339(),
            last_seen_at: m.last_seen_at.to_rfc3339(),
        });
    }
    groups
        .into_iter()
        .map(|(kind, values)| EnemyAliasGroup { kind, values })
        .collect()
}

/// Folds a slice of battle rows into the summary tallies: distinct raw
/// battle segments, distinct canonical Fights those segments resolve to
/// (one extra batched `fight_battles` query — see the module doc comment for
/// why the fold happens in Rust rather than a SQL aggregate), and summed
/// kills in both directions.
async fn rollup_from_battles(
    db: &DatabaseConnection,
    battles: &[enemy_player_battle::Model],
) -> Result<EnemyRollup, AppError> {
    let mut battle_ids: HashSet<i64> = HashSet::new();
    let mut our_kills: i64 = 0;
    let mut their_kills: i64 = 0;
    for b in battles {
        battle_ids.insert(b.battle_id);
        our_kills += i64::from(b.our_kills_on_them);
        their_kills += i64::from(b.their_kills_on_us);
    }
    let battle_id_vec: Vec<i64> = battle_ids.iter().copied().collect();
    let fight_id_by_battle = fight_ids_for_battles(db, &battle_id_vec).await?;
    let distinct_fights = count_distinct_fights(battle_ids.iter().copied(), &fight_id_by_battle);
    Ok(EnemyRollup {
        battles_fought: i64::try_from(battle_ids.len()).unwrap_or(i64::MAX),
        distinct_fights,
        our_kills,
        their_kills,
    })
}

/// Resolves each of `battle_ids` to its canonical Fight id via the
/// table-wide-unique `fight_battles.battle_id -> fight_id` mapping. A battle
/// with no matching row simply has no entry in the returned map — that is the
/// normal, expected state for a `battle_id` nobody has grouped into a Fight
/// yet, not an error condition. Callers must not treat absence here as "no
/// engagement": see `count_distinct_fights`, which is the only place that
/// interprets this map's gaps.
async fn fight_ids_for_battles(
    db: &DatabaseConnection,
    battle_ids: &[i64],
) -> Result<HashMap<i64, i64>, AppError> {
    if battle_ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(fight_battle::Entity::find()
        .filter(fight_battle::Column::BattleId.is_in(battle_ids.to_vec()))
        .all(db)
        .await?
        .into_iter()
        .map(|row| (row.battle_id, row.fight_id))
        .collect())
}

/// Counts distinct real engagements among a set of `battle_id`s: the number
/// of distinct `fight_id`s among `battle_id`s that resolve to one via
/// `fight_id_by_battle`, PLUS one for every `battle_id` that has no entry in
/// that map at all. A `battle_id` nobody has grouped into a Fight yet is
/// still one real engagement — it must contribute exactly one here, never
/// zero, so it is never silently dropped from the total.
fn count_distinct_fights(
    battle_ids: impl IntoIterator<Item = i64>,
    fight_id_by_battle: &HashMap<i64, i64>,
) -> i64 {
    let mut fight_ids: HashSet<i64> = HashSet::new();
    let mut ungrouped_battle_ids: HashSet<i64> = HashSet::new();
    for battle_id in battle_ids {
        match fight_id_by_battle.get(&battle_id) {
            Some(fight_id) => {
                fight_ids.insert(*fight_id);
            }
            None => {
                ungrouped_battle_ids.insert(battle_id);
            }
        }
    }
    i64::try_from(fight_ids.len() + ungrouped_battle_ids.len()).unwrap_or(i64::MAX)
}

/// Builds a most-used-first weapon histogram from a slice of battle rows,
/// skipping rows with no recorded main-hand weapon.
fn weapon_histogram(battles: &[enemy_player_battle::Model]) -> Vec<WeaponHistogramEntry> {
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    for b in battles {
        if let Some(item_id) = &b.main_hand_item_id {
            *counts.entry(item_id.clone()).or_insert(0) += 1;
        }
    }
    let mut entries: Vec<WeaponHistogramEntry> = counts
        .into_iter()
        .map(|(main_hand_item_id, count)| WeaponHistogramEntry {
            main_hand_item_id,
            count,
        })
        .collect();
    entries.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.main_hand_item_id.cmp(&b.main_hand_item_id))
    });
    entries
}

/// Builds one roster DTO from an `enemy_players` row plus its latest known
/// battle row, if it has one on record.
fn roster_player_view(
    model: enemy_player::Model,
    latest: Option<&enemy_player_battle::Model>,
) -> EnemyGuildRosterPlayer {
    EnemyGuildRosterPlayer {
        id: model.id,
        player_key: model.player_key,
        name: model.name,
        role: latest.and_then(|b| b.role.clone()),
        main_hand_item_id: latest.and_then(|b| b.main_hand_item_id.clone()),
        item_power: latest.map(|b| b.item_power),
        first_seen_at: model.first_seen_at.to_rfc3339(),
        last_seen_at: model.last_seen_at.to_rfc3339(),
    }
}

/// Every `enemy_player_battles` row for the given players, oldest-first — the
/// basis for both "latest observed build" and weapon histograms. Empty input
/// short-circuits to no query (`is_in([])` is valid SQL but a wasted round trip).
async fn battles_for_players(
    db: &DatabaseConnection,
    player_ids: &[i64],
) -> Result<Vec<enemy_player_battle::Model>, AppError> {
    if player_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(enemy_player_battle::Entity::find()
        .filter(enemy_player_battle::Column::EnemyPlayerId.is_in(player_ids.to_vec()))
        .order_by_asc(enemy_player_battle::Column::OccurredAt)
        .order_by_asc(enemy_player_battle::Column::Id)
        .all(db)
        .await?)
}

/// The most recent `enemy_player_battles` row per player id, from `player_ids`.
/// A player with no battle rows is simply absent from the map.
async fn latest_battle_per_player(
    db: &DatabaseConnection,
    player_ids: &[i64],
) -> Result<HashMap<i64, enemy_player_battle::Model>, AppError> {
    let battles = battles_for_players(db, player_ids).await?;
    let mut latest: HashMap<i64, enemy_player_battle::Model> = HashMap::new();
    for battle in battles {
        // Ascending order means the last insert for a given player is always
        // the most recent battle row.
        latest.insert(battle.enemy_player_id, battle);
    }
    Ok(latest)
}

/// Display names for the given enemy guild ids, keyed by id.
async fn guild_names_by_id(
    db: &DatabaseConnection,
    guild_ids: &[i64],
) -> Result<HashMap<i64, String>, AppError> {
    if guild_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut ids = guild_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let guilds = enemy_guild::Entity::find()
        .filter(enemy_guild::Column::Id.is_in(ids))
        .all(db)
        .await?;
    Ok(guilds.into_iter().map(|g| (g.id, g.name)).collect())
}

/// Row shape for the batched guild rollup aggregate query.
#[derive(Debug, FromQueryResult)]
struct GuildRollupRow {
    enemy_guild_id: i64,
    battles_fought: i64,
    our_kills: i64,
    their_kills: i64,
}

/// Row shape for the raw `(enemy_guild_id, battle_id)` pairs used to fold
/// `distinct_fights` in Rust — see the module doc comment for why this file
/// avoids a SQL `COUNT(DISTINCT ...)` for that number.
#[derive(Debug, FromQueryResult)]
struct GuildBattleIdRow {
    enemy_guild_id: i64,
    battle_id: i64,
}

/// Battle-derived tallies for a page of guild ids, computed with a single
/// `GROUP BY enemy_guild_id` query for `battles_fought`/kills, plus one
/// raw-row fetch and one `fight_battles` lookup folded in Rust (via
/// `count_distinct_fights`) for `distinct_fights` — a guild with no battles
/// simply has no entry in the returned map.
async fn guild_rollups_batch(
    db: &DatabaseConnection,
    guild_ids: &[i64],
) -> Result<HashMap<i64, EnemyRollup>, AppError> {
    if guild_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = enemy_player_battle::Entity::find()
        .select_only()
        .column(enemy_player_battle::Column::EnemyGuildId)
        .expr_as(
            Expr::col(enemy_player_battle::Column::BattleId).count_distinct(),
            "battles_fought",
        )
        .expr_as(
            Expr::col(enemy_player_battle::Column::OurKillsOnThem).sum(),
            "our_kills",
        )
        .expr_as(
            Expr::col(enemy_player_battle::Column::TheirKillsOnUs).sum(),
            "their_kills",
        )
        .filter(enemy_player_battle::Column::EnemyGuildId.is_in(guild_ids.to_vec()))
        .group_by(enemy_player_battle::Column::EnemyGuildId)
        .into_model::<GuildRollupRow>()
        .all(db)
        .await?;

    let battle_rows = enemy_player_battle::Entity::find()
        .select_only()
        .column(enemy_player_battle::Column::EnemyGuildId)
        .column(enemy_player_battle::Column::BattleId)
        .filter(enemy_player_battle::Column::EnemyGuildId.is_in(guild_ids.to_vec()))
        .into_model::<GuildBattleIdRow>()
        .all(db)
        .await?;
    let battle_ids: Vec<i64> = {
        let mut ids: Vec<i64> = battle_rows.iter().map(|r| r.battle_id).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let fight_id_by_battle = fight_ids_for_battles(db, &battle_ids).await?;
    let mut battle_ids_by_guild: HashMap<i64, HashSet<i64>> = HashMap::new();
    for row in &battle_rows {
        battle_ids_by_guild
            .entry(row.enemy_guild_id)
            .or_default()
            .insert(row.battle_id);
    }

    Ok(rows
        .into_iter()
        .map(|row| {
            let distinct_fights = battle_ids_by_guild
                .get(&row.enemy_guild_id)
                .map_or(0, |ids| {
                    count_distinct_fights(ids.iter().copied(), &fight_id_by_battle)
                });
            (
                row.enemy_guild_id,
                EnemyRollup {
                    battles_fought: row.battles_fought,
                    distinct_fights,
                    our_kills: row.our_kills,
                    their_kills: row.their_kills,
                },
            )
        })
        .collect())
}

/// Row shape for the batched player rollup aggregate query.
#[derive(Debug, FromQueryResult)]
struct PlayerRollupRow {
    enemy_player_id: i64,
    battles_fought: i64,
    our_kills: i64,
    their_kills: i64,
}

/// Row shape for the raw `(enemy_player_id, battle_id)` pairs used to fold
/// `distinct_fights` in Rust — see the module doc comment for why this file
/// avoids a SQL `COUNT(DISTINCT ...)` for that number.
#[derive(Debug, FromQueryResult)]
struct PlayerBattleIdRow {
    enemy_player_id: i64,
    battle_id: i64,
}

/// Battle-derived tallies for a page of player ids, computed with a single
/// `GROUP BY enemy_player_id` query for `battles_fought`/kills, plus one
/// raw-row fetch and one `fight_battles` lookup folded in Rust (via
/// `count_distinct_fights`) for `distinct_fights` — a player with no battles
/// simply has no entry in the returned map.
async fn player_rollups_batch(
    db: &DatabaseConnection,
    player_ids: &[i64],
) -> Result<HashMap<i64, EnemyRollup>, AppError> {
    if player_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = enemy_player_battle::Entity::find()
        .select_only()
        .column(enemy_player_battle::Column::EnemyPlayerId)
        .expr_as(
            Expr::col(enemy_player_battle::Column::BattleId).count_distinct(),
            "battles_fought",
        )
        .expr_as(
            Expr::col(enemy_player_battle::Column::OurKillsOnThem).sum(),
            "our_kills",
        )
        .expr_as(
            Expr::col(enemy_player_battle::Column::TheirKillsOnUs).sum(),
            "their_kills",
        )
        .filter(enemy_player_battle::Column::EnemyPlayerId.is_in(player_ids.to_vec()))
        .group_by(enemy_player_battle::Column::EnemyPlayerId)
        .into_model::<PlayerRollupRow>()
        .all(db)
        .await?;

    let battle_rows = enemy_player_battle::Entity::find()
        .select_only()
        .column(enemy_player_battle::Column::EnemyPlayerId)
        .column(enemy_player_battle::Column::BattleId)
        .filter(enemy_player_battle::Column::EnemyPlayerId.is_in(player_ids.to_vec()))
        .into_model::<PlayerBattleIdRow>()
        .all(db)
        .await?;
    let battle_ids: Vec<i64> = {
        let mut ids: Vec<i64> = battle_rows.iter().map(|r| r.battle_id).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let fight_id_by_battle = fight_ids_for_battles(db, &battle_ids).await?;
    let mut battle_ids_by_player: HashMap<i64, HashSet<i64>> = HashMap::new();
    for row in &battle_rows {
        battle_ids_by_player
            .entry(row.enemy_player_id)
            .or_default()
            .insert(row.battle_id);
    }

    Ok(rows
        .into_iter()
        .map(|row| {
            let distinct_fights = battle_ids_by_player
                .get(&row.enemy_player_id)
                .map_or(0, |ids| {
                    count_distinct_fights(ids.iter().copied(), &fight_id_by_battle)
                });
            (
                row.enemy_player_id,
                EnemyRollup {
                    battles_fought: row.battles_fought,
                    distinct_fights,
                    our_kills: row.our_kills,
                    their_kills: row.their_kills,
                },
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, FixedOffset};
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, Database};

    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::events::entities::fight;
    use crate::pagination::PaginationParams;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    fn ts(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).expect("hard-coded timestamp")
    }

    async fn insert_guild(
        db: &DatabaseConnection,
        guild_key: &str,
        name: &str,
        alliance_name: Option<&str>,
        first_seen_at: &str,
        last_seen_at: &str,
    ) -> i64 {
        enemy_guild::ActiveModel {
            guild_key: Set(guild_key.to_string()),
            name: Set(name.to_string()),
            current_alliance_name: Set(alliance_name.map(str::to_string)),
            first_seen_at: Set(ts(first_seen_at)),
            last_seen_at: Set(ts(last_seen_at)),
            created_at: Set(ts(first_seen_at)),
            updated_at: Set(ts(last_seen_at)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert guild")
        .id
    }

    async fn insert_alias(
        db: &DatabaseConnection,
        enemy_guild_id: i64,
        kind: &str,
        value: &str,
        first_seen_at: &str,
        last_seen_at: &str,
    ) {
        enemy_guild_alias::ActiveModel {
            enemy_guild_id: Set(enemy_guild_id),
            kind: Set(kind.to_string()),
            value: Set(value.to_string()),
            first_seen_at: Set(ts(first_seen_at)),
            last_seen_at: Set(ts(last_seen_at)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert alias");
    }

    async fn insert_player(
        db: &DatabaseConnection,
        player_key: &str,
        name: &str,
        current_enemy_guild_id: Option<i64>,
        first_seen_at: &str,
        last_seen_at: &str,
    ) -> i64 {
        enemy_player::ActiveModel {
            player_key: Set(player_key.to_string()),
            name: Set(name.to_string()),
            identity_source: Set("player_id".to_string()),
            current_enemy_guild_id: Set(current_enemy_guild_id),
            first_seen_at: Set(ts(first_seen_at)),
            last_seen_at: Set(ts(last_seen_at)),
            created_at: Set(ts(first_seen_at)),
            updated_at: Set(ts(last_seen_at)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert player")
        .id
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_battle(
        db: &DatabaseConnection,
        battle_id: i64,
        enemy_player_id: i64,
        enemy_guild_id: i64,
        occurred_at: &str,
        role: Option<&str>,
        main_hand_item_id: Option<&str>,
        item_power: f64,
        our_kills_on_them: i32,
        their_kills_on_us: i32,
    ) {
        enemy_player_battle::ActiveModel {
            battle_id: Set(battle_id),
            enemy_player_id: Set(enemy_player_id),
            enemy_guild_id: Set(enemy_guild_id),
            occurred_at: Set(ts(occurred_at)),
            role: Set(role.map(str::to_string)),
            main_hand_item_id: Set(main_hand_item_id.map(str::to_string)),
            item_power: Set(item_power),
            our_kills_on_them: Set(our_kills_on_them),
            their_kills_on_us: Set(their_kills_on_us),
            created_at: Set(ts(occurred_at)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert battle");
    }

    /// Seeds a canonical Fight row, defaulting every column but `started_at`
    /// to the migration's own SQL defaults.
    async fn insert_fight(db: &DatabaseConnection) -> i64 {
        fight::ActiveModel {
            started_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight")
        .id
    }

    /// Links one `AlbionBB` battle segment to a canonical Fight.
    /// `sequence_number` must be distinct per fight (unique index).
    async fn link_fight_battle(
        db: &DatabaseConnection,
        fight_id: i64,
        battle_id: i64,
        sequence_number: i32,
    ) {
        fight_battle::ActiveModel {
            fight_id: Set(fight_id),
            battle_id: Set(battle_id),
            sequence_number: Set(sequence_number),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight battle");
    }

    fn default_pagination() -> PaginationParams {
        PaginationParams {
            page: None,
            limit: None,
        }
    }

    #[tokio::test]
    async fn list_guilds_sorts_by_last_seen_desc_by_default_and_computes_rollups() {
        let db = seed_db().await;
        let old_guild = insert_guild(
            &db,
            "id:1",
            "Old Guild",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-02T00:00:00Z",
        )
        .await;
        let new_guild = insert_guild(
            &db,
            "id:2",
            "New Guild",
            Some("Big Alliance"),
            "2026-02-01T00:00:00Z",
            "2026-02-05T00:00:00Z",
        )
        .await;
        let p1 = insert_player(
            &db,
            "id:p1",
            "Alice",
            Some(new_guild),
            "2026-02-01T00:00:00Z",
            "2026-02-05T00:00:00Z",
        )
        .await;
        let p2 = insert_player(
            &db,
            "id:p2",
            "Bob",
            Some(new_guild),
            "2026-02-01T00:00:00Z",
            "2026-02-05T00:00:00Z",
        )
        .await;
        insert_battle(
            &db,
            100,
            p1,
            new_guild,
            "2026-02-01T00:00:00Z",
            Some("dps"),
            Some("T8_MAIN"),
            1200.0,
            2,
            1,
        )
        .await;
        insert_battle(
            &db,
            100,
            p2,
            new_guild,
            "2026-02-01T00:00:00Z",
            Some("healer"),
            Some("T8_HEAL"),
            1100.0,
            0,
            3,
        )
        .await;
        insert_battle(
            &db,
            101,
            p1,
            new_guild,
            "2026-02-05T00:00:00Z",
            Some("dps"),
            Some("T8_MAIN"),
            1250.0,
            1,
            0,
        )
        .await;

        let service = EnemiesService::new();
        let page = service
            .list_guilds(&db, &default_pagination(), None, None, SortOrder::Desc)
            .await
            .expect("list");

        assert_eq!(page.total_items, 2);
        assert_eq!(
            page.items[0].id, new_guild,
            "newest last_seen_at first by default"
        );
        assert_eq!(page.items[0].rollup.battles_fought, 2);
        assert_eq!(page.items[0].rollup.our_kills, 3);
        assert_eq!(page.items[0].rollup.their_kills, 4);
        assert_eq!(page.items[1].id, old_guild);
        assert_eq!(
            page.items[1].rollup.battles_fought, 0,
            "no battles => zeroed rollup, not absent"
        );
    }

    #[tokio::test]
    async fn list_guilds_search_is_case_insensitive_substring_on_name() {
        let db = seed_db().await;
        insert_guild(
            &db,
            "id:1",
            "Fort Sterling Raiders",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        insert_guild(
            &db,
            "id:2",
            "Lymhurst Defenders",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;

        let service = EnemiesService::new();
        let page = service
            .list_guilds(
                &db,
                &default_pagination(),
                Some("raiders"),
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list");

        assert_eq!(page.total_items, 1);
        assert_eq!(page.items[0].name, "Fort Sterling Raiders");
    }

    #[tokio::test]
    async fn list_guilds_sort_by_name_ascending() {
        let db = seed_db().await;
        insert_guild(
            &db,
            "id:1",
            "Zulu",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        insert_guild(
            &db,
            "id:2",
            "Alpha",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;

        let service = EnemiesService::new();
        let page = service
            .list_guilds(
                &db,
                &default_pagination(),
                None,
                Some("name"),
                SortOrder::Asc,
            )
            .await
            .expect("list");

        assert_eq!(page.items[0].name, "Alpha");
        assert_eq!(page.items[1].name, "Zulu");
    }

    #[tokio::test]
    async fn list_guilds_rejects_unknown_sort_column() {
        let db = seed_db().await;
        let service = EnemiesService::new();
        let err = service
            .list_guilds(
                &db,
                &default_pagination(),
                None,
                Some("fame"),
                SortOrder::Desc,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn list_guilds_paginates() {
        let db = seed_db().await;
        for i in 0..3 {
            insert_guild(
                &db,
                &format!("id:{i}"),
                &format!("Guild {i}"),
                None,
                "2026-01-01T00:00:00Z",
                &format!("2026-01-0{}T00:00:00Z", i + 1),
            )
            .await;
        }
        let service = EnemiesService::new();
        let pagination = PaginationParams {
            page: Some(1),
            limit: Some(2),
        };
        let page = service
            .list_guilds(&db, &pagination, None, None, SortOrder::Desc)
            .await
            .expect("list");
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.total_items, 3);
        assert_eq!(page.total_pages, 2);
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn get_guild_returns_dossier_with_aliases_roster_and_weapon_histogram() {
        let db = seed_db().await;
        let guild = insert_guild(
            &db,
            "id:1",
            "Current Name",
            Some("Current Alliance"),
            "2026-01-01T00:00:00Z",
            "2026-02-01T00:00:00Z",
        )
        .await;
        insert_alias(
            &db,
            guild,
            "name",
            "Old Name",
            "2026-01-01T00:00:00Z",
            "2026-01-10T00:00:00Z",
        )
        .await;
        insert_alias(
            &db,
            guild,
            "name",
            "Current Name",
            "2026-01-11T00:00:00Z",
            "2026-02-01T00:00:00Z",
        )
        .await;
        insert_alias(
            &db,
            guild,
            "alliance",
            "Current Alliance",
            "2026-01-01T00:00:00Z",
            "2026-02-01T00:00:00Z",
        )
        .await;

        let p1 = insert_player(
            &db,
            "id:p1",
            "Alice",
            Some(guild),
            "2026-01-01T00:00:00Z",
            "2026-02-01T00:00:00Z",
        )
        .await;
        insert_battle(
            &db,
            100,
            p1,
            guild,
            "2026-01-01T00:00:00Z",
            Some("dps"),
            Some("T8_MAIN"),
            1200.0,
            1,
            0,
        )
        .await;
        insert_battle(
            &db,
            101,
            p1,
            guild,
            "2026-02-01T00:00:00Z",
            Some("healer"),
            Some("T8_HEAL"),
            1300.0,
            0,
            1,
        )
        .await;

        let service = EnemiesService::new();
        let dossier = service.get_guild(&db, guild).await.expect("dossier");

        assert_eq!(dossier.name, "Current Name");
        assert_eq!(dossier.rollup.battles_fought, 2);
        assert_eq!(dossier.rollup.our_kills, 1);
        assert_eq!(dossier.rollup.their_kills, 1);

        let name_group = dossier
            .aliases
            .iter()
            .find(|g| g.kind == "name")
            .expect("name group");
        assert_eq!(name_group.values.len(), 2);
        assert_eq!(
            name_group.values[0].value, "Old Name",
            "chronological, oldest first"
        );
        assert_eq!(name_group.values[1].value, "Current Name");

        assert_eq!(dossier.roster.len(), 1);
        assert_eq!(
            dossier.roster[0].role.as_deref(),
            Some("healer"),
            "latest battle row wins"
        );
        assert_eq!(
            dossier.roster[0].main_hand_item_id.as_deref(),
            Some("T8_HEAL")
        );

        assert_eq!(dossier.weapon_histogram.len(), 2);
        assert!(
            dossier
                .weapon_histogram
                .iter()
                .any(|w| w.main_hand_item_id == "T8_MAIN" && w.count == 1)
        );
        assert!(
            dossier
                .weapon_histogram
                .iter()
                .any(|w| w.main_hand_item_id == "T8_HEAL" && w.count == 1)
        );
    }

    #[tokio::test]
    async fn get_guild_returns_not_found_for_unknown_id() {
        let db = seed_db().await;
        let service = EnemiesService::new();
        let err = service.get_guild(&db, 999).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn list_players_filters_by_guild_id() {
        let db = seed_db().await;
        let g1 = insert_guild(
            &db,
            "id:1",
            "Guild One",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        let g2 = insert_guild(
            &db,
            "id:2",
            "Guild Two",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        insert_player(
            &db,
            "id:p1",
            "Alice",
            Some(g1),
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        insert_player(
            &db,
            "id:p2",
            "Bob",
            Some(g2),
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;

        let service = EnemiesService::new();
        let page = service
            .list_players(
                &db,
                &default_pagination(),
                None,
                Some(g1),
                None,
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list");
        assert_eq!(page.total_items, 1);
        assert_eq!(page.items[0].name, "Alice");
    }

    #[tokio::test]
    async fn list_players_filters_by_latest_observed_role() {
        let db = seed_db().await;
        let guild = insert_guild(
            &db,
            "id:1",
            "Guild",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        let dps = insert_player(
            &db,
            "id:p1",
            "Dps Player",
            Some(guild),
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        let healer = insert_player(
            &db,
            "id:p2",
            "Healer Player",
            Some(guild),
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        // dps player switched roles over time - only the latest should count.
        insert_battle(
            &db,
            1,
            dps,
            guild,
            "2026-01-01T00:00:00Z",
            Some("healer"),
            None,
            1000.0,
            0,
            0,
        )
        .await;
        insert_battle(
            &db,
            2,
            dps,
            guild,
            "2026-01-05T00:00:00Z",
            Some("dps"),
            None,
            1000.0,
            0,
            0,
        )
        .await;
        insert_battle(
            &db,
            3,
            healer,
            guild,
            "2026-01-05T00:00:00Z",
            Some("healer"),
            None,
            1000.0,
            0,
            0,
        )
        .await;

        let service = EnemiesService::new();
        let page = service
            .list_players(
                &db,
                &default_pagination(),
                None,
                None,
                Some("DPS"),
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list");
        assert_eq!(
            page.total_items, 1,
            "case-insensitive match on latest role only"
        );
        assert_eq!(page.items[0].name, "Dps Player");
    }

    #[tokio::test]
    async fn list_players_search_is_case_insensitive_substring_on_name() {
        let db = seed_db().await;
        insert_player(
            &db,
            "id:p1",
            "Zealous Zed",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        insert_player(
            &db,
            "id:p2",
            "Someone Else",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;

        let service = EnemiesService::new();
        let page = service
            .list_players(
                &db,
                &default_pagination(),
                Some("zealous"),
                None,
                None,
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list");
        assert_eq!(page.total_items, 1);
        assert_eq!(page.items[0].name, "Zealous Zed");
    }

    #[tokio::test]
    async fn list_players_includes_current_guild_name_and_rollups() {
        let db = seed_db().await;
        let guild = insert_guild(
            &db,
            "id:1",
            "Guild Name",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        let player = insert_player(
            &db,
            "id:p1",
            "Alice",
            Some(guild),
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        insert_battle(
            &db,
            1,
            player,
            guild,
            "2026-01-05T00:00:00Z",
            Some("dps"),
            Some("T8_MAIN"),
            1400.0,
            2,
            1,
        )
        .await;

        let service = EnemiesService::new();
        let page = service
            .list_players(
                &db,
                &default_pagination(),
                None,
                None,
                None,
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list");
        assert_eq!(
            page.items[0].current_enemy_guild_name.as_deref(),
            Some("Guild Name")
        );
        assert_eq!(page.items[0].role.as_deref(), Some("dps"));
        assert_eq!(page.items[0].main_hand_item_id.as_deref(), Some("T8_MAIN"));
        assert_eq!(page.items[0].item_power, Some(1400.0));
        assert_eq!(page.items[0].rollup.battles_fought, 1);
        assert_eq!(page.items[0].rollup.our_kills, 2);
        assert_eq!(page.items[0].rollup.their_kills, 1);
    }

    #[tokio::test]
    async fn get_player_returns_history_newest_first_and_rollup() {
        let db = seed_db().await;
        let guild = insert_guild(
            &db,
            "id:1",
            "Guild Name",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        let player = insert_player(
            &db,
            "id:p1",
            "Alice",
            Some(guild),
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        insert_battle(
            &db,
            1,
            player,
            guild,
            "2026-01-01T00:00:00Z",
            Some("dps"),
            Some("T8_MAIN"),
            1200.0,
            1,
            0,
        )
        .await;
        insert_battle(
            &db,
            2,
            player,
            guild,
            "2026-01-05T00:00:00Z",
            Some("dps"),
            Some("T8_MAIN"),
            1300.0,
            2,
            1,
        )
        .await;

        let service = EnemiesService::new();
        let dossier = service.get_player(&db, player).await.expect("dossier");

        assert_eq!(
            dossier.current_enemy_guild_name.as_deref(),
            Some("Guild Name")
        );
        assert_eq!(dossier.battles.len(), 2);
        assert_eq!(dossier.battles[0].battle_id, 2, "newest first");
        assert_eq!(dossier.battles[1].battle_id, 1);
        assert_eq!(dossier.rollup.battles_fought, 2);
        assert_eq!(dossier.rollup.our_kills, 3);
        assert_eq!(dossier.rollup.their_kills, 1);
    }

    #[tokio::test]
    async fn get_player_returns_not_found_for_unknown_id() {
        let db = seed_db().await;
        let service = EnemiesService::new();
        let err = service.get_player(&db, 999).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    /// Two `enemy_player_battles` rows on two different `battle_id`s that both
    /// resolve (via `fight_battles`) to the SAME `fight_id` must still count
    /// as one `distinct_fights`, even though `battles_fought` (raw segments)
    /// is 2. Covers the batched list-page rollup path.
    #[tokio::test]
    async fn batch_rollups_dedupe_battles_fought_into_distinct_fights() {
        let db = seed_db().await;
        let guild = insert_guild(
            &db,
            "id:1",
            "Guild",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        let player = insert_player(
            &db,
            "id:p1",
            "Alice",
            Some(guild),
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        insert_battle(
            &db,
            100,
            player,
            guild,
            "2026-01-01T00:00:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;
        insert_battle(
            &db,
            101,
            player,
            guild,
            "2026-01-01T00:05:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;
        let fight_id = insert_fight(&db).await;
        link_fight_battle(&db, fight_id, 100, 1).await;
        link_fight_battle(&db, fight_id, 101, 2).await;

        let service = EnemiesService::new();

        let guild_page = service
            .list_guilds(&db, &default_pagination(), None, None, SortOrder::Desc)
            .await
            .expect("list guilds");
        assert_eq!(guild_page.items[0].rollup.battles_fought, 2);
        assert_eq!(
            guild_page.items[0].rollup.distinct_fights, 1,
            "two segments of the same fight are one engagement"
        );

        let player_page = service
            .list_players(
                &db,
                &default_pagination(),
                None,
                None,
                None,
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list players");
        assert_eq!(player_page.items[0].rollup.battles_fought, 2);
        assert_eq!(player_page.items[0].rollup.distinct_fights, 1);
    }

    /// The normal case: two battles belonging to two genuinely different
    /// fights must count as two on both fields.
    #[tokio::test]
    async fn batch_rollups_count_distinct_fights_normally_when_fights_differ() {
        let db = seed_db().await;
        let guild = insert_guild(
            &db,
            "id:1",
            "Guild",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        let player = insert_player(
            &db,
            "id:p1",
            "Alice",
            Some(guild),
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        insert_battle(
            &db,
            200,
            player,
            guild,
            "2026-01-01T00:00:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;
        insert_battle(
            &db,
            201,
            player,
            guild,
            "2026-01-02T00:00:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;
        let fight_a = insert_fight(&db).await;
        let fight_b = insert_fight(&db).await;
        link_fight_battle(&db, fight_a, 200, 1).await;
        link_fight_battle(&db, fight_b, 201, 1).await;

        let service = EnemiesService::new();

        let guild_page = service
            .list_guilds(&db, &default_pagination(), None, None, SortOrder::Desc)
            .await
            .expect("list guilds");
        assert_eq!(guild_page.items[0].rollup.battles_fought, 2);
        assert_eq!(guild_page.items[0].rollup.distinct_fights, 2);

        let player_page = service
            .list_players(
                &db,
                &default_pagination(),
                None,
                None,
                None,
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list players");
        assert_eq!(player_page.items[0].rollup.battles_fought, 2);
        assert_eq!(player_page.items[0].rollup.distinct_fights, 2);
    }

    /// Same dedupe guarantee as `batch_rollups_dedupe_battles_fought_into_distinct_fights`,
    /// but through the single-dossier (`get_guild`/`get_player`) path, which
    /// folds rows in Rust rather than via a `GROUP BY`.
    #[tokio::test]
    async fn single_dossier_rollups_dedupe_battles_fought_into_distinct_fights() {
        let db = seed_db().await;
        let guild = insert_guild(
            &db,
            "id:1",
            "Guild",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        let player = insert_player(
            &db,
            "id:p1",
            "Alice",
            Some(guild),
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        insert_battle(
            &db,
            300,
            player,
            guild,
            "2026-01-01T00:00:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;
        insert_battle(
            &db,
            301,
            player,
            guild,
            "2026-01-01T00:05:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;
        let fight_id = insert_fight(&db).await;
        link_fight_battle(&db, fight_id, 300, 1).await;
        link_fight_battle(&db, fight_id, 301, 2).await;

        let service = EnemiesService::new();

        let guild_dossier = service.get_guild(&db, guild).await.expect("get guild");
        assert_eq!(guild_dossier.rollup.battles_fought, 2);
        assert_eq!(guild_dossier.rollup.distinct_fights, 1);

        let player_dossier = service.get_player(&db, player).await.expect("get player");
        assert_eq!(player_dossier.rollup.battles_fought, 2);
        assert_eq!(player_dossier.rollup.distinct_fights, 1);
    }

    /// The normal case through the single-dossier path: two distinct fights
    /// give `battles_fought == distinct_fights == 2`.
    #[tokio::test]
    async fn single_dossier_rollups_count_distinct_fights_normally_when_fights_differ() {
        let db = seed_db().await;
        let guild = insert_guild(
            &db,
            "id:1",
            "Guild",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        let player = insert_player(
            &db,
            "id:p1",
            "Alice",
            Some(guild),
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        insert_battle(
            &db,
            400,
            player,
            guild,
            "2026-01-01T00:00:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;
        insert_battle(
            &db,
            401,
            player,
            guild,
            "2026-01-02T00:00:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;
        let fight_a = insert_fight(&db).await;
        let fight_b = insert_fight(&db).await;
        link_fight_battle(&db, fight_a, 400, 1).await;
        link_fight_battle(&db, fight_b, 401, 1).await;

        let service = EnemiesService::new();

        let guild_dossier = service.get_guild(&db, guild).await.expect("get guild");
        assert_eq!(guild_dossier.rollup.battles_fought, 2);
        assert_eq!(guild_dossier.rollup.distinct_fights, 2);

        let player_dossier = service.get_player(&db, player).await.expect("get player");
        assert_eq!(player_dossier.rollup.battles_fought, 2);
        assert_eq!(player_dossier.rollup.distinct_fights, 2);
    }

    /// Critical defensive case: a `battle_id` that has never been grouped
    /// into any Fight at all (no `fight_battles` row for it whatsoever) must
    /// still contribute `1` to `distinct_fights`, not `0`. An ungrouped
    /// battle is still one real engagement — just not yet formally
    /// recognized as a Fight — and must never be silently dropped from the
    /// tally. Covers both the batched list-page path and the single-dossier
    /// path.
    #[tokio::test]
    async fn ungrouped_battle_still_counts_as_one_distinct_fight() {
        let db = seed_db().await;
        let guild = insert_guild(
            &db,
            "id:1",
            "Guild",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        let player = insert_player(
            &db,
            "id:p1",
            "Alice",
            Some(guild),
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        // Battle 500 is never linked into `fight_battles` at all — no
        // `insert_fight`/`link_fight_battle` call for it anywhere.
        insert_battle(
            &db,
            500,
            player,
            guild,
            "2026-01-01T00:00:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;

        let service = EnemiesService::new();

        let guild_page = service
            .list_guilds(&db, &default_pagination(), None, None, SortOrder::Desc)
            .await
            .expect("list guilds");
        assert_eq!(guild_page.items[0].rollup.battles_fought, 1);
        assert_eq!(
            guild_page.items[0].rollup.distinct_fights, 1,
            "an ungrouped battle_id is still one real engagement, not zero"
        );

        let player_page = service
            .list_players(
                &db,
                &default_pagination(),
                None,
                None,
                None,
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list players");
        assert_eq!(player_page.items[0].rollup.battles_fought, 1);
        assert_eq!(
            player_page.items[0].rollup.distinct_fights, 1,
            "an ungrouped battle_id is still one real engagement, not zero"
        );

        let guild_dossier = service.get_guild(&db, guild).await.expect("get guild");
        assert_eq!(guild_dossier.rollup.battles_fought, 1);
        assert_eq!(
            guild_dossier.rollup.distinct_fights, 1,
            "an ungrouped battle_id is still one real engagement, not zero"
        );

        let player_dossier = service.get_player(&db, player).await.expect("get player");
        assert_eq!(player_dossier.rollup.battles_fought, 1);
        assert_eq!(
            player_dossier.rollup.distinct_fights, 1,
            "an ungrouped battle_id is still one real engagement, not zero"
        );
    }

    /// Mixed case: two `battle_id`s grouped into the SAME fight (two segments
    /// of one engagement) plus one `battle_id` that has never been grouped at
    /// all. `distinct_fights` must be `2` (one for the shared fight, one for
    /// the ungrouped battle), while `battles_fought` counts all three raw
    /// segments. Cross-checks that the batched list-page path and the
    /// single-dossier path agree on the result for identical underlying data.
    #[tokio::test]
    async fn mixed_grouped_and_ungrouped_battles_count_correctly_on_both_paths() {
        let db = seed_db().await;
        let guild = insert_guild(
            &db,
            "id:1",
            "Guild",
            None,
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        let player = insert_player(
            &db,
            "id:p1",
            "Alice",
            Some(guild),
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        insert_battle(
            &db,
            600,
            player,
            guild,
            "2026-01-01T00:00:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;
        insert_battle(
            &db,
            601,
            player,
            guild,
            "2026-01-01T00:05:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;
        // Battle 602 is deliberately left ungrouped.
        insert_battle(
            &db,
            602,
            player,
            guild,
            "2026-01-02T00:00:00Z",
            Some("dps"),
            None,
            1200.0,
            1,
            0,
        )
        .await;
        let fight_a = insert_fight(&db).await;
        link_fight_battle(&db, fight_a, 600, 1).await;
        link_fight_battle(&db, fight_a, 601, 2).await;

        let service = EnemiesService::new();

        let guild_page = service
            .list_guilds(&db, &default_pagination(), None, None, SortOrder::Desc)
            .await
            .expect("list guilds");
        assert_eq!(guild_page.items[0].rollup.battles_fought, 3);
        assert_eq!(guild_page.items[0].rollup.distinct_fights, 2);

        let player_page = service
            .list_players(
                &db,
                &default_pagination(),
                None,
                None,
                None,
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list players");
        assert_eq!(player_page.items[0].rollup.battles_fought, 3);
        assert_eq!(player_page.items[0].rollup.distinct_fights, 2);

        let guild_dossier = service.get_guild(&db, guild).await.expect("get guild");
        assert_eq!(guild_dossier.rollup.battles_fought, 3);
        assert_eq!(guild_dossier.rollup.distinct_fights, 2);

        let player_dossier = service.get_player(&db, player).await.expect("get player");
        assert_eq!(player_dossier.rollup.battles_fought, 3);
        assert_eq!(player_dossier.rollup.distinct_fights, 2);

        // Cross-check: the two independently-implemented techniques
        // (batched GROUP BY + fold vs. full-row fold) must agree exactly.
        assert_eq!(
            guild_page.items[0].rollup.distinct_fights, guild_dossier.rollup.distinct_fights,
            "list-view and detail-view techniques must agree"
        );
        assert_eq!(
            player_page.items[0].rollup.distinct_fights, player_dossier.rollup.distinct_fights,
            "list-view and detail-view techniques must agree"
        );
    }
}
