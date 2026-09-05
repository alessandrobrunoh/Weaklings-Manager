//! Business logic for the events module.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::str::FromStr;

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait,
};

use chrono::{DateTime, Duration as ChronoDuration, Utc};

use super::entities::{
    event, event_battle, event_discord_role, event_participation, event_roster_assignment,
    event_roster_role, fight, fight_battle,
};
use super::models::{
    AddEventMemberRequest, AssignRosterSeatRequest, BattlePerformanceStats, BuildBattleStats,
    BuildPerformanceView, CompPerformanceView, CreateEventRequest, CreateEventRosterRoleRequest,
    EventBattleView, EventCompBuildView, EventDetailView, EventFightView, EventParticipantView,
    EventRosterRoleView, EventRosterSeatView, EventRosterView, EventSignupBuildView,
    EventSignupOptionsView, EventSplitStats, EventView, OpponentPerformanceView,
    ParticipateEventRequest, RosterVersionRequest, SwapRosterSeatsRequest,
    UpdateEventBattlesRequest, UpdateEventRequest,
};

use super::fight_grouping::{
    FIGHT_GROUPING_VERSION, FightEvidence, FightGroupingDecision, score_fight_grouping,
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
use crate::modules::battles::models::{
    BattleGuildSummary, BattleLossEstimate, BattlePlayer, GuildLossEstimate, PlayerLossEstimate,
};
use crate::modules::combat::fit::{self, FitStrategy};
use crate::modules::comps::entities::{build, comp, comp_build};
use crate::modules::comps::status::{BuildLoadout, BuildRole};
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

/// Returns the roster size at which an expansion becomes visible.
///
/// The existing roster model treats a participant as a concrete slot reservation. Using integer
/// division deliberately floors the percentage: a ten-slot comp expands at `7/10`, matching the
/// product rule and avoiding a surprising extra signup at `8/10`.
fn expansion_threshold(capacity: i64) -> i64 {
    (capacity.max(1).saturating_mul(3) / 4).max(1)
}

/// Parses `build:{id}:{slot}` into the assigned build identifier.
fn assigned_build_id_from_seat_key(seat_key: &str) -> Option<i64> {
    let mut parts = seat_key.split(':');
    (parts.next() == Some("build"))
        .then(|| parts.next()?.parse::<i64>().ok())
        .flatten()
}

/// Maps each assigned member to the build of the seat they occupy.
fn assigned_builds_by_user(
    assignments: impl IntoIterator<Item = event_roster_assignment::Model>,
) -> HashMap<i64, i64> {
    assignments
        .into_iter()
        .filter_map(|assignment| {
            assigned_build_id_from_seat_key(&assignment.seat_key)
                .map(|build_id| (assignment.user_id, build_id))
        })
        .collect()
}

async fn resolve_assigned_build_name<C: ConnectionTrait>(
    db: &C,
    assigned_build_id: Option<i64>,
    primary_build_id: Option<i64>,
    primary_build_name: &str,
) -> Result<Option<String>, AppError> {
    let Some(assigned_build_id) = assigned_build_id else {
        return Ok(None);
    };
    if Some(assigned_build_id) == primary_build_id {
        return Ok(Some(primary_build_name.to_string()));
    }
    let name = build::Entity::find_by_id(assigned_build_id)
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Build {assigned_build_id} not found")))?
        .name;
    Ok(Some(name))
}

/// The pre-existing `auto_fill_roster` behaviour: first matching seat in signup order.
///
/// A participant takes the first available seat for their primary build, or their secondary if no
/// primary seat is free; a participant matching neither is left for the officer to place by hand.
/// `available` is mutated in place so a later participant cannot double-book a seat this pass just
/// gave away.
fn greedy_placements(
    unassigned: &[event_participation::Model],
    available: &mut Vec<EventRosterSeatView>,
) -> Vec<(i64, String)> {
    let mut placements = Vec::new();
    for participant in unassigned {
        let index = available
            .iter()
            .position(|seat| Some(seat.build_id) == participant.primary_build_id)
            .or_else(|| {
                available
                    .iter()
                    .position(|seat| Some(seat.build_id) == participant.secondary_build_id)
            });
        if let Some(index) = index {
            let seat = available.remove(index);
            placements.push((participant.user_id, seat.key));
        }
    }
    placements
}

/// Turns unassigned participants and open seats into the plain shapes [`fit::assign`] takes.
///
/// Generic over [`ConnectionTrait`] so it serves both the read-only preview (a plain connection)
/// and the write path (already inside a transaction) with one implementation.
async fn fit_inputs<C: sea_orm::ConnectionTrait>(
    db: &C,
    unassigned: &[event_participation::Model],
    available: &[EventRosterSeatView],
) -> Result<(Vec<fit::Member>, Vec<fit::Seat>), AppError> {
    let user_ids: Vec<i64> = unassigned.iter().map(|entry| entry.user_id).collect();
    let levels_by_user =
        crate::modules::users::specializations::load_levels_for_users(db, &user_ids).await?;
    let members: Vec<fit::Member> = unassigned
        .iter()
        .map(|entry| fit::Member {
            user_id: entry.user_id,
            specs: crate::modules::combat::ip::SpecLevels::from_rows(
                levels_by_user
                    .get(&entry.user_id)
                    .into_iter()
                    .flatten()
                    .map(|(key, level)| (key.as_str(), *level)),
            ),
            primary_build_id: entry.primary_build_id,
            secondary_build_id: entry.secondary_build_id,
        })
        .collect();

    // Every seat of the same build shares one loadout; a comp with, say, twenty Polehammer seats
    // should not cost twenty queries for the identical answer.
    let mut items_by_build: HashMap<i64, Vec<crate::modules::combat::ip::EquippedItem>> =
        HashMap::new();
    let mut seats = Vec::with_capacity(available.len());
    for seat in available {
        let items = if let Some(items) = items_by_build.get(&seat.build_id) {
            items.clone()
        } else {
            let items = crate::modules::combat::service::CombatService::build_loadout(
                db,
                seat.build_id,
                BuildLoadout::Main,
            )
            .await?;
            items_by_build.insert(seat.build_id, items.clone());
            items
        };
        seats.push(fit::Seat {
            seat_key: seat.key.clone(),
            build_id: seat.build_id,
            items,
        });
    }

    Ok((members, seats))
}

/// Returns the comp resolution target while retaining the event's explicit planning override.
fn comp_resolution_target(participant_count: usize, player_cap: Option<i64>) -> usize {
    let cap_reached = player_cap
        .and_then(|cap| usize::try_from(cap).ok())
        .is_some_and(|cap| participant_count >= cap);
    participant_count.saturating_add(usize::from(cap_reached))
}

fn parse_event_timestamp(value: &str, field: &str) -> Result<DateTime<Utc>, AppError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|error| AppError::Validation(format!("Invalid {field}: {error}")))
}

fn validate_event_times(mass: DateTime<Utc>, start: DateTime<Utc>) -> Result<(), AppError> {
    if mass > start {
        return Err(AppError::Validation(
            "mass_time_utc must be earlier than or equal to start_time_utc".to_string(),
        ));
    }
    Ok(())
}

fn reject_if_event_archived(model: &event::Model) -> Result<(), AppError> {
    if model.archived_at.is_some() {
        return Err(AppError::Conflict(format!(
            "Event {} is archived",
            model.id
        )));
    }
    Ok(())
}

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

