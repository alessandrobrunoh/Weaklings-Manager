//! Business logic for the events module.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, Set,
};

use chrono::{DateTime, Duration as ChronoDuration, Utc};

use super::entities::{event, event_battle, event_discord_role, event_participation};
use super::models::{
    BattlePerformanceStats, CompPerformanceView, CreateEventRequest, EventBattleView,
    EventDetailView, EventParticipantView, EventSplitStats, EventView, OpponentPerformanceView,
    ParticipateEventRequest, UpdateEventBattlesRequest, UpdateEventRequest,
};

use crate::errors::AppError;
use crate::modules::albionbb::client::{
    AlbionBbBattleSummary, AlbionBbBattlesFilters, AlbionBbGuild,
};
use crate::modules::albionbb::service::AlbionBbService;
use crate::modules::audit::service::AuditService;
use crate::modules::battles::entities::{
    Column as GuildBattleSnapshotColumn, Entity as GuildBattleSnapshotEntity,
};
use crate::modules::battles::models::{BattleLossEstimate, GuildLossEstimate, PlayerLossEstimate};
use crate::modules::comps::entities::{build, comp, comp_build};
use crate::modules::splits::entities::{split, split_participant};
use crate::modules::splits::service::SplitService;
use crate::modules::splits::status::SplitStatus;
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

/// Hard cap on how long an event session can stay live before the background
/// worker auto-stops it. Tuned to 3 hours per product requirement.
const MAX_SESSION_DURATION: ChronoDuration = ChronoDuration::hours(3);

/// Grace period after a session is stopped during which the linker keeps
/// re-fetching AlbionBB to absorb the upstream's slow ingestion (~30 minutes).
const LINK_GRACE_PERIOD: ChronoDuration = ChronoDuration::minutes(45);

fn normalize_discord_role_ids(role_ids: Vec<String>) -> Result<Vec<String>, AppError> {
    let mut normalized = Vec::with_capacity(role_ids.len());
    let mut seen = HashSet::with_capacity(role_ids.len());

    for role_id in role_ids {
        let role_id = role_id.trim();
        if !role_id.chars().all(|character| character.is_ascii_digit())
            || !(17..=20).contains(&role_id.len())
        {
            return Err(AppError::Validation(
                "discord_role_ids must contain Discord snowflakes (17-20 digits)".to_string(),
            ));
        }
        if seen.insert(role_id.to_string()) {
            normalized.push(role_id.to_string());
        }
    }

    Ok(normalized)
}

async fn load_event_discord_role_ids(
    db: &DatabaseConnection,
    event_id: i64,
) -> Result<Vec<String>, AppError> {
    Ok(event_discord_role::Entity::find()
        .filter(event_discord_role::Column::EventId.eq(event_id))
        .order_by_asc(event_discord_role::Column::SortOrder)
        .all(db)
        .await
        .map_err(AppError::Database)?
        .into_iter()
        .map(|role| role.discord_role_id)
        .collect())
}

/// Incremental accumulator for opponent analytics.
#[derive(Debug, Clone, Default)]
struct OpponentRollup {
    guild_id: Option<String>,
    guild_name: String,
    battles: i64,
    wins: i64,
    guild_kill_fame: i64,
    opponent_kill_fame: i64,
}

/// Battle-side classification rules for event analytics.
///
/// AlbionBB exposes every guild in the fight as a peer, but event stats need to separate our side
/// from real opponents. The configured guild plus allied guild IDs/names are treated as friendly,
/// so alliance members do not pollute opponent charts or matchup summaries.
///
/// # Example
/// ```ignore
/// let context = BattleLinkingContext::new(
///     "weaklings-id",
///     &["ally-id".to_string()],
///     &["BetterGetBack".to_string()],
/// );
/// assert!(context.is_friendly_guild("ally-id", "BetterGetBack"));
/// ```
#[derive(Debug, Clone)]
pub struct BattleLinkingContext {
    guild_id: String,
    allied_guild_ids: HashSet<String>,
    allied_guild_names: HashSet<String>,
    server: Option<String>,
}

impl BattleLinkingContext {
    /// Creates a normalized friendly-guild classifier for a single linking run.
    ///
    /// IDs are kept case-sensitive because Albion IDs are opaque. Names are lower-cased to tolerate
    /// operator input differences in environment variables. The method performs no I/O and is safe
    /// to construct per request or worker tick.
    ///
    /// # Example
    /// ```ignore
    /// let context = BattleLinkingContext::new("main", &[], &["BetterGetBack".to_string()]);
    /// assert!(context.is_friendly_guild("main", "Weaklings"));
    /// ```
    #[must_use]
    pub fn new(guild_id: &str, allied_guild_ids: &[String], allied_guild_names: &[String]) -> Self {
        Self {
            guild_id: guild_id.to_string(),
            allied_guild_ids: allied_guild_ids.iter().cloned().collect(),
            allied_guild_names: allied_guild_names
                .iter()
                .map(|name| name.to_ascii_lowercase())
                .collect(),
            server: None,
        }
    }

    /// Sets the AlbionBB server used by automatic battle linking.
    #[must_use]
    pub fn with_server(mut self, server: Option<String>) -> Self {
        self.server = server;
        self
    }

    /// AlbionBB server path segment, if configured.
    #[must_use]
    pub fn server(&self) -> Option<&str> {
        self.server.as_deref()
    }

    /// Returns `true` when a battle guild belongs to our side.
    ///
    /// The configured guild ID always wins, then explicit allied IDs, then normalized names as a
    /// fallback for partial upstream payloads.
    ///
    /// # Example
    /// ```ignore
    /// let context = BattleLinkingContext::new("main", &[], &["BetterGetBack".to_string()]);
    /// assert!(context.is_friendly_guild("", "bettergetback"));
    /// ```
    #[must_use]
    pub fn is_friendly_guild(&self, guild_id: &str, guild_name: &str) -> bool {
        if guild_id == self.guild_id || self.allied_guild_ids.contains(guild_id) {
            return true;
        }
        if guild_name.trim().is_empty() {
            return false;
        }
        self.allied_guild_names
            .contains(&guild_name.to_ascii_lowercase())
    }

    /// Configured Albion guild ID used to query AlbionBB and identify our own guild row.
    #[must_use]
    pub fn guild_id(&self) -> &str {
        &self.guild_id
    }
}

/// Compact battle snapshot derived from AlbionBB for event analytics.
#[derive(Debug, Clone)]
struct LinkedBattleSnapshot {
    guild_players_count: i64,
    battle_total_players: i64,
    guild_kills: i64,
    guild_deaths: i64,
    guild_kill_fame: i64,
    is_win: bool,
    opponent: Option<AlbionBbGuild>,
}

/// Computes a percentage and safely handles empty denominators.
pub(crate) fn ratio_percent(part: i64, total: i64) -> f64 {
    if total == 0 {
        return 0.0;
    }

    (part as f64 / total as f64) * 100.0
}

/// Computes K/D while avoiding division by zero.
pub(crate) fn kill_death_ratio(kills: i64, deaths: i64) -> f64 {
    if deaths == 0 {
        return kills as f64;
    }

    kills as f64 / deaths as f64
}

/// Ranks the most relevant opponents for the current analytics scope.
pub(crate) fn build_top_opponents(
    battle_rows: &[event_battle::Model],
) -> Vec<OpponentPerformanceView> {
    let mut rollups: HashMap<String, OpponentRollup> = HashMap::new();

    for battle in battle_rows {
        let opponent_name = battle
            .opponent_guild_name
            .clone()
            .unwrap_or_else(|| "Unknown opponent".to_string());
        let key = battle
            .opponent_guild_id
            .clone()
            .unwrap_or_else(|| opponent_name.clone());
        let rollup = rollups.entry(key).or_insert_with(|| OpponentRollup {
            guild_id: battle.opponent_guild_id.clone(),
            guild_name: opponent_name,
            ..Default::default()
        });
        rollup.battles += 1;
        rollup.wins += i64::from(battle.is_win);
        rollup.guild_kill_fame += battle.guild_kill_fame;
        rollup.opponent_kill_fame += battle.opponent_kill_fame.unwrap_or_default();
    }

    let mut opponents: Vec<OpponentPerformanceView> = rollups
        .into_values()
        .map(|rollup| OpponentPerformanceView {
            guild_id: rollup.guild_id,
            guild_name: rollup.guild_name,
            battles: rollup.battles,
            wins: rollup.wins,
            losses: rollup.battles - rollup.wins,
            guild_kill_fame: rollup.guild_kill_fame,
            opponent_kill_fame: rollup.opponent_kill_fame,
        })
        .collect();

    opponents.sort_by(|left, right| {
        right
            .battles
            .cmp(&left.battles)
            .then(right.opponent_kill_fame.cmp(&left.opponent_kill_fame))
    });
    opponents.truncate(5);
    opponents
}