async fn load_event_roster_roles(
    db: &DatabaseConnection,
    event_id: i64,
) -> Result<Vec<EventRosterRoleView>, AppError> {
    let extra_roles = event_roster_role::Entity::find()
        .filter(event_roster_role::Column::EventId.eq(event_id))
        .order_by_asc(event_roster_role::Column::Id)
        .all(db)
        .await
        .map_err(AppError::Database)?;

    let mut roles = Vec::with_capacity(extra_roles.len() + 1);
    roles.push(EventRosterRoleView {
        id: None,
        build_id: None,
        name: "Fill".to_string(),
        is_fill: true,
    });

    for role in extra_roles {
        let build = build::Entity::find_by_id(role.build_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Build {} not found", role.build_id)))?;
        roles.push(EventRosterRoleView {
            id: Some(role.id),
            build_id: Some(role.build_id),
            name: build.name,
            is_fill: false,
        });
    }

    Ok(roles)
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
        .find(|guild| context.is_friendly_guild(&guild.id, &guild.name));
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

/// Ensures the initial one-Battle-per-Fight mapping exists for an Event.
///
/// This is intentionally idempotent: historical data predates the `fights` tables,
/// while newly linked Battles can arrive after the migration has run. A raw Battle
/// may belong to only one Fight globally, so a conflicting Event association is
/// surfaced instead of being silently reassigned.
async fn ensure_seed_fights_for_event(
    db: &DatabaseConnection,
    event_id: i64,
    battle_rows: &[event_battle::Model],
) -> Result<(), AppError> {
    for battle in battle_rows {
        let battle_id = battle.albionbb_battle_id.parse::<i64>().map_err(|error| {
            AppError::Validation(format!(
                "Event {event_id} has an invalid AlbionBB battle id '{}': {error}",
                battle.albionbb_battle_id
            ))
        })?;

        if let Some(link) = fight_battle::Entity::find()
            .filter(fight_battle::Column::BattleId.eq(battle_id))
            .one(db)
            .await
            .map_err(AppError::Database)?
        {
            let existing_fight = fight::Entity::find_by_id(link.fight_id)
                .one(db)
                .await
                .map_err(AppError::Database)?
                .ok_or_else(|| {
                    AppError::Internal(format!(
                        "Fight segment {} references missing fight {}",
                        link.id, link.fight_id
                    ))
                })?;
            match existing_fight.event_id {
                Some(existing_event_id) if existing_event_id != event_id => {
                    return Err(AppError::Conflict(format!(
                        "Battle {battle_id} is already assigned to event {existing_event_id}"
                    )));
                }
                Some(_) => continue,
                None => {
                    let mut active: fight::ActiveModel = existing_fight.into();
                    active.event_id = Set(Some(event_id));
                    active.updated_at = Set(Utc::now().into());
                    active.update(db).await.map_err(AppError::Database)?;
                    continue;
                }
            }
        }

        let created = fight::ActiveModel {
            event_id: Set(Some(event_id)),
            started_at: Set(battle.battle_started_at),
            ended_at: Set(None),
            grouping_method: Set("seeded".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .map_err(AppError::Database)?;
        fight_battle::ActiveModel {
            fight_id: Set(created.id),
            battle_id: Set(battle_id),
            sequence_number: Set(1),
            ..Default::default()
        }
        .insert(db)
        .await
        .map_err(AppError::Database)?;
    }
    Ok(())
}

/// Returns whether the globally canonical Battle is linked to a different Event.
async fn battle_is_assigned_to_another_event(
    db: &DatabaseConnection,
    event_id: i64,
    battle_id: i64,
) -> Result<bool, AppError> {
    let Some(link) = fight_battle::Entity::find()
        .filter(fight_battle::Column::BattleId.eq(battle_id))
        .one(db)
        .await
        .map_err(AppError::Database)?
    else {
        return Ok(false);
    };
    let existing_fight = fight::Entity::find_by_id(link.fight_id)
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| {
            AppError::Internal(format!(
                "Fight segment {} references missing fight {}",
                link.id, link.fight_id
            ))
        })?;
    Ok(matches!(
        existing_fight.event_id,
        Some(existing_event_id) if existing_event_id != event_id
    ))
}

/// Conservatively merges adjacent seeded Battles from one Event when hydrated evidence proves
/// that they are segments of the same real engagement. Ambiguous candidates remain separate and
/// are persisted as requiring officer review.
async fn automatically_group_event_fights(
    db: &DatabaseConnection,
    event_id: i64,
    context: Option<&BattleLinkingContext>,
) -> Result<(), AppError> {
    let Some(context) = context else {
        return Ok(());
    };
    let fights = fight::Entity::find()
        .filter(fight::Column::EventId.eq(event_id))
        .order_by_asc(fight::Column::StartedAt)
        .all(db)
        .await
        .map_err(AppError::Database)?;
    if fights.len() < 2 {
        return Ok(());
    }
    let fight_ids = fights.iter().map(|fight| fight.id).collect::<Vec<_>>();
    let segments = fight_battle::Entity::find()
        .filter(fight_battle::Column::FightId.is_in(fight_ids))
        .all(db)
        .await
        .map_err(AppError::Database)?;
    let battle_ids = segments
        .iter()
        .map(|segment| segment.battle_id)
        .collect::<Vec<_>>();
    let snapshots = GuildBattleSnapshotEntity::find()
        .filter(GuildBattleSnapshotColumn::BattleId.is_in(battle_ids))
        .all(db)
        .await
        .map_err(AppError::Database)?;
    let snapshots = snapshots
        .into_iter()
        .map(|snapshot| (snapshot.battle_id, snapshot))
        .collect::<HashMap<_, _>>();
    let mut fight_by_battle = segments
        .iter()
        .map(|segment| (segment.battle_id, segment.fight_id))
        .collect::<HashMap<_, _>>();
    let mut evidence = Vec::new();
    for segment in segments {
        let Some(snapshot) = snapshots.get(&segment.battle_id) else {
            continue;
        };
        let guilds = serde_json::from_str::<Vec<BattleGuildSummary>>(&snapshot.guilds_json)
            .unwrap_or_default();
        let players =
            serde_json::from_str::<Vec<BattlePlayer>>(&snapshot.players_json).unwrap_or_default();
        evidence.push((
            segment.battle_id,
            FightEvidence {
                event_id: Some(event_id),
                started_at: Some(snapshot.start_time.with_timezone(&Utc)),
                ended_at: snapshot.end_time.map(|time| time.with_timezone(&Utc)),
                friendly_guild_ids: guilds
                    .iter()
                    .filter(|guild| context.is_friendly_guild(&guild.id, &guild.name))
                    .map(|guild| guild.id.clone())
                    .collect::<BTreeSet<_>>(),
                opponent_guild_ids: guilds
                    .iter()
                    .filter(|guild| !context.is_friendly_guild(&guild.id, &guild.name))
                    .map(|guild| guild.id.clone())
                    .collect::<BTreeSet<_>>(),
                player_ids: players
                    .iter()
                    .filter(|player| {
                        context.is_friendly_guild(&player.guild_id, &player.guild_name)
                    })
                    .map(|player| player.id.clone())
                    .collect::<BTreeSet<_>>(),
                size: usize::try_from(snapshot.total_players).ok(),
            },
        ));
    }
    evidence.sort_by_key(|(_, evidence)| evidence.started_at);

    for pair in evidence.windows(2) {
        let (left_battle_id, left) = &pair[0];
        let (right_battle_id, right) = &pair[1];
        let result = score_fight_grouping(left, right);
        let Some(&left_fight_id) = fight_by_battle.get(left_battle_id) else {
            continue;
        };
        let Some(&right_fight_id) = fight_by_battle.get(right_battle_id) else {
            continue;
        };
        if left_fight_id == right_fight_id {
            continue;
        }
        match result.decision {
            FightGroupingDecision::AutoMerge => {
                let moved_segments = fight_battle::Entity::find()
                    .filter(fight_battle::Column::FightId.eq(right_fight_id))
                    .order_by_asc(fight_battle::Column::SequenceNumber)
                    .all(db)
                    .await
                    .map_err(AppError::Database)?;
                let sequence_offset = fight_battle::Entity::find()
                    .filter(fight_battle::Column::FightId.eq(left_fight_id))
                    .count(db)
                    .await
                    .map_err(AppError::Database)? as i32;
                for (index, segment) in moved_segments.into_iter().enumerate() {
                    let mut active: fight_battle::ActiveModel = segment.into();
                    active.fight_id = Set(left_fight_id);
                    active.sequence_number = Set(sequence_offset + index as i32 + 1);
                    active.update(db).await.map_err(AppError::Database)?;
                }
                let winner = fight::Entity::find_by_id(left_fight_id)
                    .one(db)
                    .await
                    .map_err(AppError::Database)?
                    .ok_or_else(|| {
                        AppError::Internal(format!("Fight {left_fight_id} is missing"))
                    })?;
                let mut winner: fight::ActiveModel = winner.into();
                winner.grouping_method = Set("automatic".to_string());
                winner.grouping_confidence = Set(result.score);
                winner.grouping_version = Set(FIGHT_GROUPING_VERSION.to_string());
                winner.needs_review = Set(false);
                winner.ended_at = Set(right.ended_at.map(Into::into));
                winner.updated_at = Set(Utc::now().into());
                winner.update(db).await.map_err(AppError::Database)?;
                fight::Entity::delete_by_id(right_fight_id)
                    .exec(db)
                    .await
                    .map_err(AppError::Database)?;
                for fight_id in fight_by_battle.values_mut() {
                    if *fight_id == right_fight_id {
                        *fight_id = left_fight_id;
                    }
                }
            }
            FightGroupingDecision::NeedsReview => {
                for fight_id in [left_fight_id, right_fight_id] {
                    let candidate = fight::Entity::find_by_id(fight_id)
                        .one(db)
                        .await
                        .map_err(AppError::Database)?
                        .ok_or_else(|| {
                            AppError::Internal(format!("Fight {fight_id} is missing"))
                        })?;
                    let mut candidate: fight::ActiveModel = candidate.into();
                    candidate.grouping_confidence = Set(result.score);
                    candidate.grouping_version = Set(FIGHT_GROUPING_VERSION.to_string());
                    candidate.needs_review = Set(true);
                    candidate.updated_at = Set(Utc::now().into());
                    candidate.update(db).await.map_err(AppError::Database)?;
                }
            }
            FightGroupingDecision::Separate => {}
        }
    }
    Ok(())
}

/// Builds stable canonical Fight views while preserving every raw Battle ID for drill-down.
async fn build_event_fight_views(
    db: &DatabaseConnection,
    event_id: i64,
) -> Result<Vec<EventFightView>, AppError> {
    let fights = fight::Entity::find()
        .filter(fight::Column::EventId.eq(event_id))
        .order_by_asc(fight::Column::StartedAt)
        .all(db)
        .await
        .map_err(AppError::Database)?;
    let fight_ids = fights.iter().map(|fight| fight.id).collect::<Vec<_>>();
    let segments = if fight_ids.is_empty() {
        Vec::new()
    } else {
        fight_battle::Entity::find()
            .filter(fight_battle::Column::FightId.is_in(fight_ids))
            .order_by_asc(fight_battle::Column::SequenceNumber)
            .all(db)
            .await
            .map_err(AppError::Database)?
    };
    let mut battle_ids_by_fight = HashMap::<i64, Vec<String>>::new();
    for segment in segments {
        battle_ids_by_fight
            .entry(segment.fight_id)
            .or_default()
            .push(segment.battle_id.to_string());
    }
    Ok(fights
        .into_iter()
        .map(|fight| EventFightView {
            id: fight.id,
            started_at: fight.started_at.to_rfc3339(),
            ended_at: fight.ended_at.map(|time| time.to_rfc3339()),
            grouping_method: fight.grouping_method,
            grouping_confidence: fight.grouping_confidence,
            needs_review: fight.needs_review,
            battle_ids: battle_ids_by_fight.remove(&fight.id).unwrap_or_default(),
        })
        .collect())
}

/// Replaces stale event-link summary metrics with hydrated canonical snapshot data.
///
/// The event linker receives a compact AlbionBB list payload; the persisted battle
/// snapshot is hydrated from the detail endpoint and is therefore authoritative when
/// present. The original row remains the fallback for historical data not yet hydrated.
async fn apply_canonical_snapshot_metrics(
    db: &DatabaseConnection,
    battle_rows: Vec<event_battle::Model>,
    context: Option<&BattleLinkingContext>,
) -> Result<Vec<event_battle::Model>, AppError> {
    let battle_ids = battle_rows
        .iter()
        .filter_map(|battle| battle.albionbb_battle_id.parse::<i64>().ok())
        .collect::<Vec<_>>();
    if battle_ids.is_empty() {
        return Ok(battle_rows);
    }

    let snapshots = GuildBattleSnapshotEntity::find()
        .filter(GuildBattleSnapshotColumn::BattleId.is_in(battle_ids))
        .all(db)
        .await
        .map_err(AppError::Database)?;
    let snapshots_by_battle = snapshots
        .into_iter()
        .map(|snapshot| (snapshot.battle_id, snapshot))
        .collect::<HashMap<_, _>>();

    Ok(battle_rows
        .into_iter()
        .map(|mut battle| {
            let Some(battle_id) = battle.albionbb_battle_id.parse::<i64>().ok() else {
                return battle;
            };
            let Some(snapshot) = snapshots_by_battle.get(&battle_id) else {
                return battle;
            };
            let Ok(guilds) = serde_json::from_str::<Vec<BattleGuildSummary>>(&snapshot.guilds_json)
            else {
                tracing::warn!(battle_id, "skipping malformed canonical guild snapshot");
                return battle;
            };
            let Some(context) = context else {
                return battle;
            };
            let Some(our_guild) = guilds
                .iter()
                .find(|guild| context.is_friendly_guild(&guild.id, &guild.name))
            else {
                return battle;
            };
            let opponent = guilds
                .iter()
                .filter(|guild| !context.is_friendly_guild(&guild.id, &guild.name))
                .max_by_key(|guild| guild.kill_fame);

            battle.guild_players_count = i32::try_from(our_guild.players).unwrap_or(i32::MAX);
            battle.battle_total_players =
                Some(i32::try_from(snapshot.total_players).unwrap_or(i32::MAX));
            battle.guild_kills = our_guild.kills;
            battle.guild_deaths = our_guild.deaths;
            battle.guild_kill_fame = our_guild.kill_fame;
            battle.is_win = our_guild.winner;
            battle.opponent_guild_id = opponent.map(|guild| guild.id.clone());
            battle.opponent_guild_name = opponent.map(|guild| guild.name.clone());
            battle.opponent_players_count =
                opponent.and_then(|guild| i32::try_from(guild.players).ok());
            battle.opponent_kills = opponent.map(|guild| guild.kills);
            battle.opponent_deaths = opponent.map(|guild| guild.deaths);
            battle.opponent_kill_fame = opponent.map(|guild| guild.kill_fame);
            battle
        })
        .collect())
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
            Ok(SplitStatus::Pending | SplitStatus::AwaitingEvent) => stats.pending_splits += 1,
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

    /// Returns the durable assignment snapshot for an event.
    pub async fn get_roster(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
    ) -> Result<EventRosterView, AppError> {
        let event_model = event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        let participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(event_id))
            .order_by_asc(event_participation::Column::CreatedAt)
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let concrete = participations
            .iter()
            .filter(|p| p.primary_build_id.is_some())
            .count();
        let extras = event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(event_id))
            .count(db)
            .await
            .map_err(AppError::Database)? as usize;
        let (active_comp, _) = self
            .resolve_active_comp_with_extra_slots(
                db,
                event_model.comp_id,
                concrete,
                extras,
                event_model.player_cap,
            )
            .await?;
        let mut seats = self.canonical_roster_seats(db, active_comp.id).await?;
        let assignments = event_roster_assignment::Entity::find()
            .filter(event_roster_assignment::Column::EventId.eq(event_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let assigned_build_by_user = assigned_builds_by_user(assignments.iter().cloned());
        // The roster's specialization badge reads these; leaving them empty made every bench
        // member render as level 0 no matter what they had trained.
        let participant_user_ids: Vec<i64> =
            participations.iter().map(|entry| entry.user_id).collect();
        let mut specializations_by_user =
            crate::modules::users::specializations::load_levels_for_users(
                db,
                &participant_user_ids,
            )
            .await?;

        let mut participants = HashMap::new();
        for participation in participations {
            let user = crate::modules::users::entities::Entity::find_by_id(participation.user_id)
                .one(db)
                .await
                .map_err(AppError::Database)?
                .ok_or_else(|| {
                    AppError::NotFound(format!("User {} not found", participation.user_id))
                })?;
            let primary_build_name = match participation.primary_build_id {
                Some(id) => {
                    build::Entity::find_by_id(id)
                        .one(db)
                        .await
                        .map_err(AppError::Database)?
                        .ok_or_else(|| AppError::NotFound(format!("Build {id} not found")))?
                        .name
                }
                None => "Fill".to_string(),
            };
            let secondary_build_name = match participation.secondary_build_id {
                Some(id) => Some(
                    build::Entity::find_by_id(id)
                        .one(db)
                        .await
                        .map_err(AppError::Database)?
                        .ok_or_else(|| AppError::NotFound(format!("Build {id} not found")))?
                        .name,
                ),
                None => None,
            };
            let assigned_build_id = assigned_build_by_user.get(&participation.user_id).copied();
            let assigned_build_name = resolve_assigned_build_name(
                db,
                assigned_build_id,
                participation.primary_build_id,
                &primary_build_name,
            )
            .await?;
            participants.insert(
                participation.user_id,
                EventParticipantView {
                    user_id: participation.user_id,
                    username: crate::modules::users::display_name::resolve(db, &user).await?,
                    discord_id: user.discord_id,
                    primary_build_id: participation.primary_build_id,
                    primary_build_name,
                    secondary_build_id: participation.secondary_build_id,
                    secondary_build_name,
                    assigned_build_id,
                    assigned_build_name,
                    specializations: specializations_by_user
                        .remove(&participation.user_id)
                        .unwrap_or_default(),
                },
            );
        }
        let assigned: HashMap<_, _> = assignments
            .into_iter()
            .map(|a| (a.seat_key, a.user_id))
            .collect();
        let mut assigned_users = HashSet::new();
        for seat in &mut seats {
            if let Some(user_id) = assigned.get(&seat.key) {
                seat.participant = participants.get(user_id).cloned();
                assigned_users.insert(*user_id);
            }
        }
        let bench = participants
            .into_iter()
            .filter_map(|(user_id, participant)| {
                (!assigned_users.contains(&user_id)).then_some(participant)
            })
            .collect();
        Ok(EventRosterView {
            event_id,
            roster_version: event_model.roster_version,
            active_comp_id: active_comp.id,
            seats,
            bench,
        })
    }

    /// Expands a comp's `comp_builds` rows into the flat, ordered seat list every roster view
    /// is built from.
    ///
    /// Public so [`crate::modules::combat::readiness`] can read the same seats for a comp with
    /// no event context at all — readiness is a property of the composition, not of any one
    /// night's roster.
    pub async fn canonical_roster_seats<C: ConnectionTrait>(
        &self,
        db: &C,
        comp_id: i64,
    ) -> Result<Vec<EventRosterSeatView>, AppError> {
        let mut rows = comp_build::Entity::find()
            .filter(comp_build::Column::CompId.eq(comp_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        rows.sort_by_key(|row| row.build_id);
        let mut seats = Vec::new();
        for row in rows {
            let build = build::Entity::find_by_id(row.build_id)
                .one(db)
                .await
                .map_err(AppError::Database)?
                .ok_or_else(|| AppError::NotFound(format!("Build {} not found", row.build_id)))?;
            for ordinal in 1..=row.quantity {
                let sequential = seats.len() as i32;
                seats.push(EventRosterSeatView {
                    key: format!("build:{}:{ordinal}", row.build_id),
                    party_number: sequential / 20 + 1,
                    position: sequential % 20 + 1,
                    build_id: row.build_id,
                    build_name: build.name.clone(),
                    build_version: build.version,
                    role: build.role.clone(),
                    participant: None,
                });
            }
        }
        Ok(seats)
    }

    async fn advance_roster_version(
        &self,
        txn: &sea_orm::DatabaseTransaction,
        event_id: i64,
        expected: i64,
    ) -> Result<i64, AppError> {
        let result = event::Entity::update_many()
            .col_expr(
                event::Column::RosterVersion,
                Expr::col(event::Column::RosterVersion).add(1),
            )
            .filter(event::Column::Id.eq(event_id))
            .filter(event::Column::RosterVersion.eq(expected))
            .exec(txn)
            .await
            .map_err(AppError::Database)?;
        if result.rows_affected != 1 {
            return Err(AppError::Conflict("roster version is stale".to_string()));
        }
        Ok(expected + 1)
    }

    /// Assigns a signed-up participant to a canonical seat without changing preferences.
    pub async fn assign_roster_seat(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        seat_key: &str,
        request: AssignRosterSeatRequest,
        actor_id: i64,
    ) -> Result<i64, AppError> {
        let txn = db.begin().await.map_err(AppError::Database)?;
        let event_model = event::Entity::find_by_id(event_id)
            .one(&txn)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        let participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(event_id))
            .all(&txn)
            .await
            .map_err(AppError::Database)?;
        if !participations
            .iter()
            .any(|entry| entry.user_id == request.user_id)
        {
            return Err(AppError::Validation(
                "user is not participating in this event".to_string(),
            ));
        }
        let extra_slots = event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(event_id))
            .count(&txn)
            .await
            .map_err(AppError::Database)? as usize;
        let concrete = participations
            .iter()
            .filter(|entry| entry.primary_build_id.is_some())
            .count();
        let (active_comp, _) = self
            .resolve_active_comp_with_extra_slots(
                &txn,
                event_model.comp_id,
                concrete,
                extra_slots,
                event_model.player_cap,
            )
            .await?;
        if !self
            .canonical_roster_seats(&txn, active_comp.id)
            .await?
            .iter()
            .any(|seat| seat.key == seat_key)
        {
            return Err(AppError::Validation(format!(
                "invalid roster seat key: {seat_key}"
            )));
        }
        let version = self
            .advance_roster_version(&txn, event_id, request.expected_roster_version)
            .await?;
        event_roster_assignment::Entity::delete_many()
            .filter(event_roster_assignment::Column::EventId.eq(event_id))
            .filter(
                event_roster_assignment::Column::UserId
                    .eq(request.user_id)
                    .or(event_roster_assignment::Column::SeatKey.eq(seat_key)),
            )
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
        event_roster_assignment::ActiveModel {
            event_id: Set(event_id),
            user_id: Set(request.user_id),
            seat_key: Set(seat_key.to_string()),
            assigned_by: Set(actor_id),
            assigned_at: Set(Utc::now().into()),
            updated_at: Set(Utc::now().into()),
        }
        .insert(&txn)
        .await
        .map_err(AppError::Database)?;
        txn.commit().await.map_err(AppError::Database)?;
        Ok(version)
    }

    /// Clears a seat assignment, returning its participant to the bench.
    pub async fn clear_roster_seat(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        seat_key: &str,
        request: RosterVersionRequest,
    ) -> Result<i64, AppError> {
        let txn = db.begin().await.map_err(AppError::Database)?;
        let event_model = event::Entity::find_by_id(event_id)
            .one(&txn)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        let participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(event_id))
            .all(&txn)
            .await
            .map_err(AppError::Database)?;
        let extra_slots = event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(event_id))
            .count(&txn)
            .await
            .map_err(AppError::Database)? as usize;
        let concrete = participations
            .iter()
            .filter(|entry| entry.primary_build_id.is_some())
            .count();
        let (active_comp, _) = self
            .resolve_active_comp_with_extra_slots(
                &txn,
                event_model.comp_id,
                concrete,
                extra_slots,
                event_model.player_cap,
            )
            .await?;
        if !self
            .canonical_roster_seats(&txn, active_comp.id)
            .await?
            .iter()
            .any(|seat| seat.key == seat_key)
        {
            return Err(AppError::Validation(format!(
                "invalid roster seat key: {seat_key}"
            )));
        }
        let version = self
            .advance_roster_version(&txn, event_id, request.expected_roster_version)
            .await?;
        let deleted = event_roster_assignment::Entity::delete_many()
            .filter(event_roster_assignment::Column::EventId.eq(event_id))
            .filter(event_roster_assignment::Column::SeatKey.eq(seat_key))
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
        if deleted.rows_affected != 1 {
            return Err(AppError::NotFound(
                "roster seat assignment not found".to_string(),
            ));
        }
        txn.commit().await.map_err(AppError::Database)?;
        Ok(version)
    }

    /// Swaps the occupants of two seats in one transaction.
    pub async fn swap_roster_seats(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        request: SwapRosterSeatsRequest,
        actor_id: i64,
    ) -> Result<i64, AppError> {
        if request.source_seat_key == request.target_seat_key {
            return Err(AppError::Validation(
                "source and target roster seats must differ".to_string(),
            ));
        }
        let txn = db.begin().await.map_err(AppError::Database)?;
        let event_model = event::Entity::find_by_id(event_id)
            .one(&txn)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        let participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(event_id))
            .all(&txn)
            .await
            .map_err(AppError::Database)?;
        let extra_slots = event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(event_id))
            .count(&txn)
            .await
            .map_err(AppError::Database)? as usize;
        let concrete = participations
            .iter()
            .filter(|entry| entry.primary_build_id.is_some())
            .count();
        let (active_comp, _) = self
            .resolve_active_comp_with_extra_slots(
                &txn,
                event_model.comp_id,
                concrete,
                extra_slots,
                event_model.player_cap,
            )
            .await?;
        let seats = self.canonical_roster_seats(&txn, active_comp.id).await?;
        if !seats.iter().any(|seat| seat.key == request.source_seat_key)
            || !seats.iter().any(|seat| seat.key == request.target_seat_key)
        {
            return Err(AppError::Validation("invalid roster seat key".to_string()));
        }
        let version = self
            .advance_roster_version(&txn, event_id, request.expected_roster_version)
            .await?;
        let assignments = event_roster_assignment::Entity::find()
            .filter(event_roster_assignment::Column::EventId.eq(event_id))
            .filter(event_roster_assignment::Column::SeatKey.is_in([
                request.source_seat_key.clone(),
                request.target_seat_key.clone(),
            ]))
            .all(&txn)
            .await
            .map_err(AppError::Database)?;
        event_roster_assignment::Entity::delete_many()
            .filter(event_roster_assignment::Column::EventId.eq(event_id))
            .filter(event_roster_assignment::Column::SeatKey.is_in([
                request.source_seat_key.clone(),
                request.target_seat_key.clone(),
            ]))
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
        for assignment in assignments {
            let seat_key = if assignment.seat_key == request.source_seat_key {
                request.target_seat_key.clone()
            } else {
                request.source_seat_key.clone()
            };
            event_roster_assignment::ActiveModel {
                event_id: Set(event_id),
                user_id: Set(assignment.user_id),
                seat_key: Set(seat_key),
                assigned_by: Set(actor_id),
                assigned_at: Set(assignment.assigned_at),
                updated_at: Set(Utc::now().into()),
            }
            .insert(&txn)
            .await
            .map_err(AppError::Database)?;
        }
        txn.commit().await.map_err(AppError::Database)?;
        Ok(version)
    }

    /// Assigns unseated participants to matching primary then secondary seats.
    pub async fn auto_fill_roster(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        request: RosterVersionRequest,
        actor_id: i64,
    ) -> Result<(i64, Vec<String>), AppError> {
        let txn = db.begin().await.map_err(AppError::Database)?;
        let event_model = event::Entity::find_by_id(event_id)
            .one(&txn)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        let participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(event_id))
            .order_by_asc(event_participation::Column::CreatedAt)
            .all(&txn)
            .await
            .map_err(AppError::Database)?;
        let extra_slots = event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(event_id))
            .count(&txn)
            .await
            .map_err(AppError::Database)? as usize;
        let concrete = participations
            .iter()
            .filter(|entry| entry.primary_build_id.is_some())
            .count();
        let (active_comp, _) = self
            .resolve_active_comp_with_extra_slots(
                &txn,
                event_model.comp_id,
                concrete,
                extra_slots,
                event_model.player_cap,
            )
            .await?;
        let assignments = event_roster_assignment::Entity::find()
            .filter(event_roster_assignment::Column::EventId.eq(event_id))
            .all(&txn)
            .await
            .map_err(AppError::Database)?;
        let assigned_users: HashSet<_> = assignments
            .iter()
            .map(|assignment| assignment.user_id)
            .collect();
        let assigned_seats: HashSet<_> = assignments
            .iter()
            .map(|assignment| assignment.seat_key.as_str())
            .collect();
        let mut available: Vec<_> = self
            .canonical_roster_seats(&txn, active_comp.id)
            .await?
            .into_iter()
            .filter(|seat| !assigned_seats.contains(seat.key.as_str()))
            .collect();
        let version = self
            .advance_roster_version(&txn, event_id, request.expected_roster_version)
            .await?;
        let unassigned: Vec<_> = participations
            .into_iter()
            .filter(|participant| !assigned_users.contains(&participant.user_id))
            .collect();

        let placements = match request.strategy.unwrap_or_default() {
            FitStrategy::Greedy => greedy_placements(&unassigned, &mut available),
            FitStrategy::SpecOptimal => {
                self.spec_optimal_placements(&txn, &unassigned, &available)
                    .await?
            }
        };

        let mut changed = Vec::with_capacity(placements.len());
        for (user_id, seat_key) in placements {
            event_roster_assignment::ActiveModel {
                event_id: Set(event_id),
                user_id: Set(user_id),
                seat_key: Set(seat_key.clone()),
                assigned_by: Set(actor_id),
                assigned_at: Set(Utc::now().into()),
                updated_at: Set(Utc::now().into()),
            }
            .insert(&txn)
            .await
            .map_err(AppError::Database)?;
            changed.push(seat_key);
        }
        txn.commit().await.map_err(AppError::Database)?;
        Ok((version, changed))
    }

    /// Previews what `auto_fill_roster(strategy: spec_optimal)` would do, without writing
    /// anything or advancing the roster version.
    ///
    /// Read-only by design: an officer should be able to see the proposed assignment, compare it
    /// against the current roster, and only then decide to apply it.
    pub async fn get_roster_suggestions(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
    ) -> Result<fit::Assignment, AppError> {
        let event_model = event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        let participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(event_id))
            .order_by_asc(event_participation::Column::CreatedAt)
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let extra_slots = event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(event_id))
            .count(db)
            .await
            .map_err(AppError::Database)? as usize;
        let concrete = participations
            .iter()
            .filter(|entry| entry.primary_build_id.is_some())
            .count();
        let (active_comp, _) = self
            .resolve_active_comp_with_extra_slots(
                db,
                event_model.comp_id,
                concrete,
                extra_slots,
                event_model.player_cap,
            )
            .await?;
        let assignments = event_roster_assignment::Entity::find()
            .filter(event_roster_assignment::Column::EventId.eq(event_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let assigned_users: HashSet<_> = assignments
            .iter()
            .map(|assignment| assignment.user_id)
            .collect();
        let assigned_seats: HashSet<_> = assignments
            .iter()
            .map(|assignment| assignment.seat_key.as_str())
            .collect();
        let available: Vec<_> = self
            .canonical_roster_seats(db, active_comp.id)
            .await?
            .into_iter()
            .filter(|seat| !assigned_seats.contains(seat.key.as_str()))
            .collect();
        let unassigned: Vec<_> = participations
            .into_iter()
            .filter(|participant| !assigned_users.contains(&participant.user_id))
            .collect();
        let (members, seats) = fit_inputs(db, &unassigned, &available).await?;
        Ok(fit::assign(&members, &seats))
    }

    /// Builds the [`fit::Member`]/[`fit::Seat`] shapes and solves the whole unassigned roster at
    /// once, favouring readiness and signup preference over first-come-first-served order.
    async fn spec_optimal_placements(
        &self,
        txn: &sea_orm::DatabaseTransaction,
        unassigned: &[event_participation::Model],
        available: &[EventRosterSeatView],
    ) -> Result<Vec<(i64, String)>, AppError> {
        let (members, seats) = fit_inputs(txn, unassigned, available).await?;
        Ok(fit::assign(&members, &seats)
            .placements
            .into_iter()
            .map(|placement| (placement.user_id, placement.seat_key))
            .collect())
    }

    /// Lists an event's roster roles, with the virtual unlimited-capacity `Fill` role first.
    pub async fn list_event_roster_roles(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
    ) -> Result<Vec<EventRosterRoleView>, AppError> {
        event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        load_event_roster_roles(db, event_id).await
    }

    /// Adds an existing build as an event-specific roster role.
    pub async fn create_event_roster_role(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        request: CreateEventRosterRoleRequest,
    ) -> Result<EventRosterRoleView, AppError> {
        event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        let build = build::Entity::find_by_id(request.build_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Build {} not found", request.build_id)))?;

        if event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(event_id))
            .filter(event_roster_role::Column::BuildId.eq(request.build_id))
            .one(db)
            .await
            .map_err(AppError::Database)?
            .is_some()
        {
            return Err(AppError::Conflict(format!(
                "Build {} is already an extra roster role for event {event_id}",
                request.build_id
            )));
        }

        let role = event_roster_role::ActiveModel {
            event_id: Set(event_id),
            build_id: Set(request.build_id),
            ..Default::default()
        }
        .insert(db)
        .await
        .map_err(AppError::Database)?;

        Ok(EventRosterRoleView {
            id: Some(role.id),
            build_id: Some(role.build_id),
            name: build.name,
            is_fill: false,
        })
    }

    /// Deletes an event-specific extra roster role.
    pub async fn delete_event_roster_role(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        role_id: i64,
    ) -> Result<(), AppError> {
        let role = event_roster_role::Entity::find_by_id(role_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Roster role {role_id} not found")))?;
        if role.event_id != event_id {
            return Err(AppError::NotFound(format!(
                "Roster role {role_id} was not found for event {event_id}"
            )));
        }
        event_roster_role::Entity::delete_by_id(role_id)
            .exec(db)
            .await
            .map_err(AppError::Database)?;
        Ok(())
    }

    /// Resolves the active composition (base or variant) using the 75% expansion threshold.
    pub async fn resolve_active_comp<C: ConnectionTrait>(
        &self,
        db: &C,
        base_comp_id: i64,
        target_size: usize,
    ) -> Result<(comp::Model, i64), AppError> {
        self.resolve_active_comp_with_extra_slots(db, base_comp_id, target_size, 0, None)
            .await
    }

    /// Resolves the active composition using parent-linked expansions and fixed-capacity extra
    /// roster roles.
    async fn resolve_active_comp_with_extra_slots<C: ConnectionTrait>(
        &self,
        db: &C,
        base_comp_id: i64,
        target_size: usize,
        extra_roster_slots: usize,
        player_cap: Option<i64>,
    ) -> Result<(comp::Model, i64), AppError> {
        // Fetch base comp
        let base_comp = comp::Entity::find_by_id(base_comp_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Base comp {base_comp_id} not found")))?;

        // Build a complete capacity index up front, then traverse only descendants reachable from
        // the event's base comp. This supports arbitrary expansion depth without treating an
        // unrelated comp as an eligible tier.
        let capacities: HashMap<i64, i64> = comp_build::Entity::find()
            .all(db)
            .await
            .map_err(AppError::Database)?
            .into_iter()
            .fold(HashMap::new(), |mut totals, entry| {
                *totals.entry(entry.comp_id).or_default() += i64::from(entry.quantity);
                totals
            });
        let all_comps = comp::Entity::find()
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let mut children_by_parent = HashMap::<i64, Vec<comp::Model>>::new();
        for candidate in all_comps {
            if let Some(parent_id) = candidate.parent_id {
                children_by_parent
                    .entry(parent_id)
                    .or_default()
                    .push(candidate);
            }
        }

        let base_capacity = capacities.get(&base_comp.id).copied().unwrap_or_default();
        let mut reachable = vec![(base_comp, base_capacity)];
        let mut pending = vec![(base_comp_id, base_capacity)];
        let mut visited = HashSet::from([base_comp_id]);

        while let Some((parent_id, parent_capacity)) = pending.pop() {
            for child in children_by_parent
                .get(&parent_id)
                .cloned()
                .unwrap_or_default()
            {
                if !visited.insert(child.id) {
                    tracing::warn!(
                        base_comp_id,
                        parent_id,
                        child_id = child.id,
                        "skipping cyclic comp expansion relationship"
                    );
                    continue;
                }

                let child_capacity = capacities.get(&child.id).copied().unwrap_or_default();
                if child_capacity <= parent_capacity {
                    tracing::warn!(
                        base_comp_id,
                        parent_id,
                        child_id = child.id,
                        parent_capacity,
                        child_capacity,
                        "skipping non-growing comp expansion relationship"
                    );
                    continue;
                }

                pending.push((child.id, child_capacity));
                reachable.push((child, child_capacity));
            }
        }

        reachable.sort_by_key(|(candidate, capacity)| (*capacity, candidate.id));
        let target_size = target_size as i64;
        let extra_roster_slots = extra_roster_slots as i64;
        let mut active = reachable
            .first()
            .cloned()
            .expect("the base comp always provides one reachable comp");
        let mut forced = player_cap.is_some_and(|cap| target_size >= cap);

        // Expand one link at a time. This makes a chain deterministic and means that an event
        // configured on Comp2 can expose Comp3 without requiring the event to use Comp1.
        loop {
            let threshold = expansion_threshold(active.1 + extra_roster_slots);
            let should_expand = forced || target_size >= threshold;
            let next = reachable
                .iter()
                .filter(|(candidate, _)| candidate.parent_id == Some(active.0.id))
                .min_by_key(|(candidate, capacity)| (*capacity, candidate.id));
            let Some(next) = next else { break };
            if !should_expand {
                break;
            }
            active = next.clone();
            forced = false;
        }
        Ok((active.0, active.1))
    }

    /// Returns the server-authoritative concrete build choices for a member's next signup.
    ///
    /// A member already in the roster keeps the current concrete-assignment count while changing
    /// choices. A member not yet registered is evaluated as one additional concrete signup, so
    /// Discord can show roles introduced by the tier that their selection would activate.
    pub async fn get_event_signup_options(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        user_id: i64,
    ) -> Result<EventSignupOptionsView, AppError> {
        let event = event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        let participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(event_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let is_already_registered = participations
            .iter()
            .any(|participation| participation.user_id == user_id);
        let prospective_participant_count =
            participations.len() + usize::from(!is_already_registered);
        let prospective_target =
            comp_resolution_target(prospective_participant_count, event.player_cap);

        let extra_roster_roles = event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(event_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let (active_comp, active_comp_capacity) = self
            .resolve_active_comp_with_extra_slots(
                db,
                event.comp_id,
                prospective_target,
                extra_roster_roles.len(),
                event.player_cap,
            )
            .await?;

        let comp_builds = comp_build::Entity::find()
            .filter(comp_build::Column::CompId.eq(active_comp.id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let mut builds = BTreeMap::<i64, EventSignupBuildView>::new();
        for (build_id, quantity) in comp_builds
            .into_iter()
            .map(|entry| (entry.build_id, entry.quantity))
            .chain(
                extra_roster_roles
                    .into_iter()
                    .map(|entry| (entry.build_id, 1)),
            )
        {
            if let Some(existing) = builds.get_mut(&build_id) {
                existing.quantity = existing.quantity.checked_add(quantity).ok_or_else(|| {
                    AppError::Internal(format!(
                        "signup slot quantity overflow for build {build_id}"
                    ))
                })?;
                continue;
            }

            let build = build::Entity::find_by_id(build_id)
                .one(db)
                .await
                .map_err(AppError::Database)?
                .ok_or_else(|| AppError::NotFound(format!("Build {build_id} not found")))?;
            let role = BuildRole::from_str(&build.role)
                .map_err(|_| AppError::Internal(format!("Unknown build role: {}", build.role)))?;
            builds.insert(
                build_id,
                EventSignupBuildView {
                    build_id,
                    name: build.name,
                    role,
                    quantity,
                },
            );
        }

        Ok(EventSignupOptionsView {
            active_comp_id: active_comp.id,
            active_comp_name: active_comp.name,
            active_comp_capacity,
            is_already_registered,
            builds: builds.into_values().collect(),
        })
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
        let start_time_utc = model.start_time_utc.unwrap_or(model.event_date_utc);
        let mass_time_utc = model
            .mass_time_utc
            .unwrap_or(start_time_utc - ChronoDuration::minutes(30));

        Ok(EventView {
            id: model.id,
            title: model.title,
            description: model.description,
            call_to_arms: model.call_to_arms,
            discord_role_ids,
            regear: model.regear,
            discord_voice_channel_id: model.discord_voice_channel_id,
            comp_id: model.comp_id,
            comp_name: comp.name,
            player_cap: model.player_cap,
            created_by: model.created_by,
            created_by_username,
            event_date_utc: start_time_utc.to_rfc3339(),
            mass_time_utc: mass_time_utc.to_rfc3339(),
            start_time_utc: start_time_utc.to_rfc3339(),
            created_at: model.created_at.to_rfc3339(),
            updated_at: model.updated_at.to_rfc3339(),
            roster_version: model.roster_version,
            status: model.status,
            started_at: model.started_at.map(|t| t.to_rfc3339()),
            stopped_at: model.stopped_at.map(|t| t.to_rfc3339()),
            auto_stop_deadline: model.auto_stop_deadline.map(|t| t.to_rfc3339()),
            link_status: model.link_status,
            link_attempts: model.link_attempts,
            link_last_error: model.link_last_error,
            link_battles_completed_at: model.link_battles_completed_at.map(|t| t.to_rfc3339()),
            archived_at: model.archived_at.map(|t| t.to_rfc3339()),
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
        query = if filters.archived.unwrap_or(false) {
            query.filter(event::Column::ArchivedAt.is_not_null())
        } else {
            query.filter(event::Column::ArchivedAt.is_null())
        };

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
                query = query.filter(event::Column::StartTimeUtc.gte(dt));
            }
        }

        if let Some(date_to) = filters.date_to {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&date_to) {
                query = query.filter(event::Column::StartTimeUtc.lte(dt));
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
                ("event_date_utc", event::Column::StartTimeUtc),
                ("start_time_utc", event::Column::StartTimeUtc),
                ("mass_time_utc", event::Column::MassTimeUtc),
                ("title", event::Column::Title),
                ("created_at", event::Column::CreatedAt),
                ("status", event::Column::Status),
            ],
            event::Column::EventDateUtc,
        )?;
        // Event lists are chronological by default, with the newest event first.
        // An explicit `order=asc` still lets the calendar view browse forward from the oldest.
        let order = SortOrder::from_query(filters.order.as_deref());
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

        let roster_roles = load_event_roster_roles(db, id).await?;

        let participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(id))
            .order_by_asc(event_participation::Column::CreatedAt)
            .all(db)
            .await
            .map_err(AppError::Database)?;

        let extra_roster_slots = event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(id))
            .count(db)
            .await
            .map_err(AppError::Database)? as usize;
        let (active_comp, active_capacity) = self
            .resolve_active_comp_with_extra_slots(
                db,
                event_model.comp_id,
                comp_resolution_target(participations.len(), event_model.player_cap),
                extra_roster_slots,
                event_model.player_cap,
            )
            .await?;
        let active_comp_builds = comp_build::Entity::find()
            .filter(comp_build::Column::CompId.eq(active_comp.id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let mut comp_builds = Vec::with_capacity(active_comp_builds.len());
        for entry in active_comp_builds {
            let build = build::Entity::find_by_id(entry.build_id)
                .one(db)
                .await
                .map_err(AppError::Database)?
                .ok_or_else(|| AppError::NotFound(format!("Build {} not found", entry.build_id)))?;
            comp_builds.push(EventCompBuildView {
                build_id: entry.build_id,
                name: build.name,
                quantity: entry.quantity,
            });
        }

        let participant_user_ids: Vec<i64> = participations.iter().map(|p| p.user_id).collect();
        let mut specializations_by_user =
            crate::modules::users::specializations::load_levels_for_users(
                db,
                &participant_user_ids,
            )
            .await?;

        let assignments = event_roster_assignment::Entity::find()
            .filter(event_roster_assignment::Column::EventId.eq(id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let assigned_build_by_user = assigned_builds_by_user(assignments);

        let mut participant_views = Vec::new();
        for p in participations {
            let user = crate::modules::users::entities::Entity::find_by_id(p.user_id)
                .one(db)
                .await
                .map_err(AppError::Database)?
                .ok_or_else(|| AppError::NotFound(format!("User {} not found", p.user_id)))?;
            let username = crate::modules::users::display_name::resolve(db, &user).await?;

            let primary_build_name = if let Some(primary_build_id) = p.primary_build_id {
                build::Entity::find_by_id(primary_build_id)
                    .one(db)
                    .await
                    .map_err(AppError::Database)?
                    .ok_or_else(|| {
                        AppError::NotFound(format!("Build {primary_build_id} not found"))
                    })?
                    .name
            } else {
                "Fill".to_string()
            };

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
            let assigned_build_id = assigned_build_by_user.get(&p.user_id).copied();
            let assigned_build_name = resolve_assigned_build_name(
                db,
                assigned_build_id,
                p.primary_build_id,
                &primary_build_name,
            )
            .await?;

            participant_views.push(EventParticipantView {
                user_id: p.user_id,
                username,
                discord_id: user.discord_id.clone(),
                primary_build_id: p.primary_build_id,
                primary_build_name,
                secondary_build_id: p.secondary_build_id,
                secondary_build_name,
                assigned_build_id,
                assigned_build_name,
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
        ensure_seed_fights_for_event(db, id, &battle_rows).await?;
        automatically_group_event_fights(db, id, context).await?;
        let battle_rows = apply_canonical_snapshot_metrics(db, battle_rows, context).await?;
        let battle_rows = Self::apply_read_context_to_battles(battle_rows, context);
        let stats = Self::build_performance_stats(&battle_rows);
        let estimated_losses = build_event_loss_estimate(db, &battle_rows).await?;
        let fights = build_event_fight_views(db, id).await?;
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

        let comp_builds = comp_build::Entity::find()
            .filter(comp_build::Column::CompId.eq(active_comp.id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let mut comp_builds = comp_builds
            .into_iter()
            .map(|entry| async move {
                let build = build::Entity::find_by_id(entry.build_id)
                    .one(db)
                    .await
                    .map_err(AppError::Database)?
                    .ok_or_else(|| {
                        AppError::NotFound(format!("Build {} not found", entry.build_id))
                    })?;
                Ok::<EventCompBuildView, AppError>(EventCompBuildView {
                    build_id: entry.build_id,
                    name: build.name,
                    quantity: entry.quantity,
                })
            })
            .collect::<Vec<_>>();
        let mut comp_build_views = Vec::with_capacity(comp_builds.len());
        for future in comp_builds.drain(..) {
            comp_build_views.push(future.await?);
        }
        comp_build_views.sort_by_key(|entry| entry.build_id);

        Ok(EventDetailView {
            event: event_view,
            active_comp_id: active_comp.id,
            active_comp_name: active_comp.name,
            active_comp_capacity: active_capacity,
            roster_roles,
            comp_builds: comp_build_views,
            participants: participant_views,
            fights,
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

    /// How one build version has performed, attributed to the players who actually ran it.
    ///
    /// The chain is: sign-ups naming this build version, then the battles of those events, then the
    /// stored battle snapshot's per-player rows, matched to the signed-up members through their
    /// linked Albion character name. That is deliberately narrower than "the events this build was
    /// in were won 62% of the time" — an event-level number is a property of the event, and would
    /// give every build in one fight the same score.
    ///
    /// Two coverage limits are reported rather than hidden: members with no linked Albion account
    /// cannot be matched at all, and `matched_players` is the real sample size behind the totals.
    pub async fn get_build_performance(
        &self,
        db: &DatabaseConnection,
        build_id: i64,
    ) -> Result<BuildPerformanceView, AppError> {
        use crate::modules::albion::entities::albion_link;
        use crate::modules::battles::entities as battle_snapshot;
        use crate::modules::comps::entities::build;

        let build_model = build::Entity::find_by_id(build_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Build {build_id} not found")))?;

        let signups = event_participation::Entity::find()
            .filter(
                event_participation::Column::PrimaryBuildId
                    .eq(build_id)
                    .or(event_participation::Column::SecondaryBuildId.eq(build_id)),
            )
            .all(db)
            .await
            .map_err(AppError::Database)?;

        let signups_as_primary = signups
            .iter()
            .filter(|signup| signup.primary_build_id == Some(build_id))
            .count() as i64;
        let signups_as_secondary = signups
            .iter()
            .filter(|signup| signup.secondary_build_id == Some(build_id))
            .count() as i64;

        let view = |players_without_an_albion_link, stats| BuildPerformanceView {
            build_id,
            build_name: build_model.name.clone(),
            version: build_model.version,
            signups_as_primary,
            signups_as_secondary,
            players_without_an_albion_link,
            stats,
        };

        if signups.is_empty() {
            return Ok(view(0, None));
        }

        // The battle payload names players but does not carry their Albion id, so the join key is
        // the linked character name. Same two hops as `intel`: link -> discord id -> user id.
        let user_ids: HashSet<i64> = signups.iter().map(|signup| signup.user_id).collect();
        let discord_by_user: HashMap<i64, String> = crate::modules::users::entities::Entity::find()
            .filter(crate::modules::users::entities::Column::Id.is_in(user_ids.iter().copied()))
            .all(db)
            .await
            .map_err(AppError::Database)?
            .into_iter()
            .filter_map(|user| user.discord_id.map(|discord| (user.id, discord)))
            .collect();
        let links = albion_link::Entity::find()
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let name_by_discord: HashMap<String, String> = links
            .into_iter()
            .map(|link| (link.discord_id, link.albion_player_name.to_lowercase()))
            .collect();

        let mut expected_names: HashSet<String> = HashSet::new();
        for user_id in &user_ids {
            if let Some(name) = discord_by_user
                .get(user_id)
                .and_then(|discord| name_by_discord.get(discord))
            {
                expected_names.insert(name.clone());
            }
        }
        let players_without_an_albion_link = (user_ids.len() - expected_names.len()) as i64;

        let event_ids: Vec<i64> = signups.iter().map(|signup| signup.event_id).collect();
        let battles = event_battle::Entity::find()
            .filter(event_battle::Column::EventId.is_in(event_ids))
            .all(db)
            .await
            .map_err(AppError::Database)?;

        if battles.is_empty() || expected_names.is_empty() {
            return Ok(view(players_without_an_albion_link, None));
        }

        let snapshot_ids: Vec<i64> = battles
            .iter()
            .filter_map(|battle| battle.albionbb_battle_id.parse::<i64>().ok())
            .collect();
        let snapshots = battle_snapshot::Entity::find()
            .filter(battle_snapshot::Column::BattleId.is_in(snapshot_ids))
            .all(db)
            .await
            .map_err(AppError::Database)?;

        let mut stats = BuildBattleStats {
            events: 0,
            battles: 0,
            matched_players: 0,
            wins: 0,
            losses: 0,
            kills: 0,
            deaths: 0,
            kill_fame: 0,
            death_fame: 0,
        };
        let mut counted_events: HashSet<i64> = HashSet::new();
        let outcome_by_battle: HashMap<i64, (i64, bool)> = battles
            .iter()
            .filter_map(|battle| {
                battle
                    .albionbb_battle_id
                    .parse::<i64>()
                    .ok()
                    .map(|id| (id, (battle.event_id, battle.is_win)))
            })
            .collect();

        for snapshot in &snapshots {
            let players: Vec<crate::modules::battles::models::BattlePlayer> =
                serde_json::from_str(&snapshot.players_json).unwrap_or_default();
            let ours: Vec<_> = players
                .iter()
                .filter(|player| expected_names.contains(&player.name.to_lowercase()))
                .collect();
            if ours.is_empty() {
                continue;
            }

            stats.battles += 1;
            stats.matched_players += ours.len() as i64;
            for player in ours {
                stats.kills += player.kills;
                stats.deaths += player.deaths;
                stats.kill_fame += player.kill_fame;
                stats.death_fame += player.death_fame;
            }
            if let Some((event_id, is_win)) = outcome_by_battle.get(&snapshot.battle_id) {
                counted_events.insert(*event_id);
                if *is_win {
                    stats.wins += 1;
                } else {
                    stats.losses += 1;
                }
            }
        }

        stats.events = counted_events.len() as i64;
        if stats.battles == 0 {
            return Ok(view(players_without_an_albion_link, None));
        }
        Ok(view(players_without_an_albion_link, Some(stats)))
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
        if let Some(player_cap) = req.player_cap
            && player_cap <= 0
        {
            return Err(AppError::Validation(
                "player_cap must be greater than zero when provided".to_string(),
            ));
        }

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

        let start = req
            .start_time_utc
            .as_deref()
            .or(req.event_date_utc.as_deref())
            .ok_or_else(|| AppError::Validation("start_time_utc is required".to_string()))
            .and_then(|value| parse_event_timestamp(value, "start_time_utc"))?;
        let mass = req
            .mass_time_utc
            .as_deref()
            .map(|value| parse_event_timestamp(value, "mass_time_utc"))
            .transpose()?
            .unwrap_or(start - ChronoDuration::minutes(30));
        validate_event_times(mass, start)?;

        let event_model = event::ActiveModel {
            title: Set(req.title),
            description: Set(req.description),
            call_to_arms: Set(req.call_to_arms),
            regear: Set(req.regear),
            comp_id: Set(req.comp_id),
            player_cap: Set(req.player_cap),
            created_by: Set(creator_id),
            event_date_utc: Set(start.into()),
            mass_time_utc: Set(Some(mass.into())),
            start_time_utc: Set(Some(start.into())),
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
        reject_if_event_archived(&event_model)?;

        let mut active: event::ActiveModel = event_model.clone().into();

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
        let current_start = event_model
            .start_time_utc
            .unwrap_or(event_model.event_date_utc)
            .with_timezone(&Utc);
        let current_mass = event_model
            .mass_time_utc
            .unwrap_or(event_model.event_date_utc - ChronoDuration::minutes(30))
            .with_timezone(&Utc);
        let start_changed = req.start_time_utc.is_some() || req.event_date_utc.is_some();
        let start = req
            .start_time_utc
            .as_deref()
            .or(req.event_date_utc.as_deref())
            .map(|value| parse_event_timestamp(value, "start_time_utc"))
            .transpose()?
            .unwrap_or(current_start);
        let mass = req
            .mass_time_utc
            .as_deref()
            .map(|value| parse_event_timestamp(value, "mass_time_utc"))
            .transpose()?
            .unwrap_or_else(|| {
                if start_changed {
                    start - ChronoDuration::minutes(30)
                } else {
                    current_mass
                }
            });
        validate_event_times(mass, start)?;
        active.event_date_utc = Set(start.into());
        active.mass_time_utc = Set(Some(mass.into()));
        active.start_time_utc = Set(Some(start.into()));

        active.updated_at = Set(chrono::Utc::now().into());

        let updated = active.update(db).await.map_err(AppError::Database)?;
        self.to_event_view(db, updated).await
    }

    /// Archives an event so it disappears from default lists without deleting the row.
    ///
    /// Linked splits are archived in the same pass: previously, deleting an event only
    /// `SET NULL` on `splits.event_id`, leaving the loot split in the officer queue.
    ///
    /// `DELETE /api/events/{id}` calls this so existing clients keep working.
    pub async fn delete_event(&self, db: &DatabaseConnection, id: i64) -> Result<(), AppError> {
        self.archive_event(db, id).await?;
        Ok(())
    }

    /// Archives an event and every split still linked to it.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the event does not exist.
    pub async fn archive_event(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<EventView, AppError> {
        let model = event::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;
        let now: DateTime<chrono::FixedOffset> = Utc::now().into();
        let txn = db.begin().await.map_err(AppError::Database)?;
        let mut active: event::ActiveModel = model.into();
        active.archived_at = Set(Some(now));
        active.updated_at = Set(now);
        let updated = active.update(&txn).await.map_err(AppError::Database)?;

        crate::modules::splits::entities::split::Entity::update_many()
            .filter(crate::modules::splits::entities::split::Column::EventId.eq(id))
            .filter(crate::modules::splits::entities::split::Column::ArchivedAt.is_null())
            .col_expr(
                crate::modules::splits::entities::split::Column::ArchivedAt,
                Expr::value(now),
            )
            .col_expr(
                crate::modules::splits::entities::split::Column::UpdatedAt,
                Expr::value(now),
            )
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
        txn.commit().await.map_err(AppError::Database)?;
        self.to_event_view(db, updated).await
    }

    /// Restores an archived event and its linked archived splits to the active lists.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the event does not exist.
    pub async fn unarchive_event(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<EventView, AppError> {
        let model = event::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;
        let now = chrono::Utc::now();
        let txn = db.begin().await.map_err(AppError::Database)?;
        let mut active: event::ActiveModel = model.into();
        active.archived_at = Set(None);
        active.updated_at = Set(now.into());
        let updated = active.update(&txn).await.map_err(AppError::Database)?;

        let linked = crate::modules::splits::entities::split::Entity::find()
            .filter(crate::modules::splits::entities::split::Column::EventId.eq(id))
            .filter(crate::modules::splits::entities::split::Column::ArchivedAt.is_not_null())
            .all(&txn)
            .await
            .map_err(AppError::Database)?;
        for split in linked {
            let mut split_active: crate::modules::splits::entities::split::ActiveModel =
                split.into();
            split_active.archived_at = Set(None);
            split_active.updated_at = Set(now.into());
            split_active
                .update(&txn)
                .await
                .map_err(AppError::Database)?;
        }
        txn.commit().await.map_err(AppError::Database)?;
        self.to_event_view(db, updated).await
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

    /// Persists the Discord voice channel created at Mass or Start.
    pub async fn bind_event_voice_channel(
        &self,
        db: &DatabaseConnection,
        id: i64,
        channel_id: &str,
    ) -> Result<EventView, AppError> {
        let channel_id = channel_id.trim();
        if !channel_id
            .chars()
            .all(|character| character.is_ascii_digit())
            || !(17..=20).contains(&channel_id.len())
        {
            return Err(AppError::Validation(
                "channel_id must be a Discord snowflake (17-20 digits)".to_string(),
            ));
        }

        let model = event::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;
        // Mass provisions the voice channel while the event is still scheduled; Start reuses it
        // after the transition to live. Terminal statuses cannot receive a new binding.
        if model.status != "scheduled" && model.status != "live" {
            return Err(AppError::Conflict(format!(
                "Event {id} cannot bind a Discord voice channel (status={})",
                model.status
            )));
        }
        if let Some(existing_channel_id) = &model.discord_voice_channel_id {
            if existing_channel_id == channel_id {
                return self.to_event_view(db, model).await;
            }
            return Err(AppError::Conflict(format!(
                "Event {id} already has Discord voice channel {existing_channel_id}"
            )));
        }

        let mut active: event::ActiveModel = model.into();
        active.discord_voice_channel_id = Set(Some(channel_id.to_string()));
        active.updated_at = Set(Utc::now().into());
        let updated = active.update(db).await.map_err(AppError::Database)?;
        self.to_event_view(db, updated).await
    }

    /// Clears the stored Discord voice channel after a stopped event has been cleaned up.
    pub async fn clear_event_voice_channel(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<EventView, AppError> {
        let model = event::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;
        if model.status != "stopped"
            && model.status != "auto_stopped"
            && model.status != "cancelled"
        {
            return Err(AppError::Conflict(format!(
                "Event {id} cannot clear a Discord voice channel (status={})",
                model.status
            )));
        }
        if model.discord_voice_channel_id.is_none() {
            return self.to_event_view(db, model).await;
        }

        let mut active: event::ActiveModel = model.into();
        active.discord_voice_channel_id = Set(None);
        active.updated_at = Set(Utc::now().into());
        let updated = active.update(db).await.map_err(AppError::Database)?;
        self.to_event_view(db, updated).await
    }

    /// Cancels an event before or during its session.
    ///
    /// Cancellation is idempotent. Completed sessions (`stopped`/`auto_stopped`) cannot be
    /// cancelled because they already represent a terminal outcome.
    pub async fn cancel_event(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<EventView, AppError> {
        let model = event::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;
        reject_if_event_archived(&model)?;

        if model.status == "cancelled" {
            return self.to_event_view(db, model).await;
        }
        if model.status != "scheduled" && model.status != "live" {
            return Err(AppError::Conflict(format!(
                "Event {id} cannot be cancelled (status={})",
                model.status
            )));
        }

        let now: DateTime<Utc> = Utc::now();
        let mut active: event::ActiveModel = model.into();
        active.status = Set("cancelled".to_string());
        active.stopped_at = Set(Some(now.into()));
        active.auto_stop_deadline = Set(None);
        active.updated_at = Set(now.into());
        let updated = active.update(db).await.map_err(AppError::Database)?;
        self.to_event_view(db, updated).await
    }

    /// Marks an event session as live, recording `started_at = now` and computing the
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
        reject_if_event_archived(&model)?;

        if model.status == "live" {
            return Err(AppError::Conflict(format!("Event {id} is already live")));
        }
        if model.status != "scheduled" {
            return Err(AppError::Conflict(format!(
                "Event {id} cannot be started (status={}); re-opening a stopped session is not supported",
                model.status
            )));
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
        reject_if_event_archived(&model)?;

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

        // Keep linked splits' roster and lifecycle condition current as soon as the event ends.
        SplitService::new().sync_event_participants(db, id).await?;

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
            if battle_is_assigned_to_another_event(db, event_id, battle.id).await? {
                return Err(AppError::Conflict(format!(
                    "Battle {} is already assigned to another event",
                    battle.id
                )));
            }

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

        let linked_battles = event_battle::Entity::find()
            .filter(event_battle::Column::EventId.eq(event_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        ensure_seed_fights_for_event(db, event_id, &linked_battles).await?;

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
            let started =
                chrono::DateTime::parse_from_rfc3339(&battle.start_time).map_err(|error| {
                    AppError::UpstreamService(format!(
                        "Battle {battle_id} has invalid start time '{}': {error}",
                        battle.start_time
                    ))
                })?;
            snapshots.push((battle_id.clone(), started, snapshot));
        }

        for battle_id in &battle_ids {
            let parsed_battle_id = battle_id.parse::<i64>().map_err(|error| {
                AppError::Validation(format!("Invalid AlbionBB battle id '{battle_id}': {error}"))
            })?;
            if battle_is_assigned_to_another_event(db, event_id, parsed_battle_id).await? {
                return Err(AppError::Conflict(format!(
                    "Battle {battle_id} is already assigned to another event"
                )));
            }
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

        let linked_battles = event_battle::Entity::find()
            .filter(event_battle::Column::EventId.eq(event_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        ensure_seed_fights_for_event(db, event_id, &linked_battles).await?;

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
        self.participate_with_roster_version(db, event_id, user_id, req)
            .await
            .map(|(detail, _)| detail)
    }

    /// Registers a user and returns the post-commit roster revision for realtime delivery.
    pub async fn participate_with_roster_version(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        user_id: i64,
        req: ParticipateEventRequest,
    ) -> Result<(EventDetailView, i64), AppError> {
        self.apply_participation(
            db,
            event_id,
            user_id,
            req.primary_build_id,
            req.secondary_build_id,
        )
        .await
    }

    /// Adds an existing member to an event on behalf of the member making the request.
    ///
    /// This is the service entry point for the admin `Add a Member` action. It deliberately
    /// delegates to the same participation pipeline as self-service signup, so build membership,
    /// slot capacity, comp expansion, roster versioning, and XP idempotency cannot diverge.
    pub async fn add_member_with_roster_version(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        request: AddEventMemberRequest,
    ) -> Result<(EventDetailView, i64), AppError> {
        let target_user_id = request.user_id;
        let payload = super::models::SetParticipantRequest {
            primary_build_id: request.primary_build_id,
            secondary_build_id: request.secondary_build_id,
        };
        self.set_participant_with_roster_version(db, event_id, target_user_id, payload)
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
        self.set_participant_with_roster_version(db, event_id, target_user_id, req)
            .await
            .map(|(detail, _)| detail)
    }

    /// Sets participation and returns the post-commit roster revision for realtime delivery.
    pub async fn set_participant_with_roster_version(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        target_user_id: i64,
        req: super::models::SetParticipantRequest,
    ) -> Result<(EventDetailView, i64), AppError> {
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
    /// build existence, roster membership and primary slot availability.
    ///
    /// Shared by both the self-service `participate` and the officer-driven
    /// `set_participant` so the rules never drift between the two paths.
    async fn apply_participation(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        user_id: i64,
        primary_build_id: Option<i64>,
        secondary_build_id: Option<i64>,
    ) -> Result<(EventDetailView, i64), AppError> {
        // Validate event exists
        let event_model = event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        reject_if_event_archived(&event_model)?;

        if event_model.status == "cancelled" {
            return Err(AppError::Conflict(format!("Event {event_id} is cancelled")));
        }

        // A missing primary build is the virtual, unlimited Fill role. Concrete build IDs remain
        // validated exactly as before.
        if let Some(primary_build_id) = primary_build_id {
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

        // Fill does not claim a particular build slot, but every participant represents a player
        // who may require the next comp expansion. Updating an existing signup keeps the roster
        // size unchanged; a new signup grows it by one.
        let target_size = comp_resolution_target(
            current_participations.len() + usize::from(is_new),
            event_model.player_cap,
        );

        let extra_roster_roles = event_roster_role::Entity::find()
            .filter(event_roster_role::Column::EventId.eq(event_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let extra_roster_build_ids: HashSet<i64> = extra_roster_roles
            .iter()
            .map(|role| role.build_id)
            .collect();

        // Each persisted extra role adds one primary slot when selecting a comp variant.
        let (active_comp, _) = self
            .resolve_active_comp_with_extra_slots(
                db,
                event_model.comp_id,
                target_size,
                extra_roster_build_ids.len(),
                event_model.player_cap,
            )
            .await?;

        // Fetch comp builds for active comp to validate build selections.
        let active_comp_builds = comp_build::Entity::find()
            .filter(comp_build::Column::CompId.eq(active_comp.id))
            .all(db)
            .await
            .map_err(AppError::Database)?;

        // Fill does not consume a build slot. A concrete primary build remains constrained by the
        // resolved comp and event-specific extra roster roles.
        if let Some(primary_build_id) = primary_build_id {
            let comp_primary_slots = active_comp_builds
                .iter()
                .find(|cb| cb.build_id == primary_build_id)
                .map_or(0, |comp_build| comp_build.quantity as usize);
            let extra_primary_slots =
                usize::from(extra_roster_build_ids.contains(&primary_build_id));
            let primary_slot_limit = comp_primary_slots + extra_primary_slots;
            if primary_slot_limit == 0 {
                return Err(AppError::Validation(format!(
                    "Primary build {primary_build_id} is not allowed in comp {} or its extra roster roles",
                    active_comp.name
                )));
            }

            // A signup is a reservation until an officer assigns that player to a
            // concrete seat. Once assigned, the seat is authoritative: if the
            // officer moves the player from X to Y, X must become available again.
            let assignments = event_roster_assignment::Entity::find()
                .filter(event_roster_assignment::Column::EventId.eq(event_id))
                .all(db)
                .await
                .map_err(AppError::Database)?;
            let assigned_build_by_user: HashMap<i64, i64> = assignments
                .into_iter()
                .filter_map(|assignment| {
                    let mut parts = assignment.seat_key.split(':');
                    (parts.next() == Some("build"))
                        .then(|| parts.next()?.parse::<i64>().ok())
                        .flatten()
                        .map(|build_id| (assignment.user_id, build_id))
                })
                .collect();
            let taken_count = current_participations
                .iter()
                .filter(|p| p.user_id != user_id)
                .filter(|p| {
                    assigned_build_by_user
                        .get(&p.user_id)
                        .copied()
                        .or(p.primary_build_id)
                        == Some(primary_build_id)
                })
                .count();
            if taken_count >= primary_slot_limit {
                return Err(AppError::Validation(format!(
                    "The primary role for build '{primary_build_id}' is already full (limit: {primary_slot_limit})"
                )));
            }
        }

        // Secondary builds do not consume a primary slot, but must be available from either source.
        if let Some(sec_id) = secondary_build_id {
            let in_active_comp = active_comp_builds.iter().any(|cb| cb.build_id == sec_id);
            if !in_active_comp && !extra_roster_build_ids.contains(&sec_id) {
                return Err(AppError::Validation(format!(
                    "Secondary build {sec_id} is not allowed in comp {} or its extra roster roles",
                    active_comp.name
                )));
            }
        }

        // Persist the participation and its roster invalidation atomically. Locking the
        // event row here serializes concurrent sign-ups for the same event, so the
        // build-slot capacity re-check right below can't race with another
        // transaction that read the same pre-insert count (TOCTOU on the last slot).
        let txn = db.begin().await.map_err(AppError::Database)?;
        event::Entity::find_by_id(event_id)
            .lock_exclusive()
            .one(&txn)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;

        if let Some(primary_build_id) = primary_build_id {
            let comp_primary_slots = active_comp_builds
                .iter()
                .find(|cb| cb.build_id == primary_build_id)
                .map_or(0, |comp_build| comp_build.quantity as usize);
            let extra_primary_slots =
                usize::from(extra_roster_build_ids.contains(&primary_build_id));
            let primary_slot_limit = comp_primary_slots + extra_primary_slots;

            let fresh_participations = event_participation::Entity::find()
                .filter(event_participation::Column::EventId.eq(event_id))
                .all(&txn)
                .await
                .map_err(AppError::Database)?;
            let fresh_assignments = event_roster_assignment::Entity::find()
                .filter(event_roster_assignment::Column::EventId.eq(event_id))
                .all(&txn)
                .await
                .map_err(AppError::Database)?;
            let fresh_assigned_build_by_user = assigned_builds_by_user(fresh_assignments);
            let taken_count = fresh_participations
                .iter()
                .filter(|p| p.user_id != user_id)
                .filter(|p| {
                    fresh_assigned_build_by_user
                        .get(&p.user_id)
                        .copied()
                        .or(p.primary_build_id)
                        == Some(primary_build_id)
                })
                .count();
            if taken_count >= primary_slot_limit {
                return Err(AppError::Validation(format!(
                    "The primary role for build '{primary_build_id}' is already full (limit: {primary_slot_limit})"
                )));
            }
        }

        if let Some(p) = existing {
            let mut active: event_participation::ActiveModel = p.clone().into();
            active.primary_build_id = Set(primary_build_id);
            active.secondary_build_id = Set(secondary_build_id);
            active.updated_at = Set(chrono::Utc::now().into());
            active.update(&txn).await.map_err(AppError::Database)?;
        } else {
            event_participation::ActiveModel {
                event_id: Set(event_id),
                user_id: Set(user_id),
                primary_build_id: Set(primary_build_id),
                secondary_build_id: Set(secondary_build_id),
                ..Default::default()
            }
            .insert(&txn)
            .await
            .map_err(AppError::Database)?;
        }
        event::Entity::update_many()
            .col_expr(
                event::Column::RosterVersion,
                Expr::col(event::Column::RosterVersion).add(1),
            )
            .filter(event::Column::Id.eq(event_id))
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
        let roster_version = event::Entity::find_by_id(event_id)
            .one(&txn)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?
            .roster_version;
        txn.commit().await.map_err(AppError::Database)?;

        // A linked split mirrors event sign-ups, including late joiners.
        SplitService::new()
            .sync_event_participants(db, event_id)
            .await?;

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

        Ok((self.get_event_detail(db, event_id).await?, roster_version))
    }

    /// Cancels user participation.
    pub async fn cancel_participation(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        user_id: i64,
    ) -> Result<(EventDetailView, i64, Option<String>), AppError> {
        let model = event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
        reject_if_event_archived(&model)?;
        let txn = db.begin().await.map_err(AppError::Database)?;
        let assignment = event_roster_assignment::Entity::find()
            .filter(event_roster_assignment::Column::EventId.eq(event_id))
            .filter(event_roster_assignment::Column::UserId.eq(user_id))
            .one(&txn)
            .await
            .map_err(AppError::Database)?;
        event_roster_assignment::Entity::delete_many()
            .filter(event_roster_assignment::Column::EventId.eq(event_id))
            .filter(event_roster_assignment::Column::UserId.eq(user_id))
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
        let deleted = event_participation::Entity::delete_many()
            .filter(event_participation::Column::EventId.eq(event_id))
            .filter(event_participation::Column::UserId.eq(user_id))
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
        if deleted.rows_affected == 0 {
            return Err(AppError::NotFound(format!(
                "User {user_id} is not registered for event {event_id}"
            )));
        }
        event::Entity::update_many()
            .col_expr(
                event::Column::RosterVersion,
                Expr::col(event::Column::RosterVersion).add(1),
            )
            .filter(event::Column::Id.eq(event_id))
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
        let roster_version = event::Entity::find_by_id(event_id)
            .one(&txn)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?
            .roster_version;
        txn.commit().await.map_err(AppError::Database)?;
        SplitService::new()
            .sync_event_participants(db, event_id)
            .await?;
        Ok((
            self.get_event_detail(db, event_id).await?,
            roster_version,
            assignment.map(|row| row.seat_key),
        ))
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
    use crate::modules::events::models::EventFilters;
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

    /// A fixed timestamp; the values are irrelevant to these assertions.
    fn ts() -> sea_orm::prelude::DateTimeWithTimeZone {
        chrono::Utc::now().into()
    }

    /// Seeds a member with a linked Albion character, so battle rows can be matched to them.
    async fn insert_linked_member(
        db: &DatabaseConnection,
        username: &str,
        albion_name: &str,
    ) -> i64 {
        let user = UserActiveModel {
            username: Set(username.to_string()),
            email: Set(format!("{username}@example.com")),
            role: Set("User".to_string()),
            discord_id: Set(Some(format!("discord-{username}"))),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert member")
        .id;

        crate::modules::albion::entities::albion_link::ActiveModel {
            discord_id: Set(format!("discord-{username}")),
            albion_player_id: Set(format!("albion-{username}")),
            albion_player_name: Set(albion_name.to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to link the member");
        user
    }

    /// Seeds an event, a battle and the snapshot that battle's per-player rows come from.
    #[allow(clippy::too_many_arguments)]
    async fn insert_battle_with_players(
        db: &DatabaseConnection,
        event_id: i64,
        battle_id: i64,
        is_win: bool,
        players: &[(&str, i64, i64)],
    ) {
        event_battle::ActiveModel {
            event_id: Set(event_id),
            albionbb_battle_id: Set(battle_id.to_string()),
            battle_started_at: Set(ts()),
            guild_players_count: Set(players.len() as i32),
            fetched_at: Set(ts()),
            guild_kills: Set(players.iter().map(|(_, kills, _)| kills).sum()),
            guild_deaths: Set(players.iter().map(|(_, _, deaths)| deaths).sum()),
            guild_kill_fame: Set(0),
            is_win: Set(is_win),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert the battle");

        let players_json = serde_json::to_string(
            &players
                .iter()
                .map(|(name, kills, deaths)| {
                    serde_json::json!({
                        "id": *name,
                        "name": *name,
                        "guild_id": "g",
                        "guild_name": "Weaklings",
                        "kills": kills,
                        "deaths": deaths,
                        "kill_fame": kills * 1000,
                        "death_fame": deaths * 500,
                        "item_power": 1300.0
                    })
                })
                .collect::<Vec<_>>(),
        )
        .expect("failed to serialize the players");

        crate::modules::battles::entities::ActiveModel {
            battle_id: Set(battle_id),
            start_time: Set(ts()),
            end_time: Set(None),
            total_players: Set(players.len() as i64),
            total_kills: Set(players.iter().map(|(_, kills, _)| kills).sum()),
            total_fame: Set(0),
            guilds_json: Set("[]".to_string()),
            players_json: Set(players_json),
            kills_json: Set("[]".to_string()),
            losses_json: Set(serde_json::to_string(&BattleLossEstimate::default())
                .expect("failed to serialize empty loss estimate")),
            fetched_at: Set(ts()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert the battle snapshot");
    }

    /// A minimal event owned by `creator`, enough to hang sign-ups and battles off.
    async fn insert_event(db: &DatabaseConnection, title: &str, creator: i64) -> i64 {
        let comp_category = create_comp_category(db, &format!("cat-{title}")).await;
        let comp_id = create_comp(db, title, comp_category, None, Vec::new()).await;
        event::ActiveModel {
            title: Set(title.to_string()),
            comp_id: Set(comp_id),
            created_by: Set(creator),
            event_date_utc: Set(ts()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert the event")
        .id
    }

    #[tokio::test]
    async fn archiving_an_event_hides_it_and_archives_linked_splits() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let event_id = insert_event(&db, "Archive me", author).await;
        crate::modules::splits::entities::split::ActiveModel {
            created_by: Set(author),
            status: Set("pending".to_string()),
            estimated_market_value: Set("100.00".parse().unwrap()),
            fee: Set("20.00".parse().unwrap()),
            repair_value: Set("0.00".parse().unwrap()),
            bags_value: Set("0.00".parse().unwrap()),
            event_id: Set(Some(event_id)),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("linked split");

        let service = EventService::new();
        let archived = service.archive_event(&db, event_id).await.unwrap();
        assert!(archived.archived_at.is_some());
        assert_eq!(
            event::Entity::find_by_id(event_id)
                .one(&db)
                .await
                .unwrap()
                .expect("event row must remain")
                .title,
            "Archive me"
        );

        let active = service
            .list_events(
                &db,
                PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                EventFilters::default(),
            )
            .await
            .unwrap();
        assert!(active.items.iter().all(|item| item.id != event_id));

        let hidden = service
            .list_events(
                &db,
                PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                EventFilters {
                    archived: Some(true),
                    ..EventFilters::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(hidden.items.len(), 1);
        assert_eq!(hidden.items[0].id, event_id);

        let split = crate::modules::splits::entities::split::Entity::find()
            .filter(crate::modules::splits::entities::split::Column::EventId.eq(event_id))
            .one(&db)
            .await
            .unwrap()
            .expect("split row must remain");
        assert!(split.archived_at.is_some());
        assert_eq!(split.event_id, Some(event_id));
    }

    #[tokio::test]
    async fn unarchiving_an_event_restores_linked_splits() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let event_id = insert_event(&db, "Bring back", author).await;
        crate::modules::splits::entities::split::ActiveModel {
            created_by: Set(author),
            status: Set("pending".to_string()),
            estimated_market_value: Set("10.00".parse().unwrap()),
            fee: Set("20.00".parse().unwrap()),
            repair_value: Set("0.00".parse().unwrap()),
            bags_value: Set("0.00".parse().unwrap()),
            event_id: Set(Some(event_id)),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("linked split");
        let service = EventService::new();
        service.archive_event(&db, event_id).await.unwrap();
        let restored = service.unarchive_event(&db, event_id).await.unwrap();
        assert!(restored.archived_at.is_none());
        let split = crate::modules::splits::entities::split::Entity::find()
            .filter(crate::modules::splits::entities::split::Column::EventId.eq(event_id))
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert!(split.archived_at.is_none());
    }

    async fn sign_up(db: &DatabaseConnection, event_id: i64, user_id: i64, build_id: i64) {
        event_participation::ActiveModel {
            event_id: Set(event_id),
            user_id: Set(user_id),
            primary_build_id: Set(Some(build_id)),
            secondary_build_id: Set(None),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to sign the member up");
    }

    #[tokio::test]
    async fn participation_allows_an_extra_roster_build_once_beyond_comp_capacity() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let first_user = insert_user(&db, "first", "first@example.com").await;
        let second_user = insert_user(&db, "second", "second@example.com").await;
        let third_user = insert_user(&db, "third", "third@example.com").await;
        let build_category = create_build_category(&db, "Roster builds").await;
        let comp_build_id = create_build(&db, "Main Tank", build_category).await;
        let extra_build_id = create_build(&db, "Reserve Healer", build_category).await;
        let comp_category = create_comp_category(&db, "Roster comps").await;
        let comp_id = create_comp(
            &db,
            "One-slot comp",
            comp_category,
            None,
            vec![(comp_build_id, 1)],
        )
        .await;
        let event_id = event::ActiveModel {
            title: Set("Roster event".to_string()),
            comp_id: Set(comp_id),
            created_by: Set(author),
            event_date_utc: Set(ts()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("event should be created")
        .id;
        let service = EventService::new();
        service
            .create_event_roster_role(
                &db,
                event_id,
                CreateEventRosterRoleRequest {
                    build_id: extra_build_id,
                },
            )
            .await
            .expect("extra role should be created");

        service
            .apply_participation(
                &db,
                event_id,
                first_user,
                Some(comp_build_id),
                Some(extra_build_id),
            )
            .await
            .expect("comp build and extra secondary should be allowed");
        service
            .apply_participation(&db, event_id, second_user, Some(extra_build_id), None)
            .await
            .expect("one extra primary slot should be allowed beyond comp capacity");

        assert!(matches!(
            service
                .apply_participation(&db, event_id, third_user, Some(extra_build_id), None)
                .await,
            Err(AppError::Validation(message)) if message.contains("already full")
        ));
    }

    #[tokio::test]
    async fn admin_add_member_uses_the_participation_invariants() {
        let db = seed_db().await;
        let creator = insert_user(&db, "creator", "creator@example.com").await;
        let member = insert_user(&db, "member", "member@example.com").await;
        let second_member = insert_user(&db, "second", "second@example.com").await;
        let build_category = create_build_category(&db, "Roster builds").await;
        let build_id = create_build(&db, "Main Tank", build_category).await;
        let unrelated_build = create_build(&db, "Unrelated Healer", build_category).await;
        let comp_category = create_comp_category(&db, "Roster comps").await;
        let comp_id = create_comp(
            &db,
            "One-slot comp",
            comp_category,
            None,
            vec![(build_id, 1)],
        )
        .await;
        let event_id = event::ActiveModel {
            title: Set("Admin add event".to_string()),
            comp_id: Set(comp_id),
            created_by: Set(creator),
            event_date_utc: Set(ts()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("event should be created")
        .id;
        let service = EventService::new();

        let (detail, version) = service
            .add_member_with_roster_version(
                &db,
                event_id,
                AddEventMemberRequest {
                    user_id: member,
                    primary_build_id: Some(build_id),
                    secondary_build_id: None,
                },
            )
            .await
            .expect("admin should be able to add a valid member");
        assert_eq!(version, 1);
        assert_eq!(detail.participants.len(), 1);
        assert_eq!(detail.participants[0].user_id, member);

        let rejected = service
            .add_member_with_roster_version(
                &db,
                event_id,
                AddEventMemberRequest {
                    user_id: second_member,
                    primary_build_id: Some(unrelated_build),
                    secondary_build_id: None,
                },
            )
            .await;
        assert!(
            matches!(rejected, Err(AppError::Validation(message)) if message.contains("not allowed"))
        );
        assert_eq!(
            service
                .get_event_detail(&db, event_id)
                .await
                .expect("event should load")
                .participants
                .len(),
            1
        );

        let rejected_full = service
            .add_member_with_roster_version(
                &db,
                event_id,
                AddEventMemberRequest {
                    user_id: second_member,
                    primary_build_id: Some(build_id),
                    secondary_build_id: None,
                },
            )
            .await;
        assert!(
            matches!(rejected_full, Err(AppError::Validation(message)) if message.contains("already full"))
        );
    }

    #[tokio::test]
    async fn signup_options_use_the_prospective_comp_without_double_counting_members() {
        let db = seed_db().await;
        let author = insert_user(&db, "author", "author@example.com").await;
        let build_category = create_build_category(&db, "Roster builds").await;
        let base_build = create_build(&db, "Base DPS", build_category).await;
        let expansion_build = create_build(&db, "Expansion Tank", build_category).await;
        let comp_category = create_comp_category(&db, "Roster comps").await;
        let base = create_comp(&db, "10-man", comp_category, None, vec![(base_build, 10)]).await;
        let expansion = create_comp(
            &db,
            "15-man",
            comp_category,
            Some(base),
            vec![(base_build, 10), (expansion_build, 5)],
        )
        .await;
        let event_id = event::ActiveModel {
            title: Set("Signup options event".to_string()),
            comp_id: Set(base),
            created_by: Set(author),
            event_date_utc: Set(ts()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("event should be created")
        .id;

        let mut existing_member = None;
        for number in 0..10 {
            let member = insert_user(
                &db,
                &format!("member-{number}"),
                &format!("member-{number}@example.com"),
            )
            .await;
            sign_up(&db, event_id, member, base_build).await;
            if number == 0 {
                existing_member = Some(member);
            }
        }
        let prospective_member = insert_user(&db, "next", "next@example.com").await;
        let service = EventService::new();

        let options = service
            .get_event_signup_options(&db, event_id, prospective_member)
            .await
            .expect("a new concrete signup should resolve the expansion tier");
        assert_eq!(options.active_comp_id, expansion);
        assert_eq!(options.active_comp_capacity, 15);
        assert!(
            options
                .builds
                .iter()
                .any(|build| build.build_id == expansion_build)
        );
        assert!(!options.is_already_registered);

        let existing_options = service
            .get_event_signup_options(
                &db,
                event_id,
                existing_member.expect("existing member should be captured"),
            )
            .await
            .expect("an existing member must not force the next tier");
        assert_eq!(existing_options.active_comp_id, expansion);
        assert_eq!(existing_options.active_comp_capacity, 15);
        assert!(existing_options.is_already_registered);
    }

    #[tokio::test]
    async fn resolves_the_smallest_sufficient_comp_across_an_expansion_chain() {
        let db = seed_db().await;
        let _author = insert_user(&db, "author", "author@example.com").await;
        let build_category = create_build_category(&db, "Roster builds").await;
        let build_id = create_build(&db, "Main Tank", build_category).await;
        let comp_category = create_comp_category(&db, "Roster comps").await;
        let base = create_comp(&db, "10-man", comp_category, None, vec![(build_id, 10)]).await;
        let expansion = create_comp(
            &db,
            "15-man",
            comp_category,
            Some(base),
            vec![(build_id, 15)],
        )
        .await;
        let final_expansion = create_comp(
            &db,
            "20-man",
            comp_category,
            Some(expansion),
            vec![(build_id, 20)],
        )
        .await;
        let service = EventService::new();

        for (target_size, expected_id, expected_capacity) in [
            (7, expansion, 15),
            (10, expansion, 15),
            (11, final_expansion, 20),
            (16, final_expansion, 20),
            (21, final_expansion, 20),
        ] {
            let (active, capacity) = service
                .resolve_active_comp(&db, base, target_size)
                .await
                .expect("the chain should always resolve to the smallest sufficient comp or its final tier");
            assert_eq!(
                active.id, expected_id,
                "wrong comp for {target_size} concrete signups"
            );
            assert_eq!(capacity, expected_capacity);
        }

        // An event configured directly on the middle tier must still follow its own child chain.
        let (active, capacity) = service
            .resolve_active_comp(&db, expansion, 11)
            .await
            .expect("a middle-tier event should resolve its next expansion");
        assert_eq!(active.id, final_expansion);
        assert_eq!(capacity, 20);
    }

    #[tokio::test]
    async fn ignores_legacy_non_growing_or_cyclic_expansion_links() {
        let db = seed_db().await;
        let _author = insert_user(&db, "author", "author@example.com").await;
        let build_category = create_build_category(&db, "Roster builds").await;
        let build_id = create_build(&db, "Main Tank", build_category).await;
        let comp_category = create_comp_category(&db, "Roster comps").await;
        let base = create_comp(&db, "10-man", comp_category, None, vec![(build_id, 10)]).await;
        let invalid_child = create_comp(
            &db,
            "5-man legacy",
            comp_category,
            Some(base),
            vec![(build_id, 5)],
        )
        .await;
        let hidden_grandchild = create_comp(
            &db,
            "20-man behind invalid link",
            comp_category,
            Some(invalid_child),
            vec![(build_id, 20)],
        )
        .await;
        let cyclic_child = create_comp(
            &db,
            "15-man legacy",
            comp_category,
            Some(base),
            vec![(build_id, 15)],
        )
        .await;
        let base_model = comp::Entity::find_by_id(base)
            .one(&db)
            .await
            .expect("base should load")
            .expect("base should exist");
        let mut base_active: comp::ActiveModel = base_model.into();
        base_active.parent_id = Set(Some(cyclic_child));
        base_active
            .update(&db)
            .await
            .expect("legacy cycle should be seeded");

        let (active, capacity) = EventService::new()
            .resolve_active_comp(&db, base, 16)
            .await
            .expect("a cyclic legacy chain must not loop or fail resolution");

        assert_eq!(active.id, cyclic_child);
        assert_eq!(capacity, 15);
        assert_ne!(active.id, hidden_grandchild);
    }

    #[tokio::test]
    async fn fill_participation_is_unlimited_and_does_not_consume_a_build_slot() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let member = insert_user(&db, "member", "member@example.com").await;
        let build_category = create_build_category(&db, "Roster builds").await;
        let build_id = create_build(&db, "Main Tank", build_category).await;
        let comp_category = create_comp_category(&db, "Roster comps").await;
        let comp_id = create_comp(
            &db,
            "One-slot comp",
            comp_category,
            None,
            vec![(build_id, 1)],
        )
        .await;
        let event_id = event::ActiveModel {
            title: Set("Fill event".to_string()),
            comp_id: Set(comp_id),
            created_by: Set(author),
            event_date_utc: Set(ts()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("event should be created")
        .id;

        let detail = EventService::new()
            .participate(
                &db,
                event_id,
                member,
                ParticipateEventRequest {
                    primary_build_id: None,
                    secondary_build_id: None,
                },
            )
            .await
            .expect("Fill should be accepted without a build");

        assert_eq!(detail.participants.len(), 1);
        assert_eq!(detail.participants[0].primary_build_id, None);
        assert_eq!(detail.participants[0].primary_build_name, "Fill");
        assert_eq!(detail.comp_builds.len(), 1);
        assert_eq!(detail.comp_builds[0].build_id, build_id);
        assert_eq!(detail.comp_builds[0].quantity, 1);

        let regular_member = insert_user(&db, "regular", "regular@example.com").await;
        EventService::new()
            .participate(
                &db,
                event_id,
                regular_member,
                ParticipateEventRequest {
                    primary_build_id: Some(build_id),
                    secondary_build_id: None,
                },
            )
            .await
            .expect("Fill must not consume the one available build slot");

        assert!(matches!(
            EventService::new()
                .participate(
                    &db,
                    event_id,
                    member,
                    ParticipateEventRequest {
                        primary_build_id: Some(build_id),
                        secondary_build_id: None,
                    },
                )
                .await,
            Err(AppError::Validation(message)) if message.contains("full")
        ));

        EventService::new()
            .participate(
                &db,
                event_id,
                regular_member,
                ParticipateEventRequest {
                    primary_build_id: None,
                    secondary_build_id: None,
                },
            )
            .await
            .expect("changing a build assignment to Fill should release its slot");
        let detail = EventService::new()
            .participate(
                &db,
                event_id,
                member,
                ParticipateEventRequest {
                    primary_build_id: Some(build_id),
                    secondary_build_id: None,
                },
            )
            .await
            .expect("changing Fill to a build should claim an available slot");
        assert_eq!(detail.participants.len(), 2);
    }

    #[tokio::test]
    async fn fill_participants_advance_the_comp_expansion_without_claiming_build_slots() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let first_fill = insert_user(&db, "first-fill", "first-fill@example.com").await;
        let second_fill = insert_user(&db, "second-fill", "second-fill@example.com").await;
        let concrete_member = insert_user(&db, "concrete", "concrete@example.com").await;
        let build_category = create_build_category(&db, "Roster builds").await;
        let build_id = create_build(&db, "Main Tank", build_category).await;
        let comp_category = create_comp_category(&db, "Roster comps").await;
        let base = create_comp(
            &db,
            "One-player comp",
            comp_category,
            None,
            vec![(build_id, 1)],
        )
        .await;
        let expansion = create_comp(
            &db,
            "Two-player comp",
            comp_category,
            Some(base),
            vec![(build_id, 2)],
        )
        .await;
        let event_id = event::ActiveModel {
            title: Set("Fill expansion event".to_string()),
            comp_id: Set(base),
            created_by: Set(author),
            event_date_utc: Set(ts()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("event should be created")
        .id;
        let service = EventService::new();

        let first_detail = service
            .participate(
                &db,
                event_id,
                first_fill,
                ParticipateEventRequest {
                    primary_build_id: None,
                    secondary_build_id: None,
                },
            )
            .await
            .expect("first Fill should be accepted");
        assert_eq!(first_detail.active_comp_id, expansion);

        let signup_options = service
            .get_event_signup_options(&db, event_id, concrete_member)
            .await
            .expect("the next member should see the expansion comp before choosing a build");
        assert_eq!(signup_options.active_comp_id, expansion);

        let second_detail = service
            .participate(
                &db,
                event_id,
                second_fill,
                ParticipateEventRequest {
                    primary_build_id: None,
                    secondary_build_id: None,
                },
            )
            .await
            .expect("second Fill should activate the expansion");
        assert_eq!(second_detail.active_comp_id, expansion);

        service
            .participate(
                &db,
                event_id,
                concrete_member,
                ParticipateEventRequest {
                    primary_build_id: Some(build_id),
                    secondary_build_id: None,
                },
            )
            .await
            .expect("Fill participants must not claim the build slot");
    }

    #[tokio::test]
    async fn event_roster_roles_always_include_fill_and_prevent_duplicate_builds() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let event_id = insert_event(&db, "Roster event", author).await;
        let category = create_build_category(&db, "Roster builds").await;
        let build_id = create_build(&db, "Siege Bow", category).await;
        let service = EventService::new();

        assert!(matches!(
            service.list_event_roster_roles(&db, event_id).await,
            Ok(roles) if roles.len() == 1
                && roles[0].is_fill
                && roles[0].name == "Fill"
                && roles[0].id.is_none()
                && roles[0].build_id.is_none()
        ));

        let added = service
            .create_event_roster_role(&db, event_id, CreateEventRosterRoleRequest { build_id })
            .await
            .expect("existing build should be added as a roster role");
        assert_eq!(added.build_id, Some(build_id));
        assert!(!added.is_fill);

        assert!(matches!(
            service
                .create_event_roster_role(&db, event_id, CreateEventRosterRoleRequest { build_id })
                .await,
            Err(AppError::Conflict(_))
        ));

        let roles = service
            .list_event_roster_roles(&db, event_id)
            .await
            .expect("roster roles should list");
        assert!(roles[0].is_fill);
        assert_eq!(roles[1].id, added.id);

        service
            .delete_event_roster_role(&db, event_id, added.id.expect("persisted role id"))
            .await
            .expect("extra role should be removed");
        assert_eq!(
            service
                .list_event_roster_roles(&db, event_id)
                .await
                .expect("Fill should remain after removing an extra role")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn build_performance_separates_two_versions_of_the_same_build() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let category = create_build_category(&db, "Crystal").await;
        let v1 = create_build(&db, "Pole Hammer", category).await;
        let v2 = BuildActiveModel {
            name: Set("Pole Hammer".to_string()),
            role: Set("dps".to_string()),
            category_id: Set(category),
            version: Set(2),
            created_by: Set(author),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("failed to insert v2")
        .id;

        let alice = insert_linked_member(&db, "alice", "Alice").await;
        let bob = insert_linked_member(&db, "bob", "Bob").await;
        let first = insert_event(&db, "Night one", author).await;
        let second = insert_event(&db, "Night two", author).await;
        sign_up(&db, first, alice, v1).await;
        sign_up(&db, second, bob, v2).await;
        insert_battle_with_players(&db, first, 1001, true, &[("Alice", 7, 1)]).await;
        insert_battle_with_players(&db, second, 1002, false, &[("Bob", 2, 3)]).await;

        let service = EventService::new();
        let first_stats = service
            .get_build_performance(&db, v1)
            .await
            .unwrap()
            .stats
            .expect("v1 has battle data");
        let second_stats = service
            .get_build_performance(&db, v2)
            .await
            .unwrap()
            .stats
            .expect("v2 has battle data");

        assert_eq!((first_stats.kills, first_stats.deaths), (7, 1));
        assert_eq!((second_stats.kills, second_stats.deaths), (2, 3));
        assert_eq!((first_stats.wins, first_stats.losses), (1, 0));
        assert_eq!((second_stats.wins, second_stats.losses), (0, 1));
    }

    #[tokio::test]
    async fn build_performance_counts_only_the_players_who_ran_that_build() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let category = create_build_category(&db, "Crystal").await;
        let hammer = create_build(&db, "Pole Hammer", category).await;
        let axe = create_build(&db, "Great Axe", category).await;

        let alice = insert_linked_member(&db, "alice", "Alice").await;
        let bob = insert_linked_member(&db, "bob", "Bob").await;
        let event = insert_event(&db, "One fight", author).await;
        sign_up(&db, event, alice, hammer).await;
        sign_up(&db, event, bob, axe).await;
        // Both fought in the same battle, so an event-level metric would score them identically.
        insert_battle_with_players(&db, event, 2001, true, &[("Alice", 9, 0), ("Bob", 1, 2)]).await;

        let service = EventService::new();
        let hammer_stats = service
            .get_build_performance(&db, hammer)
            .await
            .unwrap()
            .stats
            .unwrap();
        let axe_stats = service
            .get_build_performance(&db, axe)
            .await
            .unwrap()
            .stats
            .unwrap();

        assert_eq!((hammer_stats.kills, hammer_stats.deaths), (9, 0));
        assert_eq!((axe_stats.kills, axe_stats.deaths), (1, 2));
        assert_eq!(hammer_stats.matched_players, 1);
    }

    #[tokio::test]
    async fn build_performance_reports_the_members_it_could_not_match() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let category = create_build_category(&db, "Crystal").await;
        let hammer = create_build(&db, "Pole Hammer", category).await;

        let alice = insert_linked_member(&db, "alice", "Alice").await;
        let unlinked = insert_user(&db, "carol", "carol@example.com").await;
        let event = insert_event(&db, "One fight", author).await;
        sign_up(&db, event, alice, hammer).await;
        sign_up(&db, event, unlinked, hammer).await;
        insert_battle_with_players(&db, event, 3001, true, &[("Alice", 4, 0), ("Carol", 6, 0)])
            .await;

        let performance = EventService::new()
            .get_build_performance(&db, hammer)
            .await
            .unwrap();

        assert_eq!(
            performance.players_without_an_albion_link, 1,
            "a member with no Albion link cannot be matched and must be reported"
        );
        let stats = performance.stats.unwrap();
        assert_eq!(
            stats.kills, 4,
            "the unlinked member's kills are not attributable, so they are excluded"
        );
        assert_eq!(stats.matched_players, 1);
    }

    #[tokio::test]
    async fn build_performance_distinguishes_never_used_from_lost_every_time() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let category = create_build_category(&db, "Crystal").await;
        let unused = create_build(&db, "Pole Hammer", category).await;
        let lost = create_build(&db, "Great Axe", category).await;

        let alice = insert_linked_member(&db, "alice", "Alice").await;
        let event = insert_event(&db, "A loss", author).await;
        sign_up(&db, event, alice, lost).await;
        insert_battle_with_players(&db, event, 4001, false, &[("Alice", 0, 1)]).await;

        let service = EventService::new();
        let never_used = service.get_build_performance(&db, unused).await.unwrap();
        let lost_stats = service.get_build_performance(&db, lost).await.unwrap();

        assert!(
            never_used.stats.is_none(),
            "a build nobody ran must not read as a 0% win rate"
        );
        assert_eq!(never_used.signups_as_primary, 0);
        assert_eq!(lost_stats.stats.unwrap().losses, 1);
    }

    #[tokio::test]
    async fn event_detail_seeds_exactly_one_fight_for_each_linked_battle() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let event_id = insert_event(&db, "Canonical fight", author).await;
        insert_battle_with_players(&db, event_id, 425_654_502, true, &[("Alice", 2, 1)]).await;

        EventService::new()
            .get_event_detail(&db, event_id)
            .await
            .expect("event detail should seed its canonical fight");
        EventService::new()
            .get_event_detail(&db, event_id)
            .await
            .expect("seeding must be idempotent");

        let segment = fight_battle::Entity::find()
            .filter(fight_battle::Column::BattleId.eq(425_654_502))
            .one(&db)
            .await
            .expect("fight segment query should succeed")
            .expect("linked battle should have one fight segment");
        let seeded_fight = fight::Entity::find_by_id(segment.fight_id)
            .one(&db)
            .await
            .expect("fight query should succeed")
            .expect("fight segment must reference an existing fight");

        assert_eq!(seeded_fight.event_id, Some(event_id));
        assert_eq!(
            fight_battle::Entity::find()
                .filter(fight_battle::Column::BattleId.eq(425_654_502))
                .count(&db)
                .await
                .expect("fight segment count should succeed"),
            1
        );
    }

    #[tokio::test]
    async fn event_detail_automatically_groups_matching_battle_segments() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let event_id = insert_event(&db, "Long engagement", author).await;
        let first_battle_id = 425_654_505;
        let second_battle_id = 425_654_506;
        insert_battle_with_players(&db, event_id, first_battle_id, true, &[("Alice", 3, 1)]).await;
        insert_battle_with_players(&db, event_id, second_battle_id, true, &[("Alice", 2, 0)]).await;

        let guilds = serde_json::to_string(&[
            BattleGuildSummary {
                id: "weaklings-id".to_string(),
                name: "Weaklings".to_string(),
                alliance_name: None,
                alliance_id: None,
                players: 14,
                kills: 5,
                deaths: 1,
                kill_fame: 1_000_000,
                winner: true,
                average_item_power: 1_400.0,
            },
            BattleGuildSummary {
                id: "opponent-id".to_string(),
                name: "Black Order".to_string(),
                alliance_name: None,
                alliance_id: None,
                players: 18,
                kills: 1,
                deaths: 5,
                kill_fame: 500_000,
                winner: false,
                average_item_power: 1_390.0,
            },
        ])
        .expect("guild snapshot should serialize");
        for battle_id in [first_battle_id, second_battle_id] {
            let snapshot = GuildBattleSnapshotEntity::find()
                .filter(GuildBattleSnapshotColumn::BattleId.eq(battle_id))
                .one(&db)
                .await
                .expect("snapshot query should succeed")
                .expect("snapshot should exist");
            let mut snapshot: crate::modules::battles::entities::ActiveModel = snapshot.into();
            snapshot.guilds_json = Set(guilds.clone());
            snapshot.end_time = Set(Some((Utc::now() + ChronoDuration::minutes(5)).into()));
            snapshot
                .update(&db)
                .await
                .expect("snapshot update should succeed");
        }

        let context = BattleLinkingContext::new("weaklings-id", &[], &[]);
        let detail = EventService::new()
            .get_event_detail_with_context(&db, event_id, &context)
            .await
            .expect("event detail should group matching segments");
        assert_eq!(detail.fights.len(), 1);
        assert_eq!(detail.fights[0].battle_ids.len(), 2);

        let fights = fight::Entity::find()
            .filter(fight::Column::EventId.eq(event_id))
            .all(&db)
            .await
            .expect("fight query should succeed");
        assert_eq!(fights.len(), 1);
        assert_eq!(fights[0].grouping_method, "automatic");
        assert!(!fights[0].needs_review);
        assert_eq!(
            fight_battle::Entity::find()
                .filter(fight_battle::Column::FightId.eq(fights[0].id))
                .count(&db)
                .await
                .expect("fight segment count should succeed"),
            2
        );
    }

    #[tokio::test]
    async fn event_detail_rejects_a_battle_already_owned_by_another_event() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let first_event = insert_event(&db, "First event", author).await;
        let second_event = insert_event(&db, "Second event", author).await;
        let battle_id = 425_654_504;
        insert_battle_with_players(&db, first_event, battle_id, true, &[("Alice", 1, 0)]).await;

        EventService::new()
            .get_event_detail(&db, first_event)
            .await
            .expect("first event should claim its battle");
        event_battle::ActiveModel {
            event_id: Set(second_event),
            albionbb_battle_id: Set(battle_id.to_string()),
            battle_started_at: Set(ts()),
            guild_players_count: Set(1),
            fetched_at: Set(ts()),
            guild_kills: Set(1),
            guild_deaths: Set(0),
            guild_kill_fame: Set(0),
            is_win: Set(true),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("second event link should be inserted");

        let error = EventService::new()
            .get_event_detail(&db, second_event)
            .await
            .expect_err("a raw battle cannot belong to two canonical fights");

        assert!(matches!(error, AppError::Conflict(_)));
        assert_eq!(
            fight_battle::Entity::find()
                .filter(fight_battle::Column::BattleId.eq(battle_id))
                .count(&db)
                .await
                .expect("fight segment count should succeed"),
            1,
            "the rejected event must not create another fight membership"
        );
    }

    #[tokio::test]
    async fn event_detail_prefers_hydrated_snapshot_metrics_over_zeroed_link_summary() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let event_id = insert_event(&db, "Hydrated event", author).await;
        let battle_id = 425_654_503;
        insert_battle_with_players(&db, event_id, battle_id, false, &[("Alice", 0, 0)]).await;

        let snapshot = GuildBattleSnapshotEntity::find()
            .filter(GuildBattleSnapshotColumn::BattleId.eq(battle_id))
            .one(&db)
            .await
            .expect("snapshot query should succeed")
            .expect("snapshot should exist");
        let mut snapshot: crate::modules::battles::entities::ActiveModel = snapshot.into();
        snapshot.total_players = Set(42);
        snapshot.guilds_json = Set(serde_json::to_string(&vec![
            BattleGuildSummary {
                id: "configured-guild-id".to_string(),
                name: "Weaklings".to_string(),
                alliance_name: None,
                alliance_id: None,
                players: 14,
                kills: 11,
                deaths: 7,
                kill_fame: 2_700_000,
                winner: true,
                average_item_power: 1_400.0,
            },
            BattleGuildSummary {
                id: "enemy-id".to_string(),
                name: "Black Order".to_string(),
                alliance_name: None,
                alliance_id: None,
                players: 18,
                kills: 7,
                deaths: 11,
                kill_fame: 1_500_000,
                winner: false,
                average_item_power: 1_390.0,
            },
        ])
        .expect("guild snapshot should serialize"));
        snapshot
            .update(&db)
            .await
            .expect("snapshot update should succeed");

        let context = BattleLinkingContext::new("configured-guild-id", &[], &[]);
        let detail = EventService::new()
            .get_event_detail_with_context(&db, event_id, &context)
            .await
            .expect("event detail should use the hydrated snapshot");

        assert_eq!(detail.stats.total_kills, 11);
        assert_eq!(detail.stats.total_deaths, 7);
        assert_eq!(detail.stats.total_kill_fame, 2_700_000);
        assert_eq!(detail.stats.average_guild_players, 14.0);
        assert_eq!(detail.stats.wins, 1);
    }

    #[test]
    fn linked_battle_snapshot_uses_the_guild_name_when_the_list_payload_has_no_guild_id() {
        let context =
            BattleLinkingContext::new("configured-guild-id", &[], &["Weaklings".to_string()]);
        let battle = AlbionBbBattleSummary {
            id: 425_654_502,
            start_time: "2026-09-01T20:02:00Z".to_string(),
            end_time: "2026-09-01T20:12:00Z".to_string(),
            total_players: 42,
            total_kills: 18,
            total_fame: 4_200_000,
            guilds: vec![
                AlbionBbGuild {
                    id: String::new(),
                    name: "Weaklings".to_string(),
                    players: 14,
                    kills: 11,
                    deaths: 7,
                    kill_fame: 2_700_000,
                    winner: true,
                    alliance_name: None,
                    alliance_id: None,
                    average_item_power: 1_400.0,
                },
                AlbionBbGuild {
                    id: "enemy-id".to_string(),
                    name: "Black Order".to_string(),
                    players: 18,
                    kills: 7,
                    deaths: 11,
                    kill_fame: 1_500_000,
                    winner: false,
                    alliance_name: None,
                    alliance_id: None,
                    average_item_power: 1_390.0,
                },
            ],
        };

        let snapshot = linked_battle_snapshot(&battle, &context);

        assert_eq!(snapshot.guild_players_count, 14);
        assert_eq!(snapshot.guild_kills, 11);
        assert_eq!(snapshot.guild_deaths, 7);
        assert_eq!(snapshot.guild_kill_fame, 2_700_000);
        assert!(snapshot.is_win);
    }

    #[tokio::test]
    async fn build_performance_counts_secondary_sign_ups_too() {
        let db = seed_db().await;
        let author = insert_user(&db, "admin", "admin@example.com").await;
        let category = create_build_category(&db, "Crystal").await;
        let hammer = create_build(&db, "Pole Hammer", category).await;
        let axe = create_build(&db, "Great Axe", category).await;

        let alice = insert_linked_member(&db, "alice", "Alice").await;
        let event = insert_event(&db, "One fight", author).await;
        event_participation::ActiveModel {
            event_id: Set(event),
            user_id: Set(alice),
            primary_build_id: Set(Some(hammer)),
            secondary_build_id: Set(Some(axe)),
            ..Default::default()
        }
        .insert(&db)
        .await
        .unwrap();

        let performance = EventService::new()
            .get_build_performance(&db, axe)
            .await
            .unwrap();

        assert_eq!(performance.signups_as_secondary, 1);
        assert_eq!(performance.signups_as_primary, 0);
    }

    #[tokio::test]
    async fn the_roster_carries_each_participant_s_specialization_levels() {
        // Regression: `get_roster` used to build participants with an empty specialization map,
        // so the level badge beside every bench member rendered zero however much they had
        // trained. `get_event_detail` populated it; the two now share one loader.
        let db = seed_db().await;
        let user_id = insert_user(&db, "spec-user", "spec-user@example.com").await;
        let build_category = create_build_category(&db, "spec-builds").await;
        let build_id = create_build(&db, "spec-build", build_category).await;
        let comp_category = create_comp_category(&db, "spec-comps").await;
        let comp_id = create_comp(&db, "spec-comp", comp_category, None, vec![(build_id, 1)]).await;
        let event_id = event::ActiveModel {
            title: Set("Spec event".to_string()),
            comp_id: Set(comp_id),
            created_by: Set(user_id),
            event_date_utc: Set(ts()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("failed to insert event")
        .id;

        // Stored with the legacy tier-specific key, so the canonicalization is exercised too.
        crate::modules::users::specializations::ActiveModel {
            user_id: Set(user_id),
            node_key: Set("weapon:T8_2H_POLEHAMMER".to_string()),
            node_name: Set("Great Polehammer".to_string()),
            category: Set("weapon".to_string()),
            level: Set(87),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("failed to insert specialization");

        let service = EventService::new();
        service
            .participate_with_roster_version(
                &db,
                event_id,
                user_id,
                ParticipateEventRequest {
                    primary_build_id: Some(build_id),
                    secondary_build_id: None,
                },
            )
            .await
            .expect("participation should succeed");

        let roster = service
            .get_roster(&db, event_id)
            .await
            .expect("roster should load");
        let participant = roster
            .seats
            .iter()
            .find_map(|seat| seat.participant.as_ref())
            .or_else(|| roster.bench.first())
            .expect("the participant should be on a seat or the bench");
        assert_eq!(
            participant.specializations.get("weapon:2H_POLEHAMMER"),
            Some(&87),
            "roster specializations were {:?}",
            participant.specializations
        );
    }

    /// Gives a build a weapon whose base identifier `combat::ip` can resolve, via the icon URL —
    /// the same fallback `openalbion::service::base_identifier_for_stored_item` uses for rows
    /// written before the catalog id was stable, which is the shape a hand-built test row has.
    async fn insert_weapon_item(db: &DatabaseConnection, build_id: i64, identifier: &str) {
        crate::modules::comps::entities::build_item::ActiveModel {
            build_id: Set(build_id),
            loadout: Set("main".to_string()),
            slot: Set("weapon".to_string()),
            openalbion_item_type: Set("weapon".to_string()),
            openalbion_item_id: Set(0),
            openalbion_item_name: Set(identifier.to_string()),
            openalbion_item_icon: Set(Some(format!(
                "https://render.albiononline.com/v1/item/{identifier}.png?quality=1&size=64"
            ))),
            openalbion_item_tier: Set(Some("8".to_string())),
            openalbion_item_quality: Set(4),
            openalbion_item_enchantment: Set(0),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert weapon item");
    }

    #[tokio::test]
    async fn auto_fill_roster_defaults_to_greedy_signup_order() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let member = insert_user(&db, "member", "member@example.com").await;
        let category = create_build_category(&db, "auto-fill-builds").await;
        let build_id = create_build(&db, "auto-fill-build", category).await;
        insert_weapon_item(&db, build_id, "T8_2H_POLEHAMMER").await;
        let comp_category = create_comp_category(&db, "auto-fill-comps").await;
        let comp_id = create_comp(
            &db,
            "auto-fill-comp",
            comp_category,
            None,
            vec![(build_id, 1)],
        )
        .await;
        let event_id = event::ActiveModel {
            title: Set("Auto-fill event".to_string()),
            comp_id: Set(comp_id),
            created_by: Set(officer),
            event_date_utc: Set(ts()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("failed to insert event")
        .id;

        let service = EventService::new();
        service
            .participate_with_roster_version(
                &db,
                event_id,
                member,
                ParticipateEventRequest {
                    primary_build_id: Some(build_id),
                    secondary_build_id: None,
                },
            )
            .await
            .expect("participation should succeed");

        let (_, changed) = service
            .auto_fill_roster(
                &db,
                event_id,
                RosterVersionRequest {
                    expected_roster_version: 1,
                    strategy: None,
                },
                officer,
            )
            .await
            .expect("greedy auto-fill should succeed");

        assert_eq!(changed, vec![format!("build:{build_id}:1")]);
        let roster = service
            .get_roster(&db, event_id)
            .await
            .expect("roster should load");
        assert_eq!(
            roster
                .seats
                .iter()
                .find_map(|seat| seat.participant.as_ref())
                .map(|p| p.user_id),
            Some(member)
        );
    }

    #[tokio::test]
    async fn auto_fill_roster_with_spec_optimal_seats_the_better_trained_member() {
        let db = seed_db().await;
        let officer = insert_user(&db, "spec-officer", "spec-officer@example.com").await;
        let novice = insert_user(&db, "novice", "novice@example.com").await;
        let expert = insert_user(&db, "expert", "expert@example.com").await;
        let category = create_build_category(&db, "spec-optimal-builds").await;
        let build_id = create_build(&db, "spec-optimal-build", category).await;
        insert_weapon_item(&db, build_id, "T8_2H_POLEHAMMER").await;
        let comp_category = create_comp_category(&db, "spec-optimal-comps").await;
        let comp_id = create_comp(
            &db,
            "spec-optimal-comp",
            comp_category,
            None,
            vec![(build_id, 1)],
        )
        .await;
        let event_id = event::ActiveModel {
            title: Set("Spec-optimal event".to_string()),
            comp_id: Set(comp_id),
            created_by: Set(officer),
            event_date_utc: Set(ts()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("failed to insert event")
        .id;

        crate::modules::users::specializations::ActiveModel {
            user_id: Set(expert),
            node_key: Set("weapon:2H_POLEHAMMER".to_string()),
            node_name: Set("Great Polehammer".to_string()),
            category: Set("weapon".to_string()),
            level: Set(100),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("failed to insert specialization");

        let service = EventService::new();
        // The novice signs up first and would win the seat under greedy first-fit; neither has a
        // build preference recorded, so only trained specialization tells them apart.
        for user_id in [novice, expert] {
            service
                .participate_with_roster_version(
                    &db,
                    event_id,
                    user_id,
                    ParticipateEventRequest {
                        primary_build_id: None,
                        secondary_build_id: None,
                    },
                )
                .await
                .expect("participation should succeed");
        }

        let (_, changed) = service
            .auto_fill_roster(
                &db,
                event_id,
                RosterVersionRequest {
                    expected_roster_version: 2,
                    strategy: Some(crate::modules::combat::fit::FitStrategy::SpecOptimal),
                },
                officer,
            )
            .await
            .expect("spec-optimal auto-fill should succeed");

        assert_eq!(changed, vec![format!("build:{build_id}:1")]);
        let roster = service
            .get_roster(&db, event_id)
            .await
            .expect("roster should load");
        assert_eq!(
            roster
                .seats
                .iter()
                .find_map(|seat| seat.participant.as_ref())
                .map(|p| p.user_id),
            Some(expert),
            "the trained member should take the seat, not whoever signed up first"
        );
    }

    #[tokio::test]
    async fn cancelling_participation_removes_assignment_before_rejoin() {
        let db = seed_db().await;
        let user_id = insert_user(&db, "roster-user", "roster-user@example.com").await;
        let build_category = create_build_category(&db, "roster-builds").await;
        let build_id = create_build(&db, "roster-build", build_category).await;
        let comp_category = create_comp_category(&db, "roster-comps").await;
        let comp_id =
            create_comp(&db, "roster-comp", comp_category, None, vec![(build_id, 1)]).await;
        let event_id = event::ActiveModel {
            title: Set("Roster event".to_string()),
            comp_id: Set(comp_id),
            created_by: Set(user_id),
            event_date_utc: Set(ts()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("failed to insert event")
        .id;
        let service = EventService::new();
        let (_, joined_version) = service
            .participate_with_roster_version(
                &db,
                event_id,
                user_id,
                ParticipateEventRequest {
                    primary_build_id: Some(build_id),
                    secondary_build_id: None,
                },
            )
            .await
            .expect("joining should invalidate the roster");
        assert_eq!(joined_version, 1);
        service
            .assign_roster_seat(
                &db,
                event_id,
                &format!("build:{build_id}:1"),
                AssignRosterSeatRequest {
                    user_id,
                    expected_roster_version: joined_version,
                },
                user_id,
            )
            .await
            .expect("assignment should succeed");
        let assigned_detail = service
            .get_event_detail(&db, event_id)
            .await
            .expect("event detail should load after assignment");
        assert_eq!(assigned_detail.event.roster_version, 2);
        assert_eq!(
            assigned_detail.participants[0].assigned_build_id,
            Some(build_id)
        );
        assert_eq!(
            assigned_detail.participants[0]
                .assigned_build_name
                .as_deref(),
            Some("roster-build")
        );
        let (_, roster_version, seat_key) = service
            .cancel_participation(&db, event_id, user_id)
            .await
            .expect("cancellation should succeed");
        assert_eq!(roster_version, 3);
        assert_eq!(seat_key, Some(format!("build:{build_id}:1")));
        assert!(
            event_roster_assignment::Entity::find()
                .filter(event_roster_assignment::Column::EventId.eq(event_id))
                .filter(event_roster_assignment::Column::UserId.eq(user_id))
                .one(&db)
                .await
                .expect("assignment lookup should succeed")
                .is_none()
        );

        let (_, rejoined_version) = service
            .participate_with_roster_version(
                &db,
                event_id,
                user_id,
                ParticipateEventRequest {
                    primary_build_id: Some(build_id),
                    secondary_build_id: None,
                },
            )
            .await
            .expect("rejoining should invalidate the roster");
        assert_eq!(rejoined_version, 4);
        let roster = service
            .get_roster(&db, event_id)
            .await
            .expect("roster should load after rejoin");
        assert!(roster.seats.iter().all(|seat| seat.participant.is_none()));
        assert_eq!(roster.bench.len(), 1);
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
            role: Set("dps".to_string()),
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
                    player_cap: Some(10),
                    event_date_utc: Some("2026-07-20T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
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
        assert_eq!(event.player_cap, Some(10));
        assert_eq!(event.mass_time_utc, "2026-07-20T19:30:00+00:00");
        assert_eq!(event.start_time_utc, "2026-07-20T20:00:00+00:00");
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
    fn event_times_require_mass_not_after_start() {
        let mass = parse_event_timestamp("2026-07-20T20:01:00Z", "mass_time_utc").unwrap();
        let start = parse_event_timestamp("2026-07-20T20:00:00Z", "start_time_utc").unwrap();
        let error = validate_event_times(mass, start).unwrap_err();
        assert!(error.to_string().contains("mass_time_utc"));
    }

    #[test]
    fn event_times_accept_equal_mass_and_start() {
        let timestamp = parse_event_timestamp("2026-07-20T20:00:00Z", "start_time_utc").unwrap();
        validate_event_times(timestamp, timestamp).unwrap();
    }

    #[tokio::test]
    async fn cancel_event_is_idempotent_and_rejects_completed_events() {
        let db = seed_db().await;
        let creator = insert_user(&db, "admin", "admin@example.com").await;
        let service = EventService::new();
        let event_id = insert_event(&db, "Cancelable", creator).await;

        let cancelled = service.cancel_event(&db, event_id).await.unwrap();
        assert_eq!(cancelled.status, "cancelled");
        let repeated = service.cancel_event(&db, event_id).await.unwrap();
        assert_eq!(repeated.status, "cancelled");

        let completed_id = insert_event(&db, "Completed", creator).await;
        service.start_event(&db, completed_id).await.unwrap();
        service.stop_event(&db, completed_id, false).await.unwrap();
        assert!(service.cancel_event(&db, completed_id).await.is_err());
    }

    #[test]
    fn expansion_threshold_uses_the_requested_seven_of_ten_boundary() {
        assert_eq!(expansion_threshold(1), 1);
        assert_eq!(expansion_threshold(10), 7);
        assert_eq!(expansion_threshold(15), 11);
        assert_eq!(expansion_threshold(20), 15);
    }

    #[test]
    fn player_cap_advances_to_the_next_expansion_without_becoming_a_hard_limit() {
        assert_eq!(comp_resolution_target(9, Some(10)), 9);
        assert_eq!(comp_resolution_target(10, Some(10)), 11);
        assert_eq!(comp_resolution_target(15, Some(10)), 16);
        assert_eq!(comp_resolution_target(10, None), 10);
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
                    player_cap: None,
                    event_date_utc: Some("2026-09-01T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
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
    async fn bind_event_voice_channel_allows_mass_while_scheduled_and_never_overwrites() {
        let db = seed_db().await;
        let admin = insert_user(&db, "voice-admin", "voice-admin@example.com").await;
        let cat = create_comp_category(&db, "Voice ZvZ").await;
        let comp_id = create_comp(&db, "Voice Comp", cat, None, vec![]).await;
        let service = EventService::new();
        let event = service
            .create_event(
                &db,
                admin,
                CreateEventRequest {
                    title: "Voice Event".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    comp_id,
                    player_cap: None,
                    event_date_utc: Some("2026-09-01T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
                    discord_role_ids: vec![],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();

        let bound = service
            .bind_event_voice_channel(&db, event.id, "111111111111111111")
            .await
            .unwrap();
        assert_eq!(bound.status, "scheduled");
        assert_eq!(
            bound.discord_voice_channel_id.as_deref(),
            Some("111111111111111111")
        );
        assert_eq!(
            service
                .bind_event_voice_channel(&db, event.id, "111111111111111111")
                .await
                .unwrap()
                .discord_voice_channel_id
                .as_deref(),
            Some("111111111111111111")
        );
        assert!(matches!(
            service
                .bind_event_voice_channel(&db, event.id, "222222222222222222")
                .await,
            Err(AppError::Conflict(_))
        ));

        let started = service.start_event(&db, event.id).await.unwrap();
        assert_eq!(
            started.discord_voice_channel_id.as_deref(),
            Some("111111111111111111")
        );

        service.stop_event(&db, event.id, false).await.unwrap();
        assert!(matches!(
            service
                .bind_event_voice_channel(&db, event.id, "333333333333333333")
                .await,
            Err(AppError::Conflict(_))
        ));
        assert_eq!(
            service
                .clear_event_voice_channel(&db, event.id)
                .await
                .unwrap()
                .discord_voice_channel_id,
            None
        );
        assert_eq!(
            service
                .clear_event_voice_channel(&db, event.id)
                .await
                .unwrap()
                .discord_voice_channel_id,
            None
        );
    }

    #[tokio::test]
    async fn clear_event_voice_channel_allows_cancelled_mass_cleanup() {
        let db = seed_db().await;
        let admin = insert_user(&db, "voice-cancel", "voice-cancel@example.com").await;
        let cat = create_comp_category(&db, "Cancel ZvZ").await;
        let comp_id = create_comp(&db, "Cancel Comp", cat, None, vec![]).await;
        let service = EventService::new();
        let event = service
            .create_event(
                &db,
                admin,
                CreateEventRequest {
                    title: "Cancel Voice Event".to_string(),
                    description: None,
                    call_to_arms: false,
                    regear: false,
                    comp_id,
                    player_cap: None,
                    event_date_utc: Some("2026-09-01T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
                    discord_role_ids: vec![],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();

        service
            .bind_event_voice_channel(&db, event.id, "111111111111111111")
            .await
            .unwrap();
        service.cancel_event(&db, event.id).await.unwrap();
        assert_eq!(
            service
                .clear_event_voice_channel(&db, event.id)
                .await
                .unwrap()
                .discord_voice_channel_id,
            None
        );
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
                    player_cap: None,
                    event_date_utc: Some("2026-07-20T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
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
                    player_cap: None,
                    event_date_utc: Some("2026-07-20T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
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
                    archived: None,
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
                    player_cap: None,
                    event_date_utc: Some("2026-07-20T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
                    discord_role_ids: vec![],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();

        // 1st participant signs up as Tank. The one-slot base reaches its minimum threshold.
        let detail = service
            .participate(
                &db,
                event.id,
                player1,
                ParticipateEventRequest {
                    primary_build_id: Some(b1),
                    secondary_build_id: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(detail.active_comp_id, variant_comp);
        assert_eq!(detail.active_comp_capacity, 2);
        assert_eq!(detail.participants.len(), 1);

        // 2nd participant signs up as Healer; the expanded comp remains active.
        let detail = service
            .participate(
                &db,
                event.id,
                player2,
                ParticipateEventRequest {
                    primary_build_id: Some(b2),
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
                    primary_build_id: Some(b1),
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
                    player_cap: None,
                    event_date_utc: Some("2026-07-20T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
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
                    primary_build_id: Some(b1),
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
                    primary_build_id: Some(b1),
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
                    primary_build_id: Some(b2),
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
                    player_cap: None,
                    event_date_utc: Some("2026-07-20T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
                    discord_role_ids: vec![],
                    create_split: false,
                    island_tab_id: None,
                },
            )
            .await
            .unwrap();

        let req = ParticipateEventRequest {
            primary_build_id: Some(b1),
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
                    player_cap: None,
                    event_date_utc: Some("2026-07-20T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
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
                    primary_build_id: Some(b1),
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
                    player_cap: None,
                    event_date_utc: Some("2026-07-21T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
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
                    player_cap: None,
                    event_date_utc: Some("2026-07-22T20:00:00Z".to_string()),
                    mass_time_utc: None,
                    start_time_utc: None,
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
        status: Set(SplitStatus::AwaitingEvent.to_string()),
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