/// Builds the persisted analytics snapshot for a battle summary.
fn linked_battle_snapshot(
    battle: &AlbionBbBattleSummary,
    context: &BattleLinkingContext,
) -> LinkedBattleSnapshot {
    let guild = battle
        .guilds
        .iter()
        .find(|guild| guild.id == context.guild_id());
    let opponent = battle
        .guilds
        .iter()
        .filter(|guild| !context.is_friendly_guild(&guild.id, &guild.name))
        .max_by_key(|guild| guild.kill_fame)
        .cloned();

    LinkedBattleSnapshot {
        guild_players_count: guild.map(|guild| guild.players).unwrap_or_default(),
        battle_total_players: battle.total_players,
        guild_kills: guild.map(|guild| guild.kills).unwrap_or_default(),
        guild_deaths: guild.map(|guild| guild.deaths).unwrap_or_default(),
        guild_kill_fame: guild.map(|guild| guild.kill_fame).unwrap_or_default(),
        is_win: guild.map(|guild| guild.winner).unwrap_or(false),
        opponent,
    }
}

/// Applies the same analytics snapshot to both newly linked and refreshed rows.
fn apply_battle_snapshot(
    row: &mut event_battle::ActiveModel,
    snapshot: &LinkedBattleSnapshot,
) -> Result<(), AppError> {
    row.guild_players_count = Set(i32::try_from(snapshot.guild_players_count).map_err(|e| {
        AppError::Validation(format!(
            "Guild player count does not fit database column: {e}"
        ))
    })?);
    row.battle_total_players = Set(Some(i32::try_from(snapshot.battle_total_players).map_err(
        |e| {
            AppError::Validation(format!(
                "Battle player count does not fit database column: {e}"
            ))
        },
    )?));
    row.guild_kills = Set(snapshot.guild_kills);
    row.guild_deaths = Set(snapshot.guild_deaths);
    row.guild_kill_fame = Set(snapshot.guild_kill_fame);
    row.is_win = Set(snapshot.is_win);

    let opponent = snapshot.opponent.as_ref();
    row.opponent_guild_id = Set(opponent.map(|guild| guild.id.clone()));
    row.opponent_guild_name = Set(opponent.map(|guild| guild.name.clone()));
    row.opponent_players_count = Set(opponent
        .map(|guild| {
            i32::try_from(guild.players).map_err(|e| {
                AppError::Validation(format!(
                    "Opponent player count does not fit database column: {e}"
                ))
            })
        })
        .transpose()?);
    row.opponent_kills = Set(opponent.map(|guild| guild.kills));
    row.opponent_deaths = Set(opponent.map(|guild| guild.deaths));
    row.opponent_kill_fame = Set(opponent.map(|guild| guild.kill_fame));
    Ok(())
}

/// Aggregates persisted battle loss estimates for an event.
async fn build_event_loss_estimate(
    db: &DatabaseConnection,
    battle_rows: &[event_battle::Model],
) -> Result<BattleLossEstimate, AppError> {
    let battle_ids = battle_rows
        .iter()
        .filter_map(|battle| battle.albionbb_battle_id.parse::<i64>().ok())
        .collect::<Vec<_>>();
    if battle_ids.is_empty() {
        return Ok(BattleLossEstimate::default());
    }

    let snapshots = GuildBattleSnapshotEntity::find()
        .filter(GuildBattleSnapshotColumn::BattleId.is_in(battle_ids))
        .all(db)
        .await
        .map_err(AppError::Database)?;

    let mut total = BattleLossEstimate::default();
    let mut players: HashMap<String, PlayerLossEstimate> = HashMap::new();
    let mut guilds: HashMap<String, GuildLossEstimate> = HashMap::new();

    for snapshot in snapshots {
        let estimate: BattleLossEstimate =
            serde_json::from_str(&snapshot.losses_json).map_err(|error| {
                AppError::Internal(format!("Failed to parse battle loss snapshot: {error}"))
            })?;
        total.total_estimated_loss += estimate.total_estimated_loss;
        total.priced_items += estimate.priced_items;
        total.total_items += estimate.total_items;

        for player in estimate.players {
            let rollup = players
                .entry(player.player_name.clone())
                .or_insert_with(|| PlayerLossEstimate {
                    player_name: player.player_name.clone(),
                    guild_name: player.guild_name.clone(),
                    ..Default::default()
                });
            rollup.estimated_loss += player.estimated_loss;
            rollup.deaths += player.deaths;
            rollup.priced_items += player.priced_items;
            rollup.total_items += player.total_items;
        }

        for guild in estimate.guilds {
            let rollup =
                guilds
                    .entry(guild.guild_name.clone())
                    .or_insert_with(|| GuildLossEstimate {
                        guild_name: guild.guild_name.clone(),
                        ..Default::default()
                    });
            rollup.estimated_loss += guild.estimated_loss;
            rollup.deaths += guild.deaths;
            rollup.priced_items += guild.priced_items;
            rollup.total_items += guild.total_items;
        }
    }

    total.players = players.into_values().collect();
    total
        .players
        .sort_by(|left, right| right.estimated_loss.cmp(&left.estimated_loss));
    total.guilds = guilds.into_values().collect();
    total
        .guilds
        .sort_by(|left, right| right.estimated_loss.cmp(&left.estimated_loss));
    Ok(total)
}

/// Builds loot/economy rollups from splits attached to an event.
fn build_split_stats(splits: &[split::Model], participant_entries: i64) -> EventSplitStats {
    let mut stats = EventSplitStats {
        total_splits: splits.len() as i64,
        participant_entries,
        ..Default::default()
    };

    for split in splits {
        stats.estimated_market_value += split.estimated_market_value;
        stats.repair_value += split.repair_value;
        stats.bags_value += split.bags_value;
        if let Some(net_value) = split.net_value {
            stats.completed_net_value += net_value;
        }

        match SplitStatus::from_str(&split.status) {
            Ok(SplitStatus::Pending) => stats.pending_splits += 1,
            Ok(SplitStatus::Completed) => stats.completed_splits += 1,
            Ok(SplitStatus::NotCompleted) => stats.not_completed_splits += 1,
            Ok(SplitStatus::Lost) => stats.lost_splits += 1,
            Err(_) => {}
        }
    }

    stats
}

/// Deduplicates user-provided battle IDs while preserving the order officers typed.
fn normalize_battle_ids(raw_battle_ids: &[String]) -> Result<Vec<String>, AppError> {
    if raw_battle_ids.len() > 50 {
        return Err(AppError::Validation(
            "A maximum of 50 battles can be linked to one event at once".to_string(),
        ));
    }

    let mut seen = HashSet::new();
    let mut battle_ids = Vec::new();
    for raw_battle_id in raw_battle_ids {
        let battle_id = raw_battle_id.trim();
        if battle_id.is_empty() {
            continue;
        }
        if seen.insert(battle_id.to_string()) {
            battle_ids.push(battle_id.to_string());
        }
    }

    Ok(battle_ids)
}

/// Service layer coordinating events operations.
#[derive(Debug, Clone)]
pub struct EventService;

impl EventService {
    /// Creates a new service instance.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Helper to get total capacity of a composition.
    pub async fn get_comp_capacity(
        &self,
        db: &DatabaseConnection,
        comp_id: i64,
    ) -> Result<i64, AppError> {
        let builds = comp_build::Entity::find()
            .filter(comp_build::Column::CompId.eq(comp_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;

        let capacity: i64 = builds.iter().map(|b| i64::from(b.quantity)).sum();
        Ok(capacity)
    }

    /// Resolves the active composition (base or variant) for a given target size.
    pub async fn resolve_active_comp(
        &self,
        db: &DatabaseConnection,
        base_comp_id: i64,
        target_size: usize,
    ) -> Result<(comp::Model, i64), AppError> {
        // Fetch base comp
        let base_comp = comp::Entity::find_by_id(base_comp_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Base comp {base_comp_id} not found")))?;

        // Fetch variants
        let variants = comp::Entity::find()
            .filter(comp::Column::ParentId.eq(base_comp_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;

        let mut comps = vec![base_comp];
        comps.extend(variants);

        let mut comps_with_capacity = Vec::new();
        for c in comps {
            let capacity = self.get_comp_capacity(db, c.id).await?;
            comps_with_capacity.push((c, capacity));
        }

        // Sort by capacity ascending
        comps_with_capacity.sort_by_key(|(_, cap)| *cap);

        // Find first comp with capacity >= target_size
        let active = comps_with_capacity
            .into_iter()
            .find(|(_, cap)| *cap >= target_size as i64);

        if let Some((active_comp, capacity)) = active {
            Ok((active_comp, capacity))
        } else {
            Err(AppError::Validation("The composition is full".to_string()))
        }
    }

    /// Helper to convert event::Model to EventView.
    pub async fn to_event_view(
        &self,
        db: &DatabaseConnection,
        model: event::Model,
    ) -> Result<EventView, AppError> {
        let comp = comp::Entity::find_by_id(model.comp_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Comp {} not found", model.comp_id)))?;

        let created_by_username =
            crate::modules::users::display_name::resolve_by_id(db, model.created_by).await?;
        let discord_role_ids = load_event_discord_role_ids(db, model.id).await?;

        Ok(EventView {
            id: model.id,
            title: model.title,
            description: model.description,
            call_to_arms: model.call_to_arms,
            discord_role_ids,
            regear: model.regear,
            comp_id: model.comp_id,
            comp_name: comp.name,
            created_by: model.created_by,
            created_by_username,
            event_date_utc: model.event_date_utc.to_rfc3339(),
            created_at: model.created_at.to_rfc3339(),
            updated_at: model.updated_at.to_rfc3339(),
            status: model.status,
            started_at: model.started_at.map(|t| t.to_rfc3339()),
            stopped_at: model.stopped_at.map(|t| t.to_rfc3339()),
            auto_stop_deadline: model.auto_stop_deadline.map(|t| t.to_rfc3339()),
            link_status: model.link_status,
            link_attempts: model.link_attempts,
            link_last_error: model.link_last_error,
            link_battles_completed_at: model.link_battles_completed_at.map(|t| t.to_rfc3339()),
        })
    }

    /// Lists paginated events.
    pub async fn list_events(
        &self,
        db: &DatabaseConnection,
        pagination: PaginationParams,
        filters: super::models::EventFilters,
    ) -> Result<PaginatedData<EventView>, AppError> {
        let page = pagination.offset_page();
        let limit = pagination.limit();

        let mut query = event::Entity::find();

        if let Some(search) = filters.search {
            if !search.trim().is_empty() {
                let pattern = format!("%{}%", search.trim());
                query = query.filter(
                    sea_orm::Condition::any().add(
                        Expr::expr(Func::lower(Expr::col(event::Column::Title)))
                            .like(pattern.to_lowercase()),
                    ),
                );
            }
        }

        if let Some(date_from) = filters.date_from {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&date_from) {
                query = query.filter(event::Column::EventDateUtc.gte(dt));
            }
        }

        if let Some(date_to) = filters.date_to {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&date_to) {
                query = query.filter(event::Column::EventDateUtc.lte(dt));
            }
        }

        if let Some(status) = filters
            .status
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            query = query.filter(event::Column::Status.eq(status));
        }

        let sort_column = resolve_sort_key(
            filters.sort.as_deref(),
            &[
                ("event_date_utc", event::Column::EventDateUtc),
                ("title", event::Column::Title),
                ("created_at", event::Column::CreatedAt),
                ("status", event::Column::Status),
            ],
            event::Column::EventDateUtc,
        )?;
        let order = match filters
            .order
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("desc") => SortOrder::Desc,
            _ => SortOrder::Asc,
        };
        let query = match order {
            SortOrder::Asc => query.order_by_asc(sort_column),
            SortOrder::Desc => query.order_by_desc(sort_column),
        };

        let paginator = query.paginate(db, limit);

        let total_items = paginator.num_items().await.map_err(AppError::Database)?;
        let total_pages = paginator.num_pages().await.map_err(AppError::Database)?;
        let current_page = page + 1;

        let models = paginator
            .fetch_page(page)
            .await
            .map_err(AppError::Database)?;

        let mut items = Vec::new();
        for m in models {
            items.push(self.to_event_view(db, m).await?);
        }

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            current_page,
            limit,
        ))
    }

    /// Gets detailed event information including participants and resolved active comp.
    pub async fn get_event_detail(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<EventDetailView, AppError> {
        self.get_event_detail_scoped(db, id, None).await
    }

    /// Gets event details while applying friendly-guild opponent filtering.
    ///
    /// Persisted battle rows may have been linked before alliance configuration existed. Applying
    /// the context at read time makes existing event analytics correct immediately after operators
    /// configure allied guild IDs/names, without requiring a destructive relink.
    ///
    /// # Example
    /// ```ignore
    /// let context = BattleLinkingContext::new("guild-id", &[], &["BetterGetBack".to_string()]);
    /// let detail = service.get_event_detail_with_context(&db, 1, &context).await?;
    /// ```
    pub async fn get_event_detail_with_context(
        &self,
        db: &DatabaseConnection,
        id: i64,
        context: &BattleLinkingContext,
    ) -> Result<EventDetailView, AppError> {
        self.get_event_detail_scoped(db, id, Some(context)).await
    }

    async fn get_event_detail_scoped(
        &self,
        db: &DatabaseConnection,
        id: i64,
        context: Option<&BattleLinkingContext>,
    ) -> Result<EventDetailView, AppError> {
        let event_model = event::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;

        let event_view = self.to_event_view(db, event_model.clone()).await?;

        let participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(id))
            .order_by_asc(event_participation::Column::CreatedAt)
            .all(db)
            .await
            .map_err(AppError::Database)?;

        let (active_comp, active_capacity) = self
            .resolve_active_comp(db, event_model.comp_id, participations.len())
            .await?;

        let participant_user_ids: Vec<i64> = participations.iter().map(|p| p.user_id).collect();
        let specialization_rows = if participant_user_ids.is_empty() {
            Vec::new()
        } else {
            crate::modules::users::specializations::Entity::find()
                .filter(
                    crate::modules::users::specializations::Column::UserId
                        .is_in(participant_user_ids),
                )
                .all(db)
                .await
                .map_err(AppError::Database)?
        };
        let mut specializations_by_user: HashMap<i64, HashMap<String, i32>> = HashMap::new();
        for row in specialization_rows {
            let node_key =
                crate::modules::users::specializations::canonical_node_key(&row.node_key);
            specializations_by_user
                .entry(row.user_id)
                .or_default()
                .entry(node_key)
                .and_modify(|level| *level = (*level).max(row.level))
                .or_insert(row.level);
        }

        let mut participant_views = Vec::new();
        for p in participations {
            let user = crate::modules::users::entities::Entity::find_by_id(p.user_id)
                .one(db)
                .await
                .map_err(AppError::Database)?
                .ok_or_else(|| AppError::NotFound(format!("User {} not found", p.user_id)))?;
            let username = crate::modules::users::display_name::resolve(db, &user).await?;

            let primary_build = build::Entity::find_by_id(p.primary_build_id)
                .one(db)
                .await
                .map_err(AppError::Database)?
                .ok_or_else(|| {
                    AppError::NotFound(format!("Build {} not found", p.primary_build_id))
                })?;

            let secondary_build_name = if let Some(sec_id) = p.secondary_build_id {
                let sec_build = build::Entity::find_by_id(sec_id)
                    .one(db)
                    .await
                    .map_err(AppError::Database)?
                    .ok_or_else(|| AppError::NotFound(format!("Build {} not found", sec_id)))?;
                Some(sec_build.name)
            } else {
                None
            };

            participant_views.push(EventParticipantView {
                user_id: p.user_id,
                username,
                discord_id: user.discord_id.clone(),
                primary_build_id: p.primary_build_id,
                primary_build_name: primary_build.name,
                secondary_build_id: p.secondary_build_id,
                secondary_build_name,
                specializations: specializations_by_user
                    .remove(&p.user_id)
                    .unwrap_or_default(),
            });
        }

        let battle_rows = event_battle::Entity::find()
            .filter(event_battle::Column::EventId.eq(id))
            .order_by_asc(event_battle::Column::BattleStartedAt)
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let battle_rows = Self::apply_read_context_to_battles(battle_rows, context);
        let stats = Self::build_performance_stats(&battle_rows);
        let estimated_losses = build_event_loss_estimate(db, &battle_rows).await?;
        let battles = battle_rows
            .into_iter()
            .map(Self::to_event_battle_view)
            .collect();

        let split_rows = split::Entity::find()
            .filter(split::Column::EventId.eq(id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let split_ids: Vec<i64> = split_rows.iter().map(|split| split.id).collect();
        let participant_entries = if split_ids.is_empty() {
            0
        } else {
            split_participant::Entity::find()
                .filter(split_participant::Column::SplitId.is_in(split_ids))
                .count(db)
                .await
                .map_err(AppError::Database)? as i64
        };
        let split_stats = build_split_stats(&split_rows, participant_entries);
        let split_service = SplitService::new();
        let mut splits = Vec::with_capacity(split_rows.len());
        for split in split_rows {
            splits.push(split_service.to_summary(db, split).await?);
        }

        Ok(EventDetailView {
            event: event_view,
            active_comp_id: active_comp.id,
            active_comp_name: active_comp.name,
            active_comp_capacity: active_capacity,
            participants: participant_views,
            battles,
            stats,
            estimated_losses,
            splits,
            split_stats,
        })
    }

    /// Aggregates all linked battles for events using a composition.
    ///
    /// This powers the comp-level analytics page without depending on AlbionBB
    /// at read time; only snapshots already linked to completed/live events are
    /// used.
    pub async fn get_comp_performance(
        &self,
        db: &DatabaseConnection,
        comp_id: i64,
    ) -> Result<CompPerformanceView, AppError> {
        let comp_model = comp::Entity::find_by_id(comp_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Comp {comp_id} not found")))?;

        let event_models = event::Entity::find()
            .filter(event::Column::CompId.eq(comp_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let event_ids: Vec<i64> = event_models.iter().map(|model| model.id).collect();

        if event_ids.is_empty() {
            return Ok(CompPerformanceView {
                comp_id,
                comp_name: comp_model.name,
                events_with_battles: 0,
                stats: BattlePerformanceStats::default(),
            });
        }

        let battle_rows = event_battle::Entity::find()
            .filter(event_battle::Column::EventId.is_in(event_ids))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let events_with_battles = battle_rows
            .iter()
            .map(|battle| battle.event_id)
            .collect::<HashSet<_>>()
            .len() as i64;

        Ok(CompPerformanceView {
            comp_id,
            comp_name: comp_model.name,
            events_with_battles,
            stats: Self::build_performance_stats(&battle_rows),
        })
    }

    /// Clears friendly guilds from persisted opponent fields before producing analytics.
    fn apply_read_context_to_battles(
        battle_rows: Vec<event_battle::Model>,
        context: Option<&BattleLinkingContext>,
    ) -> Vec<event_battle::Model> {
        let Some(context) = context else {
            return battle_rows;
        };

        battle_rows
            .into_iter()
            .map(|mut battle| {
                let opponent_id = battle.opponent_guild_id.as_deref().unwrap_or_default();
                let opponent_name = battle.opponent_guild_name.as_deref().unwrap_or_default();
                if context.is_friendly_guild(opponent_id, opponent_name) {
                    battle.opponent_guild_id = None;
                    battle.opponent_guild_name = None;
                    battle.opponent_players_count = None;
                    battle.opponent_kills = None;
                    battle.opponent_deaths = None;
                    battle.opponent_kill_fame = None;
                }
                battle
            })
            .collect()
    }

    /// Converts a linked battle row into an API view.
    fn to_event_battle_view(battle: event_battle::Model) -> EventBattleView {
        EventBattleView {
            id: battle.id,
            albionbb_battle_id: battle.albionbb_battle_id,
            battle_started_at: battle.battle_started_at.to_rfc3339(),
            guild_players_count: battle.guild_players_count,
            battle_total_players: battle.battle_total_players,
            fetched_at: battle.fetched_at.to_rfc3339(),
            guild_kills: battle.guild_kills,
            guild_deaths: battle.guild_deaths,
            guild_kill_fame: battle.guild_kill_fame,
            is_win: battle.is_win,
            opponent_guild_id: battle.opponent_guild_id,
            opponent_guild_name: battle.opponent_guild_name,
            opponent_players_count: battle.opponent_players_count,
            opponent_kills: battle.opponent_kills,
            opponent_deaths: battle.opponent_deaths,
            opponent_kill_fame: battle.opponent_kill_fame,
        }
    }

    /// Builds analytics rollups from persisted battle snapshots.
    pub(crate) fn build_performance_stats(
        battle_rows: &[event_battle::Model],
    ) -> BattlePerformanceStats {
        if battle_rows.is_empty() {
            return BattlePerformanceStats::default();
        }

        let total_battles = battle_rows.len() as i64;
        let wins = battle_rows.iter().filter(|battle| battle.is_win).count() as i64;
        let total_kills = battle_rows.iter().map(|battle| battle.guild_kills).sum();
        let total_deaths = battle_rows.iter().map(|battle| battle.guild_deaths).sum();
        let total_kill_fame = battle_rows
            .iter()
            .map(|battle| battle.guild_kill_fame)
            .sum();
        let player_sum: i64 = battle_rows
            .iter()
            .map(|battle| i64::from(battle.guild_players_count))
            .sum();

        BattlePerformanceStats {
            total_battles,
            wins,
            losses: total_battles - wins,
            win_rate: ratio_percent(wins, total_battles),
            total_kills,
            total_deaths,
            kill_death_ratio: kill_death_ratio(total_kills, total_deaths),
            total_kill_fame,
            average_guild_players: player_sum as f64 / total_battles as f64,
            top_opponents: build_top_opponents(battle_rows),
        }
    }

    /// Creates a new event.
    pub async fn create_event(
        &self,
        db: &DatabaseConnection,
        creator_id: i64,
        req: CreateEventRequest,
    ) -> Result<EventView, AppError> {
        let discord_role_ids = normalize_discord_role_ids(req.discord_role_ids)?;

        // Validate comp exists
        let comp_exists = comp::Entity::find_by_id(req.comp_id)
            .count(db)
            .await
            .map_err(AppError::Database)?
            > 0;

        if !comp_exists {
            return Err(AppError::NotFound(format!(
                "Composition {} not found",
                req.comp_id
            )));
        }

        let linked_split_tab = if req.create_split {
            let Some(island_tab_id) = req.island_tab_id else {
                return Err(AppError::Validation(
                    "island_tab_id is required when create_split is true".to_string(),
                ));
            };
            crate::modules::splits::service::require_island_tab(db, island_tab_id).await?;
            Some(island_tab_id)
        } else {
            None
        };

        // Parse date
        let parsed_date = chrono::DateTime::parse_from_rfc3339(&req.event_date_utc)
            .map_err(|e| AppError::Validation(format!("Invalid event date: {e}")))?;

        let event_model = event::ActiveModel {
            title: Set(req.title),
            description: Set(req.description),
            call_to_arms: Set(req.call_to_arms),
            regear: Set(req.regear),
            comp_id: Set(req.comp_id),
            created_by: Set(creator_id),
            event_date_utc: Set(parsed_date.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .map_err(AppError::Database)?;

        let event_id = event_model.id;
        for (sort_order, discord_role_id) in discord_role_ids.into_iter().enumerate() {
            event_discord_role::ActiveModel {
                event_id: Set(event_id),
                discord_role_id: Set(discord_role_id),
                sort_order: Set(i32::try_from(sort_order).map_err(|_| {
                    AppError::Validation("too many Discord roles selected".to_string())
                })?),
            }
            .insert(db)
            .await
            .map_err(AppError::Database)?;
        }

        let event_view = self.to_event_view(db, event_model).await?;

        if let Some(island_tab_id) = linked_split_tab {
            // Best-effort: an event is still perfectly usable without its
            // split, so a failure here is logged rather than rolling back a
            // successfully created event.
            if let Err(e) =
                create_linked_split(db, creator_id, event_id, &event_view.title, island_tab_id)
                    .await
            {
                tracing::warn!(event_id, error = %e, "failed to create the correlated split");
            }
        }

        let _ = AuditService::log(
            db,
            "EVENT_CREATED",
            Some("EVENT"),
            Some(event_view.id),
            Some(creator_id),
            Some(serde_json::json!({
                "title": event_view.title,
                "comp_id": req.comp_id
            })),
        )
        .await;

        try_award_event_xp(
            db,
            creator_id,
            event_id,
            crate::modules::progression::status::XpSource::EventCreate,
            format!("event_create:{event_id}"),
        )
        .await;

        Ok(event_view)
    }

    /// Updates an existing event.
    pub async fn update_event(
        &self,
        db: &DatabaseConnection,
        id: i64,
        req: UpdateEventRequest,
    ) -> Result<EventView, AppError> {
        let event_model = event::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;

        let mut active: event::ActiveModel = event_model.into();

        if let Some(title) = req.title {
            active.title = Set(title);
        }
        if let Some(description) = req.description {
            active.description = Set(Some(description));
        }
        if let Some(call_to_arms) = req.call_to_arms {
            active.call_to_arms = Set(call_to_arms);
        }
        if let Some(regear) = req.regear {
            active.regear = Set(regear);
        }
        if let Some(comp_id) = req.comp_id {
            // Validate comp exists
            let comp_exists = comp::Entity::find_by_id(comp_id)
                .count(db)
                .await
                .map_err(AppError::Database)?
                > 0;
            if !comp_exists {
                return Err(AppError::NotFound(format!(
                    "Composition {} not found",
                    comp_id
                )));
            }
            active.comp_id = Set(comp_id);
        }
        if let Some(date_str) = req.event_date_utc {
            let parsed_date = chrono::DateTime::parse_from_rfc3339(&date_str)
                .map_err(|e| AppError::Validation(format!("Invalid event date: {e}")))?;
            active.event_date_utc = Set(parsed_date.into());
        }

        active.updated_at = Set(chrono::Utc::now().into());

        let updated = active.update(db).await.map_err(AppError::Database)?;
        self.to_event_view(db, updated).await
    }

    /// Deletes an event.
    pub async fn delete_event(&self, db: &DatabaseConnection, id: i64) -> Result<(), AppError> {
        let deleted = event::Entity::delete_by_id(id)
            .exec(db)
            .await
            .map_err(AppError::Database)?;

        if deleted.rows_affected == 0 {
            return Err(AppError::NotFound(format!("Event {id} not found")));
        }

        Ok(())
    }

    // --- Session lifecycle -------------------------------------------------

    /// Returns a scheduled event after validating that a manual Discord reminder is still valid.
    pub async fn prepare_event_reminder(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<EventView, AppError> {
        let model = event::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;

        if model.status != "scheduled" {
            return Err(AppError::Conflict(format!(
                "Event {id} cannot be reminded (status={})",
                model.status
            )));
        }

        self.to_event_view(db, model).await
    }

    /// Marks an event as live, recording `started_at = now` and computing the
    /// `auto_stop_deadline = now + MAX_SESSION_DURATION` (3 hours).
    ///
    /// Idempotent guard: rejects if already live. Re-opening a stopped session
    /// is not supported — creates a new event instead.
    pub async fn start_event(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<EventView, AppError> {
        let model = event::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;

        if model.status == "live" {
            return Err(AppError::Conflict(format!("Event {id} is already live")));
        }

        let now: DateTime<Utc> = Utc::now();
        let deadline = now + MAX_SESSION_DURATION;

        let mut active: event::ActiveModel = model.into();
        active.status = Set("live".to_string());
        active.started_at = Set(Some(now.into()));
        active.stopped_at = Set(None);
        active.auto_stop_deadline = Set(Some(deadline.into()));
        active.link_status = Set("in_progress".to_string());
        active.link_attempts = Set(0);
        active.link_last_error = Set(None);
        active.link_battles_completed_at = Set(None);
        active.updated_at = Set(now.into());

        let updated = active.update(db).await.map_err(AppError::Database)?;
        self.to_event_view(db, updated).await
    }

    /// Marks an event session as stopped. `auto=true` selects the `auto_stopped`
    /// status (used by the background worker when the deadline is hit); manual
    /// stops use `stopped`.
    ///
    /// Idempotent: stopping an already-stopped event is a no-op.
    pub async fn stop_event(
        &self,
        db: &DatabaseConnection,
        id: i64,
        auto: bool,
    ) -> Result<EventView, AppError> {
        let model = event::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;

        // Idempotent: already stopped.
        if model.status == "stopped" || model.status == "auto_stopped" {
            return self.to_event_view(db, model).await;
        }
        if model.status != "live" {
            return Err(AppError::Conflict(format!(
                "Event {id} is not live (status={})",
                model.status
            )));
        }

        let now: DateTime<Utc> = Utc::now();
        let new_status = if auto { "auto_stopped" } else { "stopped" };

        let mut active: event::ActiveModel = model.into();
        active.status = Set(new_status.to_string());
        active.stopped_at = Set(Some(now.into()));
        active.updated_at = Set(now.into());

        let updated = active.update(db).await.map_err(AppError::Database)?;

        let roster = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        for participant in roster {
            try_award_event_xp(
                db,
                participant.user_id,
                id,
                crate::modules::progression::status::XpSource::EventComplete,
                format!("event_complete:{id}:{}", participant.user_id),
            )
            .await;
        }

        self.to_event_view(db, updated).await
    }

    // --- Battle linker -----------------------------------------------------

    /// Links every AlbionBB battle for the guild that falls in the event's time window.
    ///
    /// The worker calls this repeatedly because AlbionBB can lag up to ~30m. The
    /// listing is paginated, and no player-count heuristic is applied: the number
    /// of sign-ups is not a reliable indication of the actual fight size.
    pub async fn link_battles_for_event(
        db: &DatabaseConnection,
        albionbb: &AlbionBbService,
        context: &BattleLinkingContext,
        event_id: i64,
    ) -> Result<usize, AppError> {
        let model = event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;

        let started_at = model.started_at.ok_or_else(|| {
            AppError::Validation(format!("Event {event_id} has not been started"))
        })?;
        let started_at_utc = started_at.with_timezone(&Utc);
        let window_end = model
            .stopped_at
            .map(|t| t.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);

        // AlbionBB returns a raw array without pagination metadata. Walk pages until
        // an empty page (or a page with no new IDs) is returned, with a safety cap
        // so an upstream pagination regression cannot spin the worker forever.
        const MAX_BATTLE_PAGES: u64 = 100;
        let mut battles = Vec::new();
        let mut seen_battle_ids = HashSet::new();
        for page in 1..=MAX_BATTLE_PAGES {
            let filters = AlbionBbBattlesFilters {
                guild_id: Some(context.guild_id().to_string()),
                page: Some(page),
                ..Default::default()
            };
            let (page_battles, _) = albionbb.get_battles(context.server(), &filters).await?;
            if page_battles.is_empty() {
                break;
            }
            let mut added_on_page = 0;
            for battle in page_battles {
                if seen_battle_ids.insert(battle.id) {
                    battles.push(battle);
                    added_on_page += 1;
                }
            }
            if added_on_page == 0 {
                break;
            }
        }
        let next_link_attempts = model.link_attempts + 1;

        let mut active: event::ActiveModel = model.into();
        active.link_attempts = Set(next_link_attempts);
        active.link_status = Set("in_progress".to_string());
        active.link_last_error = Set(None);
        active.updated_at = Set(Utc::now().into());
        let _ = active.update(db).await;

        let mut inserted = 0usize;
        for battle in battles {
            let started = match chrono::DateTime::parse_from_rfc3339(&battle.start_time) {
                Ok(dt) => dt.with_timezone(&Utc),
                Err(_) => continue,
            };
            if started < started_at_utc || started > window_end {
                continue;
            }

            let snapshot = linked_battle_snapshot(&battle, context);

            let existing = event_battle::Entity::find()
                .filter(event_battle::Column::EventId.eq(event_id))
                .filter(event_battle::Column::AlbionbbBattleId.eq(battle.id.to_string()))
                .one(db)
                .await
                .map_err(AppError::Database)?;

            if let Some(existing) = existing {
                let mut row: event_battle::ActiveModel = existing.into();
                apply_battle_snapshot(&mut row, &snapshot)?;
                row.fetched_at = Set(Utc::now().into());
                row.update(db).await.map_err(AppError::Database)?;
                continue;
            }

            let mut row = event_battle::ActiveModel {
                event_id: Set(event_id),
                albionbb_battle_id: Set(battle.id.to_string()),
                battle_started_at: Set(started.into()),
                fetched_at: Set(Utc::now().into()),
                ..Default::default()
            };
            apply_battle_snapshot(&mut row, &snapshot)?;
            row.insert(db).await.map_err(AppError::Database)?;
            inserted += 1;
        }

        Ok(inserted)
    }

    /// Replaces the manually linked battle set for an event.
    ///
    /// Officers can attach zero or more AlbionBB battles after reviewing what actually happened
    /// during the event. The method fetches each requested battle before changing the database so a
    /// temporary upstream failure does not wipe existing analytics.
    ///
    /// # Example
    /// ```rust,no_run
    /// # use backend::modules::events::models::UpdateEventBattlesRequest;
    /// # use backend::modules::events::service::EventService;
    /// # async fn example(
    /// #     db: &sea_orm::DatabaseConnection,
    /// #     albionbb: &backend::modules::albionbb::service::AlbionBbService,
    /// # ) -> Result<(), backend::errors::AppError> {
    /// let service = EventService::new();
    /// let request = UpdateEventBattlesRequest { battle_ids: vec!["123456789".to_string()] };
    /// let context = backend::modules::events::service::BattleLinkingContext::new(
    ///     "guild-id",
    ///     &[],
    ///     &["BetterGetBack".to_string()],
    /// );
    /// let detail = service
    ///     .replace_event_battles(db, albionbb, &context, Some("eu"), 1, request)
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    /// Returns validation errors for malformed IDs or battles that do not include the configured
    /// guild, not-found when the event/battle is missing, and upstream errors from AlbionBB.
    pub async fn replace_event_battles(
        &self,
        db: &DatabaseConnection,
        albionbb: &AlbionBbService,
        context: &BattleLinkingContext,
        server: Option<&str>,
        event_id: i64,
        req: UpdateEventBattlesRequest,
    ) -> Result<EventDetailView, AppError> {
        let event_exists = event::Entity::find_by_id(event_id)
            .count(db)
            .await
            .map_err(AppError::Database)?
            > 0;
        if !event_exists {
            return Err(AppError::NotFound(format!("Event {event_id} not found")));
        }

        let battle_ids = normalize_battle_ids(&req.battle_ids)?;
        let mut snapshots = Vec::with_capacity(battle_ids.len());
        for battle_id in &battle_ids {
            let parsed_battle_id = battle_id.parse::<i64>().map_err(|error| {
                AppError::Validation(format!("Invalid AlbionBB battle id '{battle_id}': {error}"))
            })?;
            let battle = albionbb.get_battle(server, parsed_battle_id).await?.summary;
            let snapshot = linked_battle_snapshot(&battle, context);
            if snapshot.guild_players_count == 0 {
                return Err(AppError::Validation(format!(
                    "Battle {battle_id} does not include the configured guild"
                )));
            }
            let started = chrono::DateTime::parse_from_rfc3339(&battle.start_time)
                .map_err(|error| {
                    AppError::UpstreamService(format!(
                        "AlbionBB battle {battle_id} has an invalid start time: {error}"
                    ))
                })?
                .with_timezone(&Utc);
            snapshots.push((battle.id.to_string(), started, snapshot));
        }

        event_battle::Entity::delete_many()
            .filter(event_battle::Column::EventId.eq(event_id))
            .exec(db)
            .await
            .map_err(AppError::Database)?;

        for (battle_id, started, snapshot) in snapshots {
            let mut row = event_battle::ActiveModel {
                event_id: Set(event_id),
                albionbb_battle_id: Set(battle_id),
                battle_started_at: Set(started.into()),
                fetched_at: Set(Utc::now().into()),
                ..Default::default()
            };
            apply_battle_snapshot(&mut row, &snapshot)?;
            row.insert(db).await.map_err(AppError::Database)?;
        }

        Self::finalize_link(db, event_id, false).await?;
        self.get_event_detail_with_context(db, event_id, context)
            .await
    }

    /// Returns `true` when the linker should stop polling AlbionBB for this
    /// event. Policy: stopped sessions stop after `LINK_GRACE_PERIOD` past
    /// `stopped_at`; live sessions never auto-complete the linker (the worker
    /// keeps polling as long as the session is live).
    pub fn linker_is_done(model: &event::Model) -> bool {
        match model.status.as_str() {
            "stopped" | "auto_stopped" => {
                let stopped_at = match model.stopped_at {
                    Some(t) => t,
                    None => return true,
                };
                let elapsed = Utc::now().signed_duration_since(stopped_at.with_timezone(&Utc));
                elapsed > LINK_GRACE_PERIOD
            }
            "completed" | "failed" => true,
            _ => false,
        }
    }

    /// Marks the linker as completed (or failed) on the event row.
    pub async fn finalize_link(
        db: &DatabaseConnection,
        event_id: i64,
        failed: bool,
    ) -> Result<(), AppError> {
        let model = event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        let mut active: event::ActiveModel = model.into();
        active.link_status = Set(if failed { "failed" } else { "completed" }.to_string());
        active.link_battles_completed_at = Set(Some(Utc::now().into()));
        active.update(db).await.map_err(AppError::Database)?;
        Ok(())
    }

    /// Registers a user for an event or updates their builds.
    pub async fn participate(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        user_id: i64,
        req: ParticipateEventRequest,
    ) -> Result<EventDetailView, AppError> {
        self.apply_participation(
            db,
            event_id,
            user_id,
            req.primary_build_id,
            req.secondary_build_id,
        )
        .await
    }

    /// Officer/creator endpoint payload: same shape as `ParticipateEventRequest`
    /// but the target user is supplied by the route rather than the session.
    pub async fn set_participant(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        target_user_id: i64,
        req: super::models::SetParticipantRequest,
    ) -> Result<EventDetailView, AppError> {
        // Make sure the target user exists so we fail fast with a 404 instead
        // of leaving an orphan participation row behind.
        let user_exists = crate::modules::users::entities::Entity::find_by_id(target_user_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("User {target_user_id} not found")))?;
        let _ = user_exists;

        self.apply_participation(
            db,
            event_id,
            target_user_id,
            req.primary_build_id,
            req.secondary_build_id,
        )
        .await
    }

    /// Inserts (or updates) a single participation row after validating event,
    /// build existence, comp membership and slot availability.
    ///
    /// Shared by both the self-service `participate` and the officer-driven
    /// `set_participant` so the rules never drift between the two paths.
    async fn apply_participation(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        user_id: i64,
        primary_build_id: i64,
        secondary_build_id: Option<i64>,
    ) -> Result<EventDetailView, AppError> {
        // Validate event exists
        let event_model = event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;

        // Validate builds exist in DB
        let primary_exists = build::Entity::find_by_id(primary_build_id)
            .count(db)
            .await
            .map_err(AppError::Database)?
            > 0;
        if !primary_exists {
            return Err(AppError::NotFound(format!(
                "Primary build {primary_build_id} not found"
            )));
        }

        if let Some(sec_id) = secondary_build_id {
            let secondary_exists = build::Entity::find_by_id(sec_id)
                .count(db)
                .await
                .map_err(AppError::Database)?
                > 0;
            if !secondary_exists {
                return Err(AppError::NotFound(format!(
                    "Secondary build {sec_id} not found"
                )));
            }
        }

        // Fetch current participations
        let current_participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(event_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;

        let existing = current_participations.iter().find(|p| p.user_id == user_id);
        let is_new = existing.is_none();

        // Calculate target size
        let target_size = if existing.is_some() {
            current_participations.len()
        } else {
            current_participations.len() + 1
        };

        // Resolve the active comp
        let (active_comp, _) = self
            .resolve_active_comp(db, event_model.comp_id, target_size)
            .await?;

        // Fetch comp builds for active comp to validate build selections
        let active_comp_builds = comp_build::Entity::find()
            .filter(comp_build::Column::CompId.eq(active_comp.id))
            .all(db)
            .await
            .map_err(AppError::Database)?;

        // Verify primary build exists in active comp
        let primary_cb = active_comp_builds
            .iter()
            .find(|cb| cb.build_id == primary_build_id)
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "Primary build {primary_build_id} is not allowed in comp {}",
                    active_comp.name
                ))
            })?;

        // Verify secondary build exists in active comp (if provided)
        if let Some(sec_id) = secondary_build_id {
            let exists = active_comp_builds.iter().any(|cb| cb.build_id == sec_id);
            if !exists {
                return Err(AppError::Validation(format!(
                    "Secondary build {sec_id} is not allowed in comp {}",
                    active_comp.name
                )));
            }
        }

        // Verify primary build slot availability
        let taken_count = current_participations
            .iter()
            .filter(|p| p.user_id != user_id && p.primary_build_id == primary_build_id)
            .count();

        if taken_count >= primary_cb.quantity as usize {
            return Err(AppError::Validation(format!(
                "The primary role for build '{}' is already full (comp limit: {})",
                primary_build_id, primary_cb.quantity
            )));
        }

        // Save or update
        if let Some(p) = existing {
            let mut active: event_participation::ActiveModel = p.clone().into();
            active.primary_build_id = Set(primary_build_id);
            active.secondary_build_id = Set(secondary_build_id);
            active.updated_at = Set(chrono::Utc::now().into());
            active.update(db).await.map_err(AppError::Database)?;
        } else {
            let active = event_participation::ActiveModel {
                event_id: Set(event_id),
                user_id: Set(user_id),
                primary_build_id: Set(primary_build_id),
                secondary_build_id: Set(secondary_build_id),
                ..Default::default()
            };
            active.insert(db).await.map_err(AppError::Database)?;
        }

        if is_new {
            try_award_event_xp(
                db,
                user_id,
                event_id,
                crate::modules::progression::status::XpSource::EventJoin,
                format!("event_join:{event_id}:{user_id}"),
            )
            .await;
        }

        self.get_event_detail(db, event_id).await
    }

    /// Cancels user participation.
    pub async fn cancel_participation(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        user_id: i64,
    ) -> Result<EventDetailView, AppError> {
        let deleted = event_participation::Entity::delete_many()
            .filter(event_participation::Column::EventId.eq(event_id))
            .filter(event_participation::Column::UserId.eq(user_id))
            .exec(db)
            .await
            .map_err(AppError::Database)?;

        if deleted.rows_affected == 0 {
            return Err(AppError::NotFound(format!(
                "User {user_id} is not registered for event {event_id}"
            )));
        }

        self.get_event_detail(db, event_id).await
    }
}

impl Default for EventService {
    fn default() -> Self {
        Self::new()
    }
}

/// Best-effort XP grant. Failures are logged and never fail the event mutation.
async fn try_award_event_xp(
    db: &DatabaseConnection,
    user_id: i64,
    event_id: i64,
    source: crate::modules::progression::status::XpSource,
    idempotency_key: String,
) {
    let spec = crate::modules::progression::models::AwardSpec {
        user_id,
        source,
        base_amount: None,
        idempotency_key,
        actor_user_id: None,
    };
    if let Err(error) = crate::modules::progression::service::ProgressionService::new()
        .award(db, spec)
        .await
    {
        tracing::warn!(
            event_id,
            user_id,
            source = source.as_str(),
            error = %error,
            "failed to award event XP"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::comps::entities::{
        build::ActiveModel as BuildActiveModel,
        build_category::ActiveModel as BuildCategoryActiveModel,
        comp::ActiveModel as CompActiveModel, comp_build::ActiveModel as CompBuildActiveModel,
        comp_category::ActiveModel as CompCategoryActiveModel,
    };
    use crate::modules::users::entities::ActiveModel as UserActiveModel;
    use sea_orm::{ActiveValue::Set, Database};

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("Failed to connect to test database");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("Failed to run database migrations");
        db
    }

    async fn insert_user(db: &DatabaseConnection, username: &str, email: &str) -> i64 {
        let user = UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        };
        user.insert(db).await.expect("Failed to insert user").id
    }

    async fn create_build_category(db: &DatabaseConnection, name: &str) -> i64 {
        let cat = BuildCategoryActiveModel {
            name: Set(name.to_string()),
            slug: Set(name.to_lowercase()),
            ..Default::default()
        };
        cat.insert(db)
            .await
            .expect("Failed to insert build category")
            .id
    }

    async fn create_build(db: &DatabaseConnection, name: &str, category_id: i64) -> i64 {
        let build = BuildActiveModel {
            name: Set(name.to_string()),
            role: Set("Dps".to_string()),
            category_id: Set(category_id),
            created_by: Set(1),
            ..Default::default()
        };
        build.insert(db).await.expect("Failed to insert build").id
    }

    async fn create_comp_category(db: &DatabaseConnection, name: &str) -> i64 {
        let cat = CompCategoryActiveModel {
            name: Set(name.to_string()),
            slug: Set(name.to_lowercase()),
            ..Default::default()
        };
        cat.insert(db)
            .await
            .expect("Failed to insert comp category")
            .id
    }

    async fn create_comp(
        db: &DatabaseConnection,
        name: &str,
        category_id: i64,
        parent_id: Option<i64>,
        builds: Vec<(i64, i32)>,
    ) -> i64 {
        let comp = CompActiveModel {
            name: Set(name.to_string()),
            category_id: Set(category_id),
            parent_id: Set(parent_id),
            created_by: Set(1),
            ..Default::default()
        };
        let comp_id = comp.insert(db).await.expect("Failed to insert comp").id;

        for (build_id, qty) in builds {
            let cb = CompBuildActiveModel {
                comp_id: Set(comp_id),
                build_id: Set(build_id),
                quantity: Set(qty),
                ..Default::default()
            };
            cb.insert(db).await.expect("Failed to insert comp build");
        }

        comp_id
    }

    #[tokio::test]
    async fn test_create_event_success() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let cat = create_comp_category(&db, "ZvZ").await;
        let comp_id = create_comp(&db, "Main Comp", cat, None, vec![]).await;

        let service = EventService::new();
        let event = service
            .create_event(
                &db,
                admin,
                CreateEventRequest {
                    title: "ZvZ Castle Fight".to_string(),
                    description: Some("Fight for control".to_string()),
                    call_to_arms: false,
                    regear: false,
                    comp_id,
                    event_date_utc: "2026-07-20T20:00:00Z".to_string(),
                    discord_role_ids: vec![
                        "111111111111111111".to_string(),
                        "222222222222222222".to_string(),
                        "333333333333333333".to_string(),
                    ],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(event.title, "ZvZ Castle Fight");
        assert_eq!(event.comp_id, comp_id);
        assert_eq!(
            event.discord_role_ids,
            vec![
                "111111111111111111".to_string(),
                "222222222222222222".to_string(),
                "333333333333333333".to_string(),
            ]
        );
    }

    #[test]
    fn normalize_discord_role_ids_deduplicates_and_rejects_invalid_ids() {
        assert_eq!(
            normalize_discord_role_ids(vec![
                " 111111111111111111 ".to_string(),
                "111111111111111111".to_string(),
                "222222222222222222".to_string(),
            ])
            .unwrap(),
            vec![
                "111111111111111111".to_string(),
                "222222222222222222".to_string(),
            ]
        );
        assert!(normalize_discord_role_ids(vec!["not-a-role".to_string()]).is_err());
        assert!(normalize_discord_role_ids(vec!["123".to_string()]).is_err());
    }

    #[tokio::test]
    async fn prepare_reminder_only_accepts_scheduled_events() {
        let db = seed_db().await;
        let admin = insert_user(&db, "reminder-admin", "reminder-admin@example.com").await;
        let cat = create_comp_category(&db, "Reminder ZvZ").await;
        let comp_id = create_comp(&db, "Reminder Comp", cat, None, vec![]).await;
        let service = EventService::new();
        let event = service
            .create_event(
                &db,
                admin,
                CreateEventRequest {
                    title: "Reminder Event".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    comp_id,
                    event_date_utc: "2026-09-01T20:00:00Z".to_string(),
                    discord_role_ids: vec!["111111111111111111".to_string()],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();

        let reminder = service.prepare_event_reminder(&db, event.id).await.unwrap();
        assert_eq!(reminder.id, event.id);
        assert_eq!(reminder.discord_role_ids, event.discord_role_ids);

        service.start_event(&db, event.id).await.unwrap();
        let error = service
            .prepare_event_reminder(&db, event.id)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::Conflict(_)));
    }

    #[tokio::test]
    async fn create_event_with_split_requires_island_tab() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let cat = create_comp_category(&db, "ZvZ").await;
        let comp_id = create_comp(&db, "Main Comp", cat, None, vec![]).await;
        let err = EventService::new()
            .create_event(
                &db,
                admin,
                CreateEventRequest {
                    title: "ZvZ Castle Fight".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    comp_id,
                    event_date_utc: "2026-07-20T20:00:00Z".to_string(),
                    discord_role_ids: vec![],
                    create_split: true,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn linked_split_stores_island_tab_id() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let cat = create_comp_category(&db, "ZvZ").await;
        let comp_id = create_comp(&db, "Main Comp", cat, None, vec![]).await;
        let island = crate::modules::splits::service::SplitService::new()
            .create_island(
                &db,
                crate::modules::splits::models::CreateIslandRequest {
                    name: "x".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec!["Loot".to_string()],
                },
            )
            .await
            .unwrap();
        let tab_id = island.tabs[0].id;
        let event = EventService::new()
            .create_event(
                &db,
                admin,
                CreateEventRequest {
                    title: "ZvZ Castle Fight".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    comp_id,
                    event_date_utc: "2026-07-20T20:00:00Z".to_string(),
                    discord_role_ids: vec![],
                    create_split: true,
                    island_tab_id: Some(tab_id),
                },
            )
            .await
            .unwrap();
        let splits = crate::modules::splits::service::SplitService::new()
            .list_splits(
                &db,
                &crate::pagination::PaginationParams {
                    page: None,
                    limit: Some(10),
                },
                &crate::modules::splits::models::SplitFilters {
                    status: None,
                    event_id: Some(event.id),
                    island_id: None,
                    search: None,
                    date_from: None,
                    date_to: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(splits.items.len(), 1);
        assert_eq!(splits.items[0].island_tab_id, Some(tab_id));
    }

    #[tokio::test]
    async fn test_event_participation_and_autoscaling() {
        let db = seed_db().await;
        let creator = insert_user(&db, "admin", "admin@example.com").await;
        let player1 = insert_user(&db, "player1", "p1@example.com").await;
        let player2 = insert_user(&db, "player2", "p2@example.com").await;

        let build_cat = create_build_category(&db, "Weapons").await;
        let b1 = create_build(&db, "Tank", build_cat).await;
        let b2 = create_build(&db, "Healer", build_cat).await;

        let cat = create_comp_category(&db, "ZvZ").await;

        // Base comp capacity = 1 (1 slot for Tank)
        let base_comp = create_comp(&db, "Base Comp 1", cat, None, vec![(b1, 1)]).await;
        // Variant comp capacity = 2 (1 slot for Tank, 1 slot for Healer)
        let variant_comp = create_comp(
            &db,
            "Variant Comp 2",
            cat,
            Some(base_comp),
            vec![(b1, 1), (b2, 1)],
        )
        .await;

        let service = EventService::new();
        let event = service
            .create_event(
                &db,
                creator,
                CreateEventRequest {
                    title: "Scaling Event".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    comp_id: base_comp,
                    event_date_utc: "2026-07-20T20:00:00Z".to_string(),
                    discord_role_ids: vec![],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();

        // 1st participant signs up as Tank. Matches base comp.
        let detail = service
            .participate(
                &db,
                event.id,
                player1,
                ParticipateEventRequest {
                    primary_build_id: b1,
                    secondary_build_id: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(detail.active_comp_id, base_comp);
        assert_eq!(detail.active_comp_capacity, 1);
        assert_eq!(detail.participants.len(), 1);

        // 2nd participant signs up as Healer. Since total participants = 2,
        // it exceeds base comp capacity (1) and should scale up to variant comp (capacity 2).
        let detail = service
            .participate(
                &db,
                event.id,
                player2,
                ParticipateEventRequest {
                    primary_build_id: b2,
                    secondary_build_id: Some(b1),
                },
            )
            .await
            .unwrap();

        assert_eq!(detail.active_comp_id, variant_comp);
        assert_eq!(detail.active_comp_capacity, 2);
        assert_eq!(detail.participants.len(), 2);

        // 3rd sign up should fail because the maximum capacity of all variants (2) is exceeded.
        let player3 = insert_user(&db, "player3", "p3@example.com").await;
        let fail_result = service
            .participate(
                &db,
                event.id,
                player3,
                ParticipateEventRequest {
                    primary_build_id: b1,
                    secondary_build_id: None,
                },
            )
            .await;

        assert!(fail_result.is_err());
    }

    #[tokio::test]
    async fn test_exclusive_roles_and_secondary_roles() {
        let db = seed_db().await;
        let creator = insert_user(&db, "admin", "admin@example.com").await;
        let player1 = insert_user(&db, "player1", "p1@example.com").await;
        let player2 = insert_user(&db, "player2", "p2@example.com").await;

        let build_cat = create_build_category(&db, "Weapons").await;
        let b1 = create_build(&db, "Tank", build_cat).await;
        let b2 = create_build(&db, "Healer", build_cat).await;

        let cat = create_comp_category(&db, "ZvZ").await;
        // Comp with 1 Tank slot and 1 Healer slot (capacity = 2)
        let comp_id = create_comp(&db, "Comp", cat, None, vec![(b1, 1), (b2, 1)]).await;

        let service = EventService::new();
        let event = service
            .create_event(
                &db,
                creator,
                CreateEventRequest {
                    title: "Roles Event".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    comp_id,
                    event_date_utc: "2026-07-20T20:00:00Z".to_string(),
                    discord_role_ids: vec![],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();

        // Player 1 signs up as Tank
        service
            .participate(
                &db,
                event.id,
                player1,
                ParticipateEventRequest {
                    primary_build_id: b1,
                    secondary_build_id: None,
                },
            )
            .await
            .unwrap();

        // Player 2 tries to sign up as Tank too. Since the comp only allows 1 Tank slot,
        // it must fail (role capacity exceeded).
        let fail_result = service
            .participate(
                &db,
                event.id,
                player2,
                ParticipateEventRequest {
                    primary_build_id: b1,
                    secondary_build_id: None,
                },
            )
            .await;

        assert!(fail_result.is_err());

        // Player 2 signs up as Healer (primary) and Tank (secondary).
        // Since secondary slots are NOT limited / checked, this should succeed.
        let success_detail = service
            .participate(
                &db,
                event.id,
                player2,
                ParticipateEventRequest {
                    primary_build_id: b2,
                    secondary_build_id: Some(b1),
                },
            )
            .await
            .unwrap();

        assert_eq!(success_detail.participants.len(), 2);
    }

    async fn insert_covering_season(db: &DatabaseConnection) {
        use crate::modules::progression::entities::ProgressionSeasonActiveModel;
        let now = Utc::now();
        ProgressionSeasonActiveModel {
            name: Set("s25".into()),
            starts_at: Set((now - ChronoDuration::days(1)).into()),
            ends_at: Set((now + ChronoDuration::days(30)).into()),
            is_active: Set(true),
            updated_at: Set(now.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("season");
    }

    async fn ledger_keys(db: &DatabaseConnection, source: &str) -> Vec<String> {
        use crate::modules::progression::entities::{
            ProgressionXpLedgerColumn, ProgressionXpLedgerEntity,
        };
        ProgressionXpLedgerEntity::find()
            .filter(ProgressionXpLedgerColumn::Source.eq(source))
            .all(db)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.idempotency_key)
            .collect()
    }

    #[tokio::test]
    async fn event_join_xp_is_idempotent_on_resign() {
        let db = seed_db().await;
        insert_covering_season(&db).await;
        let creator = insert_user(&db, "admin", "admin@example.com").await;
        let player = insert_user(&db, "player1", "p1@example.com").await;
        let build_cat = create_build_category(&db, "Weapons").await;
        let b1 = create_build(&db, "Tank", build_cat).await;
        let cat = create_comp_category(&db, "ZvZ").await;
        let comp_id = create_comp(&db, "Comp", cat, None, vec![(b1, 2)]).await;
        let service = EventService::new();
        let event = service
            .create_event(
                &db,
                creator,
                CreateEventRequest {
                    title: "XP Event".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    comp_id,
                    event_date_utc: "2026-07-20T20:00:00Z".to_string(),
                    discord_role_ids: vec![],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();

        let req = ParticipateEventRequest {
            primary_build_id: b1,
            secondary_build_id: None,
        };
        service
            .participate(&db, event.id, player, req.clone())
            .await
            .unwrap();
        service
            .participate(&db, event.id, player, req)
            .await
            .unwrap();

        let joins = ledger_keys(&db, "event_join").await;
        assert_eq!(joins, vec![format!("event_join:{}:{player}", event.id)]);
        let creates = ledger_keys(&db, "event_create").await;
        assert_eq!(creates, vec![format!("event_create:{}", event.id)]);
    }

    #[tokio::test]
    async fn event_complete_xp_awarded_on_stop() {
        let db = seed_db().await;
        insert_covering_season(&db).await;
        let creator = insert_user(&db, "admin", "admin@example.com").await;
        let player = insert_user(&db, "player1", "p1@example.com").await;
        let build_cat = create_build_category(&db, "Weapons").await;
        let b1 = create_build(&db, "Tank", build_cat).await;
        let cat = create_comp_category(&db, "ZvZ").await;
        let comp_id = create_comp(&db, "Comp", cat, None, vec![(b1, 2)]).await;
        let service = EventService::new();
        let event = service
            .create_event(
                &db,
                creator,
                CreateEventRequest {
                    title: "Stop XP".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    comp_id,
                    event_date_utc: "2026-07-20T20:00:00Z".to_string(),
                    discord_role_ids: vec![],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();
        service
            .participate(
                &db,
                event.id,
                player,
                ParticipateEventRequest {
                    primary_build_id: b1,
                    secondary_build_id: None,
                },
            )
            .await
            .unwrap();
        service.start_event(&db, event.id).await.unwrap();
        service.stop_event(&db, event.id, false).await.unwrap();
        service.stop_event(&db, event.id, false).await.unwrap();

        let completes = ledger_keys(&db, "event_complete").await;
        assert_eq!(
            completes,
            vec![format!("event_complete:{}:{player}", event.id)]
        );
    }

    #[tokio::test]
    async fn list_events_filters_by_status_and_sorts_by_title() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let cat = create_comp_category(&db, "ZvZ").await;
        let comp_id = create_comp(&db, "Main Comp", cat, None, vec![]).await;
        let service = EventService::new();

        let zebra = service
            .create_event(
                &db,
                admin,
                CreateEventRequest {
                    title: "Zebra".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    comp_id,
                    event_date_utc: "2026-07-21T20:00:00Z".to_string(),
                    discord_role_ids: vec![],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();
        let alpha = service
            .create_event(
                &db,
                admin,
                CreateEventRequest {
                    title: "Alpha".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    comp_id,
                    event_date_utc: "2026-07-22T20:00:00Z".to_string(),
                    discord_role_ids: vec![],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();
        service.start_event(&db, zebra.id).await.unwrap();

        let live = service
            .list_events(
                &db,
                PaginationParams {
                    page: None,
                    limit: None,
                },
                super::super::models::EventFilters {
                    status: Some("live".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(live.items.len(), 1);
        assert_eq!(live.items[0].id, zebra.id);

        let sorted = service
            .list_events(
                &db,
                PaginationParams {
                    page: None,
                    limit: None,
                },
                super::super::models::EventFilters {
                    sort: Some("title".to_string()),
                    order: Some("asc".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let titles: Vec<_> = sorted
            .items
            .iter()
            .map(|event| event.title.as_str())
            .collect();
        assert_eq!(titles, vec!["Alpha", "Zebra"]);
        assert_eq!(sorted.items[0].id, alpha.id);
    }

    #[tokio::test]
    async fn list_events_rejects_unknown_sort_column() {
        let db = seed_db().await;
        let error = EventService::new()
            .list_events(
                &db,
                PaginationParams {
                    page: None,
                    limit: None,
                },
                super::super::models::EventFilters {
                    sort: Some("fame".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        match error {
            AppError::Validation(message) => assert!(message.contains("fame")),
            other => panic!("expected validation, got {other:?}"),
        }
    }
}

/// Creates an empty loot split already attached to an event.
///
/// Values start at zero and the roster starts empty: the split exists so the
/// link is in place, and the officer fills in the haul once the fight is over.
/// Participants are seeded from the event's sign-ups the first time the split
/// is updated, which is later than creation time and therefore more accurate.
async fn create_linked_split(
    db: &DatabaseConnection,
    creator_id: i64,
    event_id: i64,
    event_title: &str,
    island_tab_id: i64,
) -> Result<(), AppError> {
    use crate::modules::splits::entities::split;
    use crate::modules::splits::status::SplitStatus;
    use sea_orm::prelude::Decimal;

    split::ActiveModel {
        created_by: Set(creator_id),
        status: Set(SplitStatus::Pending.to_string()),
        estimated_market_value: Set(Decimal::ZERO),
        repair_value: Set(Decimal::ZERO),
        bags_value: Set(Decimal::ZERO),
        note: Set(Some(format!("Auto-created for event: {event_title}"))),
        event_id: Set(Some(event_id)),
        island_tab_id: Set(Some(island_tab_id)),
        ..Default::default()
    }
    .insert(db)
    .await
    .map_err(AppError::Database)?;
    Ok(())
}
