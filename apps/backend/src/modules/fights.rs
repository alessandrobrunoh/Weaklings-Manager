//! Read-only canonical Fight API.

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    routing::{get, post},
};
use chrono::{Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DatabaseTransaction, EntityTrait,
    QueryFilter, QueryOrder, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::config::Config;
use crate::errors::AppError;
use crate::modules::albion::entities::albion_link;
use crate::modules::battles::entities::{
    Column as GuildBattleSnapshotColumn, Entity as GuildBattleSnapshotEntity,
};
use crate::modules::battles::models::{
    BattleGuildSummary, BattleLossEstimate, BattlePlayer, GuildLossEstimate, PlayerLossEstimate,
};
use crate::modules::comps::entities::{build, comp};
use crate::modules::events::entities::{
    event, event_battle, event_participation, fight, fight_battle,
};
use crate::modules::users::entities as user;
use crate::modules::{
    audit::service::AuditService,
    auth::{Permission, Permissions, UserContext},
};
use crate::pagination::{
    PaginatedData, PaginationParams, SortOrder, paginate_vec, resolve_sort_key,
};
use crate::responses::ApiResponse;
use serde_json::{Value, json};

/// Persisted summary metadata for one ordered battle segment of a fight.
#[derive(Debug, Serialize, ToSchema)]
pub struct FightSegmentSummary {
    /// AlbionBB battle ID.
    pub battle_id: i64,
    /// Position of this segment within the canonical fight.
    pub sequence_number: i32,
    /// ISO 8601 battle start time.
    pub started_at: String,
    /// ISO 8601 battle end time, when known.
    pub ended_at: Option<String>,
    /// Players reported by the upstream battle summary for this segment.
    pub total_players: i64,
    /// Kills reported by the upstream battle summary for this segment.
    pub total_kills: i64,
    /// Fame reported by the upstream battle summary for this segment.
    pub total_fame: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FightOutcomeView {
    /// Deterministic Fight-level outcome derived from persisted segment evidence.
    pub outcome: FightOutcome,
    /// Number of persisted source records used to establish the outcome.
    pub evidence_count: i64,
    /// How the outcome was resolved. Values include `unanimous_segment_outcomes`,
    /// `mixed_segment_outcomes`, and `incomplete_or_conflicting_segment_evidence`.
    pub method: String,
}

/// A canonical Fight's outcome from the configured guild's perspective.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FightOutcome {
    Victory,
    Defeat,
    Draw,
    Unknown,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FightListItem {
    /// Canonical Fight database ID.
    pub id: i64,
    /// Linked Event ID, if this fight belongs to an event session.
    pub event_id: Option<i64>,
    /// Linked Event title, if the event still exists.
    pub event_title: Option<String>,
    /// When the first segment began (RFC3339).
    pub started_at: String,
    /// When the latest known segment ended (RFC3339).
    pub ended_at: Option<String>,
    pub grouping_method: String,
    pub grouping_confidence: f64,
    pub needs_review: bool,
    /// Number of persisted `fight_battles` segments, including ones that have not been hydrated.
    pub segment_count: i64,
    /// Largest hydrated segment player count. This avoids counting people appearing in multiple
    /// segments more than once.
    pub total_players: i64,
    /// Sum of kills across hydrated segments.
    pub total_kills: i64,
    /// Sum of fame across hydrated segments.
    pub total_fame: i64,
    /// Deterministic outcome aggregated across all persisted segment evidence.
    pub outcome: FightOutcomeView,
}

/// Paginated canonical-fight summaries.
#[derive(Debug, Serialize, ToSchema)]
pub struct PaginatedFightList {
    pub items: Vec<FightListItem>,
    pub total_items: u64,
    pub total_pages: u64,
    pub current_page: u64,
    pub limit: u64,
}

impl From<PaginatedData<FightListItem>> for PaginatedFightList {
    fn from(data: PaginatedData<FightListItem>) -> Self {
        Self {
            items: data.items,
            total_items: data.total_items,
            total_pages: data.total_pages,
            current_page: data.current_page,
            limit: data.limit,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FightDetailView {
    pub id: i64,
    pub event_id: Option<i64>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub grouping_method: String,
    pub grouping_confidence: f64,
    pub needs_review: bool,
    /// Deterministic outcome from persisted segment evidence.
    pub outcome: FightOutcomeView,
    /// Technical AlbionBB battle IDs that make up this fight, in sequence.
    pub battle_ids: Vec<i64>,
    /// Number of battle segments linked to this fight, including segments not yet persisted.
    pub segment_count: i64,
    /// Largest single-segment player count, rather than a sum that would count repeat participants.
    pub total_players: i64,
    pub total_kills: i64,
    pub total_fame: i64,
    /// Distinct players across persisted segments, identified by `BattlePlayer.id`.
    pub unique_players: i64,
    /// Guild performance aggregated across persisted segments.
    pub guilds: Vec<BattleGuildSummary>,
    /// Player performance aggregated across persisted segments.
    pub players: Vec<BattlePlayer>,
    /// Equipment-loss estimates aggregated across persisted segments.
    pub estimated_losses: BattleLossEstimate,
    /// Persisted segment summaries in the fight's configured sequence.
    pub segments: Vec<FightSegmentSummary>,
    /// Friendly players observed in persisted battle snapshots. Empty when no snapshot records a
    /// configured guild or ally; it is never inferred from the event roster.
    pub observed_friendly_players: Vec<ObservedFriendlyPlayerView>,
    /// The linked event's planned composition. Absent when this fight is not linked to an event.
    pub planned_comp: Option<FightPlannedCompView>,
    /// The linked event's planned participants and their selected builds. Empty when this fight
    /// is not linked to an event.
    pub planned_participants: Vec<PlannedFightParticipantView>,
    /// How completely the planned roster can be compared with persisted snapshot observations.
    pub participant_coverage: FightParticipantCoverage,
}

/// A friendly player observed in one or more persisted battle snapshots.
#[derive(Debug, Serialize, ToSchema)]
pub struct ObservedFriendlyPlayerView {
    /// Albion player ID from the battle snapshot.
    pub albion_player_id: String,
    /// Latest observed in-game name.
    pub name: String,
    /// Latest observed guild identity.
    pub guild_id: String,
    pub guild_name: String,
    /// Number of persisted fight segments containing this player.
    pub segments_observed: i64,
    pub kills: i64,
    pub deaths: i64,
    pub kill_fame: i64,
    pub death_fame: i64,
    /// Mean item power across observed segments.
    pub average_item_power: f64,
    /// Internal user matched through their linked Albion character, when available.
    pub user_id: Option<i64>,
}

/// Composition configured for the event linked to a Fight.
#[derive(Debug, Serialize, ToSchema)]
pub struct FightPlannedCompView {
    /// Persisted composition ID selected for the event.
    pub id: i64,
    /// Composition display name, when the persisted comp is still available.
    pub name: Option<String>,
}

/// An event roster member planned for this fight's linked event.
#[derive(Debug, Serialize, ToSchema)]
pub struct PlannedFightParticipantView {
    /// Internal event participant user ID.
    pub user_id: i64,
    pub username: String,
    /// Linked Albion character ID used for observation matching, if the user has linked one.
    pub albion_player_id: Option<String>,
    /// `None` when the participant selected the virtual Fill role.
    pub primary_build_id: Option<i64>,
    pub primary_build_name: Option<String>,
    pub secondary_build_id: Option<i64>,
    pub secondary_build_name: Option<String>,
    /// Whether this planned participant was observed in a persisted friendly snapshot.
    pub observed: bool,
}

/// Explicit limits and results of roster-to-snapshot matching.
#[derive(Debug, Serialize, ToSchema)]
pub struct FightTrendView {
    /// UTC time at which the rolling windows were evaluated.
    pub generated_at: String,
    /// Metrics for the most recent 30 complete days.
    pub last_30_days: FightTrendPeriod,
    /// Metrics for the 30 days immediately preceding `last_30_days`.
    pub previous_30_days: FightTrendPeriod,
    /// Canonical fights beginning on each UTC date in the recent window, including days with zero fights.
    pub rolling_daily_fight_counts: Vec<FightTrendDay>,
}

/// One comparable 30-day fight-trend period. Combat values only include fights with a persisted
/// snapshot; `coverage` describes precisely how much canonical fight data that excludes.
#[derive(Debug, Serialize, ToSchema)]
pub struct FightTrendPeriod {
    pub window_started_at: String,
    pub window_ended_at: String,
    /// All canonical fights that started in this period.
    pub fight_sample_size: i64,
    /// Fights with at least one persisted segment snapshot, used for kills, deaths and fame.
    pub combat_sample_size: i64,
    /// Fights with a friendly guild summary that can establish a win or loss.
    pub win_sample_size: i64,
    pub wins: i64,
    pub losses: i64,
    pub win_rate: Option<f64>,
    pub kills: i64,
    pub deaths: i64,
    pub kd_ratio: Option<f64>,
    pub kill_fame: i64,
    pub coverage: FightTrendCoverage,
    /// Planned roster selections counted once per linked canonical fight. A repeated event linked
    /// to multiple fights intentionally contributes to each fight's participation sample.
    pub planned_participation: FightTrendPlannedParticipation,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FightTrendCoverage {
    pub fights_with_snapshots: i64,
    pub persisted_segments: i64,
    pub total_segments: i64,
    pub fights_with_winner_data: i64,
    pub linked_event_fights: i64,
    pub linked_events: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FightTrendPlannedParticipation {
    pub linked_fights: i64,
    pub linked_events: i64,
    pub planned_participant_assignments: i64,
    pub primary_build_assignments: Vec<FightTrendSelectionCount>,
    pub secondary_build_assignments: Vec<FightTrendSelectionCount>,
    pub comp_assignments: Vec<FightTrendSelectionCount>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FightTrendSelectionCount {
    pub id: i64,
    pub name: Option<String>,
    pub count: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FightTrendDay {
    /// UTC calendar date (`YYYY-MM-DD`).
    pub date: String,
    pub fights: i64,
}

/// Explicit limits and results of roster-to-snapshot matching.
#[derive(Debug, Serialize, ToSchema)]
pub struct FightParticipantCoverage {
    /// Whether this fight has an event roster to compare.
    pub event_linked: bool,
    /// Number of registered event participants.
    pub planned_participants: i64,
    /// Planned participants with a linked Albion character and therefore eligible for matching.
    pub matchable_planned_participants: i64,
    /// Matchable planned participants observed in at least one persisted friendly snapshot.
    pub observed_planned_participants: i64,
    /// Planned participants without an Albion link, so their presence cannot be determined.
    pub unmatched_planned_participants: i64,
    /// Friendly snapshot players not matched to an event participant.
    pub unplanned_observed_players: i64,
    /// Number of fight segments with a persisted snapshot.
    pub persisted_segments: i64,
    /// Total number of fight segments; missing snapshots limit observation coverage.
    pub total_segments: i64,
}

pub fn router() -> Router {
    Router::new()
        .route("/", get(list_fights))
        .route("/merge", post(merge_fights))
        .route("/{id}/move-battle", post(move_battle))
        .route("/{id}/split", post(split_fight))
        .route("/trends", get(get_fight_trends))
        .route("/{id}", get(get_fight))
}

/// Query parameters for browsing persisted canonical fights.
///
/// Pagination fields are declared inline because axum's query extractor cannot
/// deserialize flattened non-string pagination fields.
#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct FightListQuery {
    /// Page number, starting at 1. Defaults to 1.
    pub page: Option<u64>,
    /// Number of fights per page. Defaults to 10.
    pub limit: Option<u64>,
    /// Case-insensitive match on canonical Fight id or linked Event title.
    pub search: Option<String>,
    /// Restrict results to fights linked to this Event.
    pub event_id: Option<i64>,
    /// Restrict results to fights awaiting grouping review.
    pub needs_review: Option<bool>,
    /// Minimum largest-segment player count across hydrated segments.
    pub min_players: Option<i64>,
    /// Restrict results to an aggregated outcome: `victory`, `defeat`, `draw`, or `unknown`.
    pub outcome: Option<String>,
    /// Sort column: `start_time` (default), `fame`, `kills`, `players`, `segments`, `id`, or
    /// `outcome`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc` (default).
    pub order: Option<String>,
}

impl FightListQuery {
    fn pagination(&self) -> PaginationParams {
        PaginationParams {
            page: self.page,
            limit: self.limit,
        }
    }
}

/// Lists persisted canonical fights with linked event metadata and segment counts.
///
/// The tie-breaker on `id` makes pages deterministic when several fights share
/// the same start timestamp.
#[utoipa::path(
    get,
    path = "/api/fights",
    tag = "fights",
    summary = "List persisted fights",
    security(("session_cookie" = [])),
    params(FightListQuery),
    responses(
        (status = 200, description = "Paginated fight summaries", body = PaginatedFightList),
        (status = 401, description = "Unauthorized", body = crate::errors::ProblemDetails)
    )
)]
async fn list_fights(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(config): Extension<Config>,
    Query(query): Query<FightListQuery>,
) -> Result<Json<ApiResponse<PaginatedFightList>>, AppError> {
    user.require(&perms, Permission::FightsView).await?;
    let pagination = query.pagination();
    // Outcome and combat values are derived from every Fight's persisted segments, so pagination
    // must happen after hydration, filtering, and sorting rather than on the raw `fights` rows.
    let fights = fight::Entity::find()
        .all(&db)
        .await
        .map_err(AppError::Database)?;
    let fight_ids = fights.iter().map(|model| model.id).collect::<Vec<_>>();
    let segments = if fight_ids.is_empty() {
        Vec::new()
    } else {
        fight_battle::Entity::find()
            .filter(fight_battle::Column::FightId.is_in(fight_ids))
            .all(&db)
            .await
            .map_err(AppError::Database)?
    };
    let mut segment_counts = HashMap::<i64, i64>::new();
    let mut segments_by_fight = HashMap::<i64, Vec<fight_battle::Model>>::new();
    for segment in segments {
        *segment_counts.entry(segment.fight_id).or_default() += 1;
        segments_by_fight
            .entry(segment.fight_id)
            .or_default()
            .push(segment);
    }
    let battle_ids = segments_by_fight
        .values()
        .flatten()
        .map(|segment| segment.battle_id)
        .collect::<Vec<_>>();
    let snapshots = if battle_ids.is_empty() {
        Vec::new()
    } else {
        GuildBattleSnapshotEntity::find()
            .filter(GuildBattleSnapshotColumn::BattleId.is_in(battle_ids.clone()))
            .all(&db)
            .await
            .map_err(AppError::Database)?
    };
    let snapshots_by_battle = snapshots
        .into_iter()
        .map(|snapshot| (snapshot.battle_id, snapshot))
        .collect::<HashMap<_, _>>();

    let event_ids = fights
        .iter()
        .filter_map(|model| model.event_id)
        .collect::<Vec<_>>();
    let event_titles = if event_ids.is_empty() {
        HashMap::new()
    } else {
        event::Entity::find()
            .filter(event::Column::Id.is_in(event_ids.clone()))
            .all(&db)
            .await
            .map_err(AppError::Database)?
            .into_iter()
            .map(|model| (model.id, model.title))
            .collect()
    };
    let event_outcomes_by_segment = load_event_outcomes(&db, &event_ids, &battle_ids).await?;

    let items = fights
        .into_iter()
        .map(|model| -> Result<FightListItem, AppError> {
            let fight_segments = segments_by_fight
                .get(&model.id)
                .map_or(&[][..], Vec::as_slice);
            let summary = summarize_fight_segments(fight_segments, &snapshots_by_battle);
            Ok(FightListItem {
                id: model.id,
                event_id: model.event_id,
                event_title: model
                    .event_id
                    .and_then(|event_id| event_titles.get(&event_id).cloned()),
                started_at: model.started_at.to_rfc3339(),
                ended_at: model.ended_at.map(|time| time.to_rfc3339()),
                grouping_method: model.grouping_method,
                grouping_confidence: model.grouping_confidence,
                needs_review: model.needs_review,
                segment_count: segment_counts.get(&model.id).copied().unwrap_or_default(),
                total_players: summary.total_players,
                total_kills: summary.total_kills,
                total_fame: summary.total_fame,
                outcome: resolve_fight_outcome(
                    fight_segments,
                    &snapshots_by_battle,
                    model.event_id,
                    &event_outcomes_by_segment,
                    &config,
                )?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let items = filter_sort_fights(items, &query)?;
    let paginated = paginate_vec(items, &pagination);

    Ok(Json(ApiResponse::new(PaginatedFightList::from(paginated))))
}

#[derive(Debug, Default)]
struct FightListSummary {
    total_players: i64,
    total_kills: i64,
    total_fame: i64,
}

/// Aggregates the summary values that are safe to expose from hydrated segment snapshots.
/// Segments without a snapshot remain part of `segment_count`, but do not fabricate combat data.
fn summarize_fight_segments(
    fight_segments: &[fight_battle::Model],
    snapshots_by_battle: &HashMap<i64, crate::modules::battles::entities::Model>,
) -> FightListSummary {
    let mut summary = FightListSummary::default();
    for segment in fight_segments {
        let Some(snapshot) = snapshots_by_battle.get(&segment.battle_id) else {
            continue;
        };
        summary.total_players = summary.total_players.max(snapshot.total_players);
        summary.total_kills += snapshot.total_kills;
        summary.total_fame += snapshot.total_fame;
    }
    summary
}

fn filter_sort_fights(
    mut items: Vec<FightListItem>,
    query: &FightListQuery,
) -> Result<Vec<FightListItem>, AppError> {
    if let Some(event_id) = query.event_id {
        items.retain(|fight| fight.event_id == Some(event_id));
    }
    if let Some(needs_review) = query.needs_review {
        items.retain(|fight| fight.needs_review == needs_review);
    }
    if let Some(min_players) = query.min_players {
        items.retain(|fight| fight.total_players >= min_players);
    }
    if let Some(search) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let search = search.to_ascii_lowercase();
        items.retain(|fight| {
            fight.id.to_string().contains(&search)
                || fight
                    .event_title
                    .as_deref()
                    .is_some_and(|title| title.to_ascii_lowercase().contains(&search))
        });
    }
    if let Some(outcome) = query
        .outcome
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let expected = parse_fight_outcome(outcome)?;
        items.retain(|fight| fight.outcome.outcome == expected);
    }

    let sort = resolve_sort_key(
        query.sort.as_deref(),
        &[
            ("start_time", FightListSort::StartTime),
            ("started_at", FightListSort::StartTime),
            ("fame", FightListSort::Fame),
            ("kills", FightListSort::Kills),
            ("players", FightListSort::Players),
            ("segments", FightListSort::Segments),
            ("id", FightListSort::Id),
            ("outcome", FightListSort::Outcome),
        ],
        FightListSort::StartTime,
    )?;
    let order = SortOrder::from_query(query.order.as_deref());
    items.sort_by(|left, right| compare_fight_list_items(left, right, sort, order));
    Ok(items)
}

#[derive(Clone, Copy)]
enum FightListSort {
    StartTime,
    Fame,
    Kills,
    Players,
    Segments,
    Id,
    Outcome,
}

fn parse_fight_outcome(value: &str) -> Result<FightOutcome, AppError> {
    match value.to_ascii_lowercase().as_str() {
        "victory" => Ok(FightOutcome::Victory),
        "defeat" => Ok(FightOutcome::Defeat),
        "draw" => Ok(FightOutcome::Draw),
        "unknown" => Ok(FightOutcome::Unknown),
        _ => Err(AppError::Validation(format!(
            "unknown fight outcome '{value}'"
        ))),
    }
}

fn compare_fight_list_items(
    left: &FightListItem,
    right: &FightListItem,
    sort: FightListSort,
    order: SortOrder,
) -> Ordering {
    let comparison = match sort {
        FightListSort::StartTime => left.started_at.cmp(&right.started_at),
        FightListSort::Fame => left.total_fame.cmp(&right.total_fame),
        FightListSort::Kills => left.total_kills.cmp(&right.total_kills),
        FightListSort::Players => left.total_players.cmp(&right.total_players),
        FightListSort::Segments => left.segment_count.cmp(&right.segment_count),
        FightListSort::Id => left.id.cmp(&right.id),
        FightListSort::Outcome => {
            fight_outcome_rank(left.outcome.outcome).cmp(&fight_outcome_rank(right.outcome.outcome))
        }
    };
    let comparison = match order {
        SortOrder::Asc => comparison,
        SortOrder::Desc => comparison.reverse(),
    };
    comparison.then_with(|| match order {
        SortOrder::Asc => left.id.cmp(&right.id),
        SortOrder::Desc => right.id.cmp(&left.id),
    })
}

const fn fight_outcome_rank(outcome: FightOutcome) -> u8 {
    match outcome {
        FightOutcome::Victory => 3,
        FightOutcome::Defeat => 2,
        FightOutcome::Draw => 1,
        FightOutcome::Unknown => 0,
    }
}

async fn load_event_outcomes(
    db: &DatabaseConnection,
    event_ids: &[i64],
    battle_ids: &[i64],
) -> Result<HashMap<(i64, i64), Vec<bool>>, AppError> {
    if event_ids.is_empty() || battle_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows = event_battle::Entity::find()
        .filter(event_battle::Column::EventId.is_in(event_ids.to_vec()))
        .all(db)
        .await
        .map_err(AppError::Database)?;
    let battle_ids = battle_ids.iter().copied().collect::<HashSet<_>>();
    let mut outcomes = HashMap::<(i64, i64), Vec<bool>>::new();
    for row in rows {
        let Ok(battle_id) = row.albionbb_battle_id.parse::<i64>() else {
            continue;
        };
        if battle_ids.contains(&battle_id) {
            outcomes
                .entry((row.event_id, battle_id))
                .or_default()
                .push(row.is_win);
        }
    }
    Ok(outcomes)
}

/// Resolves the canonical Fight outcome without choosing one segment over another.
/// Each inner vector contains all persisted boolean outcomes for a single segment.
fn resolve_persisted_segment_outcomes(segment_evidence: &[Vec<bool>]) -> FightOutcomeView {
    let evidence_count = segment_evidence
        .iter()
        .map(|outcomes| i64::try_from(outcomes.len()).unwrap_or(i64::MAX))
        .sum();
    if segment_evidence.is_empty() {
        return FightOutcomeView {
            outcome: FightOutcome::Unknown,
            evidence_count,
            method: "no_segments".to_string(),
        };
    }

    let mut resolved_segments = Vec::with_capacity(segment_evidence.len());
    for outcomes in segment_evidence {
        let Some(&first) = outcomes.first() else {
            return FightOutcomeView {
                outcome: FightOutcome::Unknown,
                evidence_count,
                method: "incomplete_or_conflicting_segment_evidence".to_string(),
            };
        };
        if outcomes.iter().any(|outcome| *outcome != first) {
            return FightOutcomeView {
                outcome: FightOutcome::Unknown,
                evidence_count,
                method: "incomplete_or_conflicting_segment_evidence".to_string(),
            };
        }
        resolved_segments.push(first);
    }

    let outcome = if resolved_segments.iter().all(|outcome| *outcome) {
        FightOutcome::Victory
    } else if resolved_segments.iter().all(|outcome| !*outcome) {
        FightOutcome::Defeat
    } else {
        FightOutcome::Draw
    };
    FightOutcomeView {
        outcome,
        evidence_count,
        method: match outcome {
            FightOutcome::Draw => "mixed_segment_outcomes",
            FightOutcome::Victory | FightOutcome::Defeat => "unanimous_segment_outcomes",
            FightOutcome::Unknown => unreachable!("unknown is returned above"),
        }
        .to_string(),
    }
}

fn resolve_fight_outcome(
    fight_battles: &[fight_battle::Model],
    snapshots_by_battle: &HashMap<i64, crate::modules::battles::entities::Model>,
    event_id: Option<i64>,
    event_outcomes_by_segment: &HashMap<(i64, i64), Vec<bool>>,
    config: &Config,
) -> Result<FightOutcomeView, AppError> {
    let friendly_guild_ids = config
        .albion_allied_guild_ids()
        .into_iter()
        .chain(std::iter::once(config.albion_guild_id.clone()))
        .collect::<HashSet<_>>();
    let friendly_guild_names = config
        .albion_allied_guild_names()
        .into_iter()
        .map(|name| name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut segment_evidence = Vec::with_capacity(fight_battles.len());

    for segment in fight_battles {
        let mut outcomes = Vec::new();
        if let Some(snapshot) = snapshots_by_battle.get(&segment.battle_id) {
            let guilds: Vec<BattleGuildSummary> =
                parse_snapshot(&snapshot.guilds_json, "guild", snapshot.battle_id)?;
            outcomes.extend(guilds.into_iter().filter_map(|guild| {
                (friendly_guild_ids.contains(&guild.id)
                    || friendly_guild_names.contains(&guild.name.to_ascii_lowercase()))
                .then_some(guild.winner)
            }));
        }
        if let Some(event_id) = event_id {
            if let Some(event_outcomes) =
                event_outcomes_by_segment.get(&(event_id, segment.battle_id))
            {
                outcomes.extend(event_outcomes.iter().copied());
            }
        }
        segment_evidence.push(outcomes);
    }

    Ok(resolve_persisted_segment_outcomes(&segment_evidence))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct MergeFightsRequest {
    /// Fight which remains after the merge. It must also be included in `fight_ids`.
    pub target_fight_id: i64,
    /// Two or more fight IDs to merge. Every fight must belong to the same Event (or none).
    pub fight_ids: Vec<i64>,
}

/// Request to move one Battle segment from the fight in the path to another fight.
#[derive(Debug, Deserialize, ToSchema)]
pub struct MoveBattleRequest {
    /// Canonical AlbionBB battle ID linked to the source fight.
    pub battle_id: i64,
    /// Destination fight. It must belong to the same Event as the source fight (or neither may).
    pub target_fight_id: i64,
}

/// Request to take selected Battle segments out of a fight and form a new fight.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SplitFightRequest {
    /// Canonical AlbionBB battle IDs currently linked to the source fight.
    pub battle_ids: Vec<i64>,
}

/// Result returned by a manual grouping operation.
#[derive(Debug, Serialize, ToSchema)]
pub struct FightMutationResult {
    /// The surviving, destination, or newly created Fight ID.
    pub fight_id: i64,
    /// Existing fights deleted because all of their segments were moved.
    pub deleted_fight_ids: Vec<i64>,
    /// Ordered Battle IDs in `fight_id` after the operation.
    pub battle_ids: Vec<i64>,
}

const MANUAL_GROUPING_METHOD: &str = "manual";
const MANUAL_GROUPING_CONFIDENCE: f64 = 1.0;
const MANUAL_NEEDS_REVIEW: bool = false;

/// Merge selected fights into the supplied target fight.
#[utoipa::path(
    post,
    path = "/api/fights/merge",
    tag = "fights",
    summary = "Manually merge fights",
    security(("session_cookie" = ["fights.manage"])),
    request_body = MergeFightsRequest,
    responses(
        (status = 200, description = "Fights merged", body = FightMutationResult),
        (status = 400, description = "Invalid fight selection", body = crate::errors::ProblemDetails),
        (status = 401, description = "Unauthorized", body = crate::errors::ProblemDetails),
        (status = 403, description = "Missing fights.manage permission", body = crate::errors::ProblemDetails),
        (status = 404, description = "Fight not found", body = crate::errors::ProblemDetails),
        (status = 409, description = "Fights belong to different Events", body = crate::errors::ProblemDetails)
    )
)]
async fn merge_fights(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Json(request): Json<MergeFightsRequest>,
) -> Result<Json<ApiResponse<FightMutationResult>>, AppError> {
    user.require(&perms, Permission::FightsEdit).await?;

    let fight_ids = unique_ids(request.fight_ids, "fight_ids")?;
    if fight_ids.len() < 2 || !fight_ids.contains(&request.target_fight_id) {
        return Err(AppError::Validation(
            "fight_ids must contain at least two unique IDs including target_fight_id".to_string(),
        ));
    }

    let txn = db.begin().await?;
    let fights = load_fights(&txn, &fight_ids).await?;
    let event_id = compatible_event(&fights)?;
    attach_event_if_unassigned(&txn, request.target_fight_id, event_id).await?;
    let segments = fight_battle::Entity::find()
        .filter(fight_battle::Column::FightId.is_in(fight_ids.clone()))
        .all(&txn)
        .await?;
    let source_memberships = fight_ids
        .iter()
        .map(|fight_id| membership_snapshot(*fight_id, &segments))
        .collect::<Vec<_>>();
    let snapshots = snapshots_for_segments(&txn, &segments).await?;
    resequence_groups(&txn, vec![(request.target_fight_id, segments)], &snapshots).await?;
    refresh_manual_fight(&txn, request.target_fight_id, &snapshots).await?;

    let deleted_fight_ids = fight_ids
        .into_iter()
        .filter(|id| *id != request.target_fight_id)
        .collect::<Vec<_>>();
    for fight_id in &deleted_fight_ids {
        fight::Entity::delete_by_id(*fight_id).exec(&txn).await?;
    }
    let battle_ids = ordered_battle_ids(&txn, request.target_fight_id).await?;
    txn.commit().await?;

    log_fight_mutation(
        &db,
        "FIGHT_MERGED",
        request.target_fight_id,
        &user,
        json!({
            "source_memberships": source_memberships,
            "resulting_membership": { "fight_id": request.target_fight_id, "battle_ids": battle_ids },
            "deleted_fight_ids": deleted_fight_ids,
        }),
    )
    .await;

    Ok(Json(ApiResponse::new(FightMutationResult {
        fight_id: request.target_fight_id,
        deleted_fight_ids,
        battle_ids,
    })))
}

/// Move one Battle segment to another fight.
#[utoipa::path(
    post,
    path = "/api/fights/{id}/move-battle",
    tag = "fights",
    summary = "Move a Battle segment to another fight",
    security(("session_cookie" = ["fights.manage"])),
    params(("id" = i64, Path, description = "Source fight ID")),
    request_body = MoveBattleRequest,
    responses((status = 200, description = "Battle moved", body = FightMutationResult))
)]
async fn move_battle(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Path(source_fight_id): Path<i64>,
    Json(request): Json<MoveBattleRequest>,
) -> Result<Json<ApiResponse<FightMutationResult>>, AppError> {
    user.require(&perms, Permission::FightsEdit).await?;

    if source_fight_id == request.target_fight_id {
        return Err(AppError::Validation(
            "the source and target fights must differ".to_string(),
        ));
    }

    let txn = db.begin().await?;
    let fights = load_fights(&txn, &[source_fight_id, request.target_fight_id]).await?;
    let event_id = compatible_event(&fights)?;
    attach_event_if_unassigned(&txn, request.target_fight_id, event_id).await?;
    let source_segments = fight_battle::Entity::find()
        .filter(fight_battle::Column::FightId.eq(source_fight_id))
        .all(&txn)
        .await?;
    if !source_segments
        .iter()
        .any(|segment| segment.battle_id == request.battle_id)
    {
        return Err(AppError::NotFound(format!(
            "Battle {} is not a segment of fight {source_fight_id}",
            request.battle_id
        )));
    }
    let target_segments = fight_battle::Entity::find()
        .filter(fight_battle::Column::FightId.eq(request.target_fight_id))
        .all(&txn)
        .await?;
    let source_membership_before = membership_snapshot(source_fight_id, &source_segments);
    let target_membership_before = membership_snapshot(request.target_fight_id, &target_segments);
    let mut segments = source_segments.clone();
    segments.extend(target_segments.clone());
    let snapshots = snapshots_for_segments(&txn, &segments).await?;
    let moved = source_segments
        .iter()
        .filter(|segment| segment.battle_id == request.battle_id)
        .cloned()
        .collect::<Vec<_>>();
    let remaining_source = source_segments
        .iter()
        .filter(|segment| segment.battle_id != request.battle_id)
        .cloned()
        .collect::<Vec<_>>();
    let source_membership_after = (!remaining_source.is_empty())
        .then(|| membership_snapshot(source_fight_id, &remaining_source));
    let mut destination = target_segments;
    destination.extend(moved);
    let mut groups = vec![(request.target_fight_id, destination)];
    if !remaining_source.is_empty() {
        groups.push((source_fight_id, remaining_source));
    }
    resequence_groups(&txn, groups, &snapshots).await?;

    let deleted_fight_ids = if source_segments.len() == 1 {
        fight::Entity::delete_by_id(source_fight_id)
            .exec(&txn)
            .await?;
        vec![source_fight_id]
    } else {
        refresh_manual_fight(&txn, source_fight_id, &snapshots).await?;
        Vec::new()
    };
    refresh_manual_fight(&txn, request.target_fight_id, &snapshots).await?;
    let battle_ids = ordered_battle_ids(&txn, request.target_fight_id).await?;
    txn.commit().await?;

    log_fight_mutation(
        &db,
        "FIGHT_BATTLE_MOVED",
        request.target_fight_id,
        &user,
        json!({
            "battle_id": request.battle_id,
            "source_membership_before": source_membership_before,
            "target_membership_before": target_membership_before,
            "source_membership_after": source_membership_after,
            "target_membership_after": { "fight_id": request.target_fight_id, "battle_ids": battle_ids },
            "deleted_fight_ids": deleted_fight_ids,
        }),
    )
    .await;

    Ok(Json(ApiResponse::new(FightMutationResult {
        fight_id: request.target_fight_id,
        deleted_fight_ids,
        battle_ids,
    })))
}

/// Split selected Battle segments into a newly-created fight.
#[utoipa::path(
    post,
    path = "/api/fights/{id}/split",
    tag = "fights",
    summary = "Manually split a fight",
    security(("session_cookie" = ["fights.manage"])),
    params(("id" = i64, Path, description = "Source fight ID")),
    request_body = SplitFightRequest,
    responses((status = 200, description = "Fight split", body = FightMutationResult))
)]
async fn split_fight(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Path(source_fight_id): Path<i64>,
    Json(request): Json<SplitFightRequest>,
) -> Result<Json<ApiResponse<FightMutationResult>>, AppError> {
    user.require(&perms, Permission::FightsEdit).await?;

    let battle_ids = unique_ids(request.battle_ids, "battle_ids")?;
    let txn = db.begin().await?;
    let source = load_fights(&txn, &[source_fight_id]).await?.remove(0);
    let source_segments = fight_battle::Entity::find()
        .filter(fight_battle::Column::FightId.eq(source_fight_id))
        .all(&txn)
        .await?;
    if battle_ids.len() >= source_segments.len()
        || !battle_ids.iter().all(|id| {
            source_segments
                .iter()
                .any(|segment| segment.battle_id == *id)
        })
    {
        return Err(AppError::Validation(
            "battle_ids must be a non-empty proper subset of the source fight's segments"
                .to_string(),
        ));
    }
    let source_membership_before = membership_snapshot(source_fight_id, &source_segments);
    let snapshots = snapshots_for_segments(&txn, &source_segments).await?;
    let now = Utc::now().into();
    let mut new_fight = fight::ActiveModel {
        event_id: Set(source.event_id),
        started_at: Set(source.started_at),
        ended_at: Set(source.ended_at),
        grouping_version: Set(source.grouping_version),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    };
    set_manual_fight_metadata(&mut new_fight);
    let new_fight = new_fight.insert(&txn).await?;

    let selected = battle_ids.iter().copied().collect::<HashSet<_>>();
    let moved = source_segments
        .iter()
        .filter(|segment| selected.contains(&segment.battle_id))
        .cloned()
        .collect::<Vec<_>>();
    let remaining = source_segments
        .into_iter()
        .filter(|segment| !selected.contains(&segment.battle_id))
        .collect::<Vec<_>>();
    let source_membership_after = membership_snapshot(source_fight_id, &remaining);
    resequence_groups(
        &txn,
        vec![(source_fight_id, remaining), (new_fight.id, moved)],
        &snapshots,
    )
    .await?;
    refresh_manual_fight(&txn, source_fight_id, &snapshots).await?;
    refresh_manual_fight(&txn, new_fight.id, &snapshots).await?;
    let battle_ids = ordered_battle_ids(&txn, new_fight.id).await?;
    txn.commit().await?;

    log_fight_mutation(
        &db,
        "FIGHT_SPLIT",
        new_fight.id,
        &user,
        json!({
            "source_membership_before": source_membership_before,
            "source_membership_after": source_membership_after,
            "new_membership": { "fight_id": new_fight.id, "battle_ids": battle_ids },
        }),
    )
    .await;

    Ok(Json(ApiResponse::new(FightMutationResult {
        fight_id: new_fight.id,
        deleted_fight_ids: Vec::new(),
        battle_ids,
    })))
}

fn membership_snapshot(fight_id: i64, segments: &[fight_battle::Model]) -> Value {
    let mut battle_ids = segments
        .iter()
        .map(|segment| segment.battle_id)
        .collect::<Vec<_>>();
    battle_ids.sort_unstable();
    json!({ "fight_id": fight_id, "battle_ids": battle_ids })
}

async fn log_fight_mutation(
    db: &DatabaseConnection,
    action: &str,
    fight_id: i64,
    actor: &UserContext,
    details: Value,
) {
    let _ = AuditService::log(
        db,
        action,
        Some("FIGHT"),
        Some(fight_id),
        Some(actor.user_id),
        Some(json!({
            "actor": {
                "user_id": actor.user_id,
                "discord_id": actor.id,
                "username": actor.username,
            },
            "operation": details,
        })),
    )
    .await;
}

fn unique_ids(ids: Vec<i64>, field: &str) -> Result<Vec<i64>, AppError> {
    if ids.is_empty() {
        return Err(AppError::Validation(format!("{field} must not be empty")));
    }
    let unique = ids.iter().copied().collect::<HashSet<_>>();
    if unique.len() != ids.len() {
        return Err(AppError::Validation(format!(
            "{field} must not contain duplicates"
        )));
    }
    Ok(ids)
}

async fn load_fights(db: &DatabaseTransaction, ids: &[i64]) -> Result<Vec<fight::Model>, AppError> {
    let fights = fight::Entity::find()
        .filter(fight::Column::Id.is_in(ids.to_vec()))
        .all(db)
        .await?;
    if fights.len() != ids.len() {
        return Err(AppError::NotFound(
            "one or more fights were not found".to_string(),
        ));
    }
    Ok(fights)
}

fn compatible_event(fights: &[fight::Model]) -> Result<Option<i64>, AppError> {
    let mut event_id = None;
    for fight in fights {
        if let Some(candidate) = fight.event_id {
            match event_id {
                Some(existing) if existing != candidate => {
                    return Err(AppError::Conflict(
                        "manual fight operations cannot cross Event boundaries".to_string(),
                    ));
                }
                None => event_id = Some(candidate),
                Some(_) => {}
            }
        }
    }
    Ok(event_id)
}

async fn attach_event_if_unassigned(
    db: &DatabaseTransaction,
    fight_id: i64,
    event_id: Option<i64>,
) -> Result<(), AppError> {
    let Some(event_id) = event_id else {
        return Ok(());
    };
    let model = fight::Entity::find_by_id(fight_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::Internal(format!("Fight {fight_id} disappeared")))?;
    if model.event_id.is_none() {
        let mut active: fight::ActiveModel = model.into();
        active.event_id = Set(Some(event_id));
        active.updated_at = Set(Utc::now().into());
        active.update(db).await?;
    }
    Ok(())
}

async fn snapshots_for_segments(
    db: &DatabaseTransaction,
    segments: &[fight_battle::Model],
) -> Result<HashMap<i64, crate::modules::battles::entities::Model>, AppError> {
    let battle_ids = segments
        .iter()
        .map(|segment| segment.battle_id)
        .collect::<Vec<_>>();
    let snapshots = GuildBattleSnapshotEntity::find()
        .filter(GuildBattleSnapshotColumn::BattleId.is_in(battle_ids.clone()))
        .all(db)
        .await?;
    let snapshots = snapshots
        .into_iter()
        .map(|snapshot| (snapshot.battle_id, snapshot))
        .collect::<HashMap<_, _>>();
    if snapshots.len() != battle_ids.len() {
        return Err(AppError::Conflict(
            "every segment must have a persisted battle snapshot before regrouping".to_string(),
        ));
    }
    Ok(snapshots)
}

async fn resequence_groups(
    db: &DatabaseTransaction,
    mut groups: Vec<(i64, Vec<fight_battle::Model>)>,
    snapshots: &HashMap<i64, crate::modules::battles::entities::Model>,
) -> Result<(), AppError> {
    let segment_count = groups
        .iter()
        .map(|(_, segments)| segments.len())
        .sum::<usize>();
    let mut temporary_index = 0;
    for (_, segments) in &groups {
        for segment in segments {
            temporary_index += 1;
            let mut active: fight_battle::ActiveModel = segment.clone().into();
            active.sequence_number = Set(-i32::try_from(temporary_index).map_err(|_| {
                AppError::Internal("too many fight segments to resequence".to_string())
            })?);
            active.update(db).await?;
        }
    }
    debug_assert_eq!(temporary_index, segment_count);
    for (fight_id, segments) in &mut groups {
        order_segments(segments, snapshots);
        for (index, segment) in segments.drain(..).enumerate() {
            let mut active: fight_battle::ActiveModel = segment.into();
            active.fight_id = Set(*fight_id);
            active.sequence_number = Set(i32::try_from(index + 1).map_err(|_| {
                AppError::Internal("too many fight segments to resequence".to_string())
            })?);
            active.update(db).await?;
        }
    }
    Ok(())
}

fn order_segments(
    segments: &mut [fight_battle::Model],
    snapshots: &HashMap<i64, crate::modules::battles::entities::Model>,
) {
    segments.sort_by_key(|segment| {
        let snapshot = &snapshots[&segment.battle_id];
        (snapshot.start_time, segment.battle_id)
    });
}

fn set_manual_fight_metadata(fight: &mut fight::ActiveModel) {
    fight.grouping_method = Set(MANUAL_GROUPING_METHOD.to_string());
    fight.grouping_confidence = Set(MANUAL_GROUPING_CONFIDENCE);
    fight.needs_review = Set(MANUAL_NEEDS_REVIEW);
}

async fn refresh_manual_fight(
    db: &DatabaseTransaction,
    fight_id: i64,
    snapshots: &HashMap<i64, crate::modules::battles::entities::Model>,
) -> Result<(), AppError> {
    let segments = fight_battle::Entity::find()
        .filter(fight_battle::Column::FightId.eq(fight_id))
        .all(db)
        .await?;
    let first = segments
        .first()
        .ok_or_else(|| AppError::Internal(format!("cannot refresh empty fight {fight_id}")))?;
    let mut started_at = snapshots[&first.battle_id].start_time;
    let mut ended_at = snapshots[&first.battle_id].end_time;
    for segment in &segments[1..] {
        let snapshot = &snapshots[&segment.battle_id];
        started_at = started_at.min(snapshot.start_time);
        if let Some(end_time) = snapshot.end_time {
            ended_at = Some(ended_at.map_or(end_time, |current| current.max(end_time)));
        }
    }
    let model = fight::Entity::find_by_id(fight_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::Internal(format!("Fight {fight_id} disappeared")))?;
    let mut active: fight::ActiveModel = model.into();
    active.started_at = Set(started_at);
    active.ended_at = Set(ended_at);
    set_manual_fight_metadata(&mut active);
    active.updated_at = Set(Utc::now().into());
    active.update(db).await?;
    Ok(())
}

async fn ordered_battle_ids(db: &DatabaseTransaction, fight_id: i64) -> Result<Vec<i64>, AppError> {
    Ok(fight_battle::Entity::find()
        .filter(fight_battle::Column::FightId.eq(fight_id))
        .order_by_asc(fight_battle::Column::SequenceNumber)
        .all(db)
        .await?
        .into_iter()
        .map(|segment| segment.battle_id)
        .collect())
}

/// Returns 30-day canonical fight trends with transparent snapshot and winner coverage.
#[utoipa::path(
    get,
    path = "/api/fights/trends",
    tag = "fights",
    summary = "Get fight trends",
    description = "Compares the latest 30 days with the preceding 30 days. Combat totals use persisted canonical-fight snapshots; roster build and comp selections use linked event participants.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "Fight trends", body = FightTrendView),
        (status = 401, description = "Unauthorized", body = crate::errors::ProblemDetails)
    )
)]
async fn get_fight_trends(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(config): Extension<Config>,
) -> Result<Json<ApiResponse<FightTrendView>>, AppError> {
    user.require(&perms, Permission::FightsView).await?;
    let window_end = Utc::now();
    let current_start = window_end - Duration::days(30);
    let previous_start = current_start - Duration::days(30);
    let fights = fight::Entity::find()
        .filter(fight::Column::StartedAt.gte(previous_start))
        .filter(fight::Column::StartedAt.lt(window_end))
        .order_by_asc(fight::Column::StartedAt)
        .all(&db)
        .await?;
    let fight_ids = fights.iter().map(|row| row.id).collect::<Vec<_>>();
    let segments = if fight_ids.is_empty() {
        Vec::new()
    } else {
        fight_battle::Entity::find()
            .filter(fight_battle::Column::FightId.is_in(fight_ids))
            .all(&db)
            .await?
    };
    let battle_ids = segments.iter().map(|row| row.battle_id).collect::<Vec<_>>();
    let snapshots = if battle_ids.is_empty() {
        Vec::new()
    } else {
        GuildBattleSnapshotEntity::find()
            .filter(GuildBattleSnapshotColumn::BattleId.is_in(battle_ids))
            .all(&db)
            .await?
    };
    let snapshots_by_battle = snapshots
        .into_iter()
        .map(|snapshot| (snapshot.battle_id, snapshot))
        .collect::<HashMap<_, _>>();
    let mut segments_by_fight = HashMap::<i64, Vec<fight_battle::Model>>::new();
    for segment in segments {
        segments_by_fight
            .entry(segment.fight_id)
            .or_default()
            .push(segment);
    }
    let event_ids = fights
        .iter()
        .filter_map(|row| row.event_id)
        .collect::<HashSet<_>>();
    let events = if event_ids.is_empty() {
        Vec::new()
    } else {
        event::Entity::find()
            .filter(event::Column::Id.is_in(event_ids.into_iter().collect::<Vec<_>>()))
            .all(&db)
            .await?
    };
    let participations = if events.is_empty() {
        Vec::new()
    } else {
        event_participation::Entity::find()
            .filter(event_participation::Column::EventId.is_in(events.iter().map(|row| row.id)))
            .all(&db)
            .await?
    };
    let build_ids = participations
        .iter()
        .flat_map(|row| [row.primary_build_id, row.secondary_build_id])
        .collect::<Vec<_>>();
    let builds = if build_ids.is_empty() {
        Vec::new()
    } else {
        build::Entity::find()
            .filter(build::Column::Id.is_in(build_ids))
            .all(&db)
            .await?
    };
    let comp_ids = events.iter().map(|row| row.comp_id).collect::<Vec<_>>();
    let comps = if comp_ids.is_empty() {
        Vec::new()
    } else {
        comp::Entity::find()
            .filter(comp::Column::Id.is_in(comp_ids))
            .all(&db)
            .await?
    };
    let event_by_id = events
        .into_iter()
        .map(|row| (row.id, row))
        .collect::<HashMap<_, _>>();
    let participations_by_event =
        participations
            .into_iter()
            .fold(HashMap::<i64, Vec<_>>::new(), |mut grouped, row| {
                grouped.entry(row.event_id).or_default().push(row);
                grouped
            });
    let build_names = builds
        .into_iter()
        .map(|row| (row.id, row.name))
        .collect::<HashMap<_, _>>();
    let comp_names = comps
        .into_iter()
        .map(|row| (row.id, row.name))
        .collect::<HashMap<_, _>>();
    let last_30_days = build_fight_trend_period(
        &fights,
        &segments_by_fight,
        &snapshots_by_battle,
        &event_by_id,
        &participations_by_event,
        &build_names,
        &comp_names,
        &config,
        current_start,
        window_end,
    )?;
    let previous_30_days = build_fight_trend_period(
        &fights,
        &segments_by_fight,
        &snapshots_by_battle,
        &event_by_id,
        &participations_by_event,
        &build_names,
        &comp_names,
        &config,
        previous_start,
        current_start,
    )?;
    let rolling_daily_fight_counts = (0..30)
        .map(|offset| {
            let day = current_start.date_naive() + Duration::days(offset);
            FightTrendDay {
                date: day.to_string(),
                fights: i64::try_from(
                    fights
                        .iter()
                        .filter(|fight| fight.started_at.date_naive() == day)
                        .count(),
                )
                .unwrap_or(i64::MAX),
            }
        })
        .collect();
    Ok(Json(ApiResponse::new(FightTrendView {
        generated_at: window_end.to_rfc3339(),
        last_30_days,
        previous_30_days,
        rolling_daily_fight_counts,
    })))
}

fn build_fight_trend_period(
    fights: &[fight::Model],
    segments_by_fight: &HashMap<i64, Vec<fight_battle::Model>>,
    snapshots_by_battle: &HashMap<i64, crate::modules::battles::entities::Model>,
    events_by_id: &HashMap<i64, event::Model>,
    participations_by_event: &HashMap<i64, Vec<event_participation::Model>>,
    build_names: &HashMap<i64, String>,
    comp_names: &HashMap<i64, String>,
    config: &Config,
    window_start: chrono::DateTime<Utc>,
    window_end: chrono::DateTime<Utc>,
) -> Result<FightTrendPeriod, AppError> {
    let period_fights = fights.iter().filter(|fight| {
        let started_at = fight.started_at.with_timezone(&Utc);
        started_at >= window_start && started_at < window_end
    });
    let friendly_guild_ids = config
        .albion_allied_guild_ids()
        .into_iter()
        .chain(std::iter::once(config.albion_guild_id.clone()))
        .collect::<HashSet<_>>();
    let friendly_guild_names = config
        .albion_allied_guild_names()
        .into_iter()
        .map(|name| name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut fight_sample_size = 0_i64;
    let mut combat_sample_size = 0_i64;
    let mut win_sample_size = 0_i64;
    let mut wins = 0_i64;
    let mut kills = 0_i64;
    let mut deaths = 0_i64;
    let mut kill_fame = 0_i64;
    let mut persisted_segments = 0_i64;
    let mut total_segments = 0_i64;
    let mut linked_event_fights = 0_i64;
    let mut linked_event_ids = HashSet::new();
    let mut planned_participant_assignments = 0_i64;
    let mut primary_builds = HashMap::<i64, i64>::new();
    let mut secondary_builds = HashMap::<i64, i64>::new();
    let mut comps = HashMap::<i64, i64>::new();

    for fight in period_fights {
        fight_sample_size += 1;
        let segments = segments_by_fight
            .get(&fight.id)
            .map_or(&[][..], Vec::as_slice);
        total_segments += i64::try_from(segments.len()).unwrap_or(i64::MAX);
        let mut has_snapshot = false;
        let mut winner = None;
        for segment in segments {
            let Some(snapshot) = snapshots_by_battle.get(&segment.battle_id) else {
                continue;
            };
            has_snapshot = true;
            persisted_segments += 1;
            let snapshot_players: Vec<BattlePlayer> =
                parse_snapshot(&snapshot.players_json, "player", snapshot.battle_id)?;
            for player in snapshot_players.into_iter().filter(|player| {
                friendly_guild_ids.contains(&player.guild_id)
                    || friendly_guild_names.contains(&player.guild_name.to_ascii_lowercase())
            }) {
                kills += player.kills;
                deaths += player.deaths;
                kill_fame += player.kill_fame;
            }
            let snapshot_guilds: Vec<BattleGuildSummary> =
                parse_snapshot(&snapshot.guilds_json, "guild", snapshot.battle_id)?;
            for guild in snapshot_guilds.into_iter().filter(|guild| {
                friendly_guild_ids.contains(&guild.id)
                    || friendly_guild_names.contains(&guild.name.to_ascii_lowercase())
            }) {
                winner = Some(winner.unwrap_or(false) || guild.winner);
            }
        }
        if has_snapshot {
            combat_sample_size += 1;
        }
        if let Some(winner) = winner {
            win_sample_size += 1;
            if winner {
                wins += 1;
            }
        }
        if let Some(event_id) = fight.event_id {
            linked_event_fights += 1;
            linked_event_ids.insert(event_id);
            if let Some(event) = events_by_id.get(&event_id) {
                *comps.entry(event.comp_id).or_default() += 1;
            }
            if let Some(participations) = participations_by_event.get(&event_id) {
                for participation in participations {
                    planned_participant_assignments += 1;
                    if let Some(build_id) = participation.primary_build_id {
                        *primary_builds.entry(build_id).or_default() += 1;
                    }
                    if let Some(build_id) = participation.secondary_build_id {
                        *secondary_builds.entry(build_id).or_default() += 1;
                    }
                }
            }
        }
    }
    let fights_with_snapshots = combat_sample_size;
    let fights_with_winner_data = win_sample_size;
    let selection_counts = |counts: HashMap<i64, i64>, names: &HashMap<i64, String>| {
        let mut values = counts
            .into_iter()
            .map(|(id, count)| FightTrendSelectionCount {
                id,
                name: names.get(&id).cloned(),
                count,
            })
            .collect::<Vec<_>>();
        values.sort_by(|left, right| {
            right
                .count
                .cmp(&left.count)
                .then_with(|| left.id.cmp(&right.id))
        });
        values
    };
    Ok(FightTrendPeriod {
        window_started_at: window_start.to_rfc3339(),
        window_ended_at: window_end.to_rfc3339(),
        fight_sample_size,
        combat_sample_size,
        win_sample_size,
        wins,
        losses: win_sample_size - wins,
        win_rate: (win_sample_size > 0).then(|| wins as f64 / win_sample_size as f64),
        kills,
        deaths,
        kd_ratio: (deaths > 0).then(|| kills as f64 / deaths as f64),
        kill_fame,
        coverage: FightTrendCoverage {
            fights_with_snapshots,
            persisted_segments,
            total_segments,
            fights_with_winner_data,
            linked_event_fights,
            linked_events: i64::try_from(linked_event_ids.len()).unwrap_or(i64::MAX),
        },
        planned_participation: FightTrendPlannedParticipation {
            linked_fights: linked_event_fights,
            linked_events: i64::try_from(linked_event_ids.len()).unwrap_or(i64::MAX),
            planned_participant_assignments,
            primary_build_assignments: selection_counts(primary_builds, build_names),
            secondary_build_assignments: selection_counts(secondary_builds, build_names),
            comp_assignments: selection_counts(comps, comp_names),
        },
    })
}

/// Returns one Fight with persisted performance and roster-observation analytics.
#[utoipa::path(
    get,
    path = "/api/fights/{id}",
    tag = "fights",
    summary = "Get Fight detail and roster coverage",
    security(("session_cookie" = [])),
    params(("id" = i64, Path, description = "Fight ID")),
    responses(
        (status = 200, description = "Fight detail", body = FightDetailView),
        (status = 401, description = "Unauthorized", body = crate::errors::ProblemDetails),
        (status = 404, description = "Fight not found", body = crate::errors::ProblemDetails)
    )
)]
async fn get_fight(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(config): Extension<Config>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<FightDetailView>>, AppError> {
    user.require(&perms, Permission::FightsView).await?;
    let model = fight::Entity::find_by_id(id)
        .one(&db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Fight {id} not found")))?;
    let fight_battles = fight_battle::Entity::find()
        .filter(fight_battle::Column::FightId.eq(id))
        .order_by_asc(fight_battle::Column::SequenceNumber)
        .all(&db)
        .await
        .map_err(AppError::Database)?;
    let battle_ids = fight_battles
        .iter()
        .map(|segment| segment.battle_id)
        .collect::<Vec<_>>();

    let snapshots = if battle_ids.is_empty() {
        Vec::new()
    } else {
        GuildBattleSnapshotEntity::find()
            .filter(GuildBattleSnapshotColumn::BattleId.is_in(battle_ids.clone()))
            .all(&db)
            .await
            .map_err(AppError::Database)?
    };
    let snapshots_by_battle = snapshots
        .into_iter()
        .map(|snapshot| (snapshot.battle_id, snapshot))
        .collect::<HashMap<_, _>>();
    let outcome = resolve_fight_outcome(
        &fight_battles,
        &snapshots_by_battle,
        model.event_id,
        &load_event_outcomes(
            &db,
            &model.event_id.into_iter().collect::<Vec<_>>(),
            &battle_ids,
        )
        .await?,
        &config,
    )?;
    let analytics = build_fight_analytics(&fight_battles, &snapshots_by_battle)?;
    let mut observed_friendly_players = observed_friendly_players(&snapshots_by_battle, &config)?;
    let planned_comp = fight_planned_comp(&db, model.event_id).await?;
    let (planned_participants, participant_coverage) = fight_participant_analytics(
        &db,
        model.event_id,
        &mut observed_friendly_players,
        i64::try_from(snapshots_by_battle.len()).unwrap_or(i64::MAX),
        i64::try_from(fight_battles.len()).unwrap_or(i64::MAX),
    )
    .await?;

    Ok(Json(ApiResponse::new(FightDetailView {
        id: model.id,
        event_id: model.event_id,
        started_at: model.started_at.to_rfc3339(),
        ended_at: model.ended_at.map(|time| time.to_rfc3339()),
        grouping_method: model.grouping_method,
        grouping_confidence: model.grouping_confidence,
        needs_review: model.needs_review,
        outcome,
        battle_ids,
        segment_count: i64::try_from(fight_battles.len()).unwrap_or(i64::MAX),
        total_players: analytics.total_players,
        total_kills: analytics.total_kills,
        total_fame: analytics.total_fame,
        unique_players: i64::try_from(analytics.player_ids.len()).unwrap_or(i64::MAX),
        guilds: analytics.guilds,
        players: analytics.players,
        estimated_losses: analytics.estimated_losses,
        segments: analytics.segments,
        observed_friendly_players,
        planned_comp,
        planned_participants,
        participant_coverage,
    })))
}

async fn fight_planned_comp(
    db: &DatabaseConnection,
    event_id: Option<i64>,
) -> Result<Option<FightPlannedCompView>, AppError> {
    let Some(event_id) = event_id else {
        return Ok(None);
    };
    let event = event::Entity::find_by_id(event_id).one(db).await?;
    let Some(event) = event else {
        return Ok(None);
    };
    let comp_name = comp::Entity::find_by_id(event.comp_id)
        .one(db)
        .await?
        .map(|comp| comp.name);
    Ok(Some(FightPlannedCompView {
        id: event.comp_id,
        name: comp_name,
    }))
}

fn observed_friendly_players(
    snapshots_by_battle: &HashMap<i64, crate::modules::battles::entities::Model>,
    config: &Config,
) -> Result<Vec<ObservedFriendlyPlayerView>, AppError> {
    let friendly_guild_ids = config
        .albion_allied_guild_ids()
        .into_iter()
        .chain(std::iter::once(config.albion_guild_id.clone()))
        .collect::<HashSet<_>>();
    let friendly_guild_names = config
        .albion_allied_guild_names()
        .into_iter()
        .map(|name| name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut players = HashMap::<String, PlayerRollup>::new();

    for snapshot in snapshots_by_battle.values() {
        let snapshot_players: Vec<BattlePlayer> =
            parse_snapshot(&snapshot.players_json, "player", snapshot.battle_id)?;
        for player in snapshot_players.into_iter().filter(|player| {
            friendly_guild_ids.contains(&player.guild_id)
                || friendly_guild_names.contains(&player.guild_name.to_ascii_lowercase())
        }) {
            players
                .entry(player.id.clone())
                .or_insert_with(|| PlayerRollup::new(player.clone()))
                .add(&player);
        }
    }

    let mut observed = players
        .into_values()
        .map(|rollup| {
            let segments_observed = rollup.appearances;
            let player = rollup.into_player();
            ObservedFriendlyPlayerView {
                albion_player_id: player.id,
                name: player.name,
                guild_id: player.guild_id,
                guild_name: player.guild_name,
                segments_observed,
                kills: player.kills,
                deaths: player.deaths,
                kill_fame: player.kill_fame,
                death_fame: player.death_fame,
                average_item_power: player.item_power,
                user_id: None,
            }
        })
        .collect::<Vec<_>>();
    observed.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(observed)
}

async fn fight_participant_analytics(
    db: &DatabaseConnection,
    event_id: Option<i64>,
    observed_players: &mut [ObservedFriendlyPlayerView],
    persisted_segments: i64,
    total_segments: i64,
) -> Result<(Vec<PlannedFightParticipantView>, FightParticipantCoverage), AppError> {
    let Some(event_id) = event_id else {
        return Ok((
            Vec::new(),
            FightParticipantCoverage {
                event_linked: false,
                planned_participants: 0,
                matchable_planned_participants: 0,
                observed_planned_participants: 0,
                unmatched_planned_participants: 0,
                unplanned_observed_players: i64::try_from(observed_players.len())
                    .unwrap_or(i64::MAX),
                persisted_segments,
                total_segments,
            },
        ));
    };

    let participations = event_participation::Entity::find()
        .filter(event_participation::Column::EventId.eq(event_id))
        .order_by_asc(event_participation::Column::CreatedAt)
        .all(db)
        .await?;
    let user_ids = participations
        .iter()
        .map(|row| row.user_id)
        .collect::<Vec<_>>();
    let build_ids = participations
        .iter()
        .flat_map(|row| [row.primary_build_id, row.secondary_build_id])
        .collect::<Vec<_>>();
    let users = user::Entity::find()
        .filter(user::Column::Id.is_in(user_ids))
        .all(db)
        .await?;
    let builds = build::Entity::find()
        .filter(build::Column::Id.is_in(build_ids))
        .all(db)
        .await?;
    let links = albion_link::Entity::find().all(db).await?;
    let users_by_id = users
        .into_iter()
        .map(|row| (row.id, row))
        .collect::<HashMap<_, _>>();
    let build_names = builds
        .into_iter()
        .map(|row| (row.id, row.name))
        .collect::<HashMap<_, _>>();
    let albion_ids_by_discord = links
        .into_iter()
        .map(|row| (row.discord_id, row.albion_player_id))
        .collect::<HashMap<_, _>>();
    let observed_ids = observed_players
        .iter()
        .map(|player| player.albion_player_id.clone())
        .collect::<HashSet<_>>();
    let mut matched_user_ids = HashSet::new();
    let mut planned = Vec::with_capacity(participations.len());

    for participation in participations {
        let user = users_by_id.get(&participation.user_id);
        let albion_player_id = user
            .and_then(|user| user.discord_id.as_ref())
            .and_then(|discord_id| albion_ids_by_discord.get(discord_id))
            .cloned();
        let observed = albion_player_id
            .as_ref()
            .is_some_and(|player_id| observed_ids.contains(player_id));
        if observed {
            matched_user_ids.insert(participation.user_id);
        }
        planned.push(PlannedFightParticipantView {
            user_id: participation.user_id,
            username: user.map_or_else(|| "Unknown user".to_string(), |user| user.username.clone()),
            albion_player_id,
            primary_build_id: participation.primary_build_id,
            primary_build_name: participation
                .primary_build_id
                .and_then(|build_id| build_names.get(&build_id).cloned()),
            secondary_build_id: participation.secondary_build_id,
            secondary_build_name: participation
                .secondary_build_id
                .and_then(|build_id| build_names.get(&build_id).cloned()),
            observed,
        });
    }

    let user_ids_by_albion = planned
        .iter()
        .filter_map(|participant| {
            participant
                .albion_player_id
                .as_ref()
                .map(|id| (id, participant.user_id))
        })
        .collect::<HashMap<_, _>>();
    for player in observed_players.iter_mut() {
        player.user_id = user_ids_by_albion.get(&player.albion_player_id).copied();
    }
    let planned_participants = i64::try_from(planned.len()).unwrap_or(i64::MAX);
    let matchable_planned_participants = i64::try_from(
        planned
            .iter()
            .filter(|participant| participant.albion_player_id.is_some())
            .count(),
    )
    .unwrap_or(i64::MAX);
    let observed_planned_participants = i64::try_from(matched_user_ids.len()).unwrap_or(i64::MAX);
    let unplanned_observed_players = i64::try_from(
        observed_players
            .iter()
            .filter(|player| player.user_id.is_none())
            .count(),
    )
    .unwrap_or(i64::MAX);

    Ok((
        planned,
        FightParticipantCoverage {
            event_linked: true,
            planned_participants,
            matchable_planned_participants,
            observed_planned_participants,
            unmatched_planned_participants: planned_participants - matchable_planned_participants,
            unplanned_observed_players,
            persisted_segments,
            total_segments,
        },
    ))
}

struct FightAnalytics {
    total_players: i64,
    total_kills: i64,
    total_fame: i64,
    player_ids: HashSet<String>,
    guilds: Vec<BattleGuildSummary>,
    players: Vec<BattlePlayer>,
    estimated_losses: BattleLossEstimate,
    segments: Vec<FightSegmentSummary>,
}

fn build_fight_analytics(
    fight_battles: &[fight_battle::Model],
    snapshots_by_battle: &HashMap<i64, crate::modules::battles::entities::Model>,
) -> Result<FightAnalytics, AppError> {
    let mut total_players = 0;
    let mut total_kills = 0;
    let mut total_fame = 0;
    let mut player_ids = HashSet::new();
    let mut guilds = HashMap::<String, GuildRollup>::new();
    let mut players = HashMap::<String, PlayerRollup>::new();
    let mut estimated_losses = BattleLossEstimate::default();
    let mut loss_players = HashMap::<String, PlayerLossEstimate>::new();
    let mut loss_guilds = HashMap::<String, GuildLossEstimate>::new();
    let mut segments = Vec::new();

    for segment in fight_battles {
        let Some(snapshot) = snapshots_by_battle.get(&segment.battle_id) else {
            continue;
        };
        let snapshot_guilds: Vec<BattleGuildSummary> =
            parse_snapshot(&snapshot.guilds_json, "guild", snapshot.battle_id)?;
        let snapshot_players: Vec<BattlePlayer> =
            parse_snapshot(&snapshot.players_json, "player", snapshot.battle_id)?;
        let snapshot_losses: BattleLossEstimate =
            parse_snapshot(&snapshot.losses_json, "loss", snapshot.battle_id)?;

        total_players = total_players.max(snapshot.total_players);
        total_kills += snapshot.total_kills;
        total_fame += snapshot.total_fame;
        segments.push(FightSegmentSummary {
            battle_id: snapshot.battle_id,
            sequence_number: segment.sequence_number,
            started_at: snapshot.start_time.to_rfc3339(),
            ended_at: snapshot.end_time.map(|time| time.to_rfc3339()),
            total_players: snapshot.total_players,
            total_kills: snapshot.total_kills,
            total_fame: snapshot.total_fame,
        });

        for guild in snapshot_guilds {
            guilds
                .entry(guild_key(&guild.id, &guild.name))
                .or_insert_with(|| GuildRollup::new(guild.clone()))
                .add_summary(&guild);
        }
        for player in snapshot_players {
            player_ids.insert(player.id.clone());
            guilds
                .entry(guild_key(&player.guild_id, &player.guild_name))
                .or_insert_with(|| GuildRollup::from_player(&player))
                .players
                .insert(player.id.clone());
            players
                .entry(player.id.clone())
                .or_insert_with(|| PlayerRollup::new(player.clone()))
                .add(&player);
        }
        add_loss_estimate(
            &mut estimated_losses,
            &mut loss_players,
            &mut loss_guilds,
            snapshot_losses,
        );
    }

    estimated_losses.players = loss_players.into_values().collect();
    estimated_losses.players.sort_by(|left, right| {
        right
            .estimated_loss
            .cmp(&left.estimated_loss)
            .then_with(|| left.player_name.cmp(&right.player_name))
    });
    estimated_losses.guilds = loss_guilds.into_values().collect();
    estimated_losses.guilds.sort_by(|left, right| {
        right
            .estimated_loss
            .cmp(&left.estimated_loss)
            .then_with(|| left.guild_name.cmp(&right.guild_name))
    });

    let mut guilds = guilds
        .into_values()
        .map(GuildRollup::into_summary)
        .collect::<Vec<_>>();
    guilds.sort_by(|left, right| {
        right
            .kill_fame
            .cmp(&left.kill_fame)
            .then_with(|| left.name.cmp(&right.name))
    });
    let mut players = players
        .into_values()
        .map(PlayerRollup::into_player)
        .collect::<Vec<_>>();
    players.sort_by(|left, right| {
        right
            .kill_fame
            .cmp(&left.kill_fame)
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(FightAnalytics {
        total_players,
        total_kills,
        total_fame,
        player_ids,
        guilds,
        players,
        estimated_losses,
        segments,
    })
}

fn parse_snapshot<T: serde::de::DeserializeOwned>(
    json: &str,
    kind: &str,
    battle_id: i64,
) -> Result<T, AppError> {
    serde_json::from_str(json).map_err(|error| {
        AppError::Internal(format!(
            "Failed to parse {kind} snapshot for battle {battle_id}: {error}"
        ))
    })
}

fn guild_key(id: &str, name: &str) -> String {
    if id.is_empty() {
        format!("name:{name}")
    } else {
        format!("id:{id}")
    }
}

struct GuildRollup {
    summary: BattleGuildSummary,
    players: HashSet<String>,
    item_power_total: f64,
    item_power_weight: i64,
}

impl GuildRollup {
    fn new(mut summary: BattleGuildSummary) -> Self {
        summary.players = 0;
        summary.kills = 0;
        summary.deaths = 0;
        summary.kill_fame = 0;
        summary.winner = false;
        summary.average_item_power = 0.0;
        Self {
            summary,
            players: HashSet::new(),
            item_power_total: 0.0,
            item_power_weight: 0,
        }
    }

    fn from_player(player: &BattlePlayer) -> Self {
        Self::new(BattleGuildSummary {
            id: player.guild_id.clone(),
            name: player.guild_name.clone(),
            alliance_name: player.alliance_name.clone(),
            alliance_id: player.alliance_id.clone(),
            players: 0,
            kills: 0,
            deaths: 0,
            kill_fame: 0,
            winner: false,
            average_item_power: 0.0,
        })
    }

    fn add_summary(&mut self, summary: &BattleGuildSummary) {
        self.summary.kills += summary.kills;
        self.summary.deaths += summary.deaths;
        self.summary.kill_fame += summary.kill_fame;
        self.summary.winner |= summary.winner;
        self.item_power_total += summary.average_item_power * summary.players as f64;
        self.item_power_weight += summary.players;
    }

    fn into_summary(mut self) -> BattleGuildSummary {
        self.summary.players = i64::try_from(self.players.len()).unwrap_or(i64::MAX);
        self.summary.average_item_power = if self.item_power_weight > 0 {
            self.item_power_total / self.item_power_weight as f64
        } else {
            0.0
        };
        self.summary
    }
}

struct PlayerRollup {
    player: BattlePlayer,
    item_power_total: f64,
    appearances: i64,
}

impl PlayerRollup {
    fn new(mut player: BattlePlayer) -> Self {
        player.kills = 0;
        player.deaths = 0;
        player.kill_fame = 0;
        player.death_fame = 0;
        player.item_power = 0.0;
        Self {
            player,
            item_power_total: 0.0,
            appearances: 0,
        }
    }

    fn add(&mut self, player: &BattlePlayer) {
        self.player.kills += player.kills;
        self.player.deaths += player.deaths;
        self.player.kill_fame += player.kill_fame;
        self.player.death_fame += player.death_fame;
        self.item_power_total += player.item_power;
        self.appearances += 1;
    }

    fn into_player(mut self) -> BattlePlayer {
        self.player.item_power = self.item_power_total / self.appearances as f64;
        self.player
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use sea_orm::Database;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect to in-memory SQLite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("run database migrations");
        db
    }

    fn timestamp(offset_hours: i64) -> sea_orm::prelude::DateTimeWithTimeZone {
        (Utc::now() + Duration::hours(offset_hours)).into()
    }

    fn test_config() -> Config {
        Config {
            backend_port: 3000,
            database_url: "sqlite::memory:".to_string(),
            discord_client_id: "test".to_string(),
            discord_client_secret: "test".to_string(),
            discord_redirect_uri: "http://localhost/callback".to_string(),
            discord_guild_id: "test-guild".to_string(),
            bot_api_secret: None,
            discord_bot_token: None,
            super_admin_discord_id: "test-admin".to_string(),
            frontend_url: "http://localhost".to_string(),
            albion_api_region: "europe".to_string(),
            albion_guild_id: "friendly".to_string(),
            albion_allied_guild_ids: String::new(),
            albion_allied_guild_names: String::new(),
            mistral_api_key: String::new(),
            albionbb_base_url: "http://localhost".to_string(),
            albionbb_request_timeout_secs: 60,
            albiondata_request_timeout_secs: 30,
            session_secret: "test-session-secret-at-least-64-bytes-long-000000000000000000000000"
                .to_string(),
        }
    }

    fn test_admin() -> UserContext {
        UserContext {
            id: "test-admin".to_string(),
            username: "Test Admin".to_string(),
            email: None,
            avatar: None,
            roles: Vec::new(),
            highest_role: "Admin".to_string(),
            user_id: 1,
            super_admin_id: Some("test-admin".to_string()),
        }
    }

    async fn insert_fight(
        db: &DatabaseConnection,
        started_at: sea_orm::prelude::DateTimeWithTimeZone,
    ) -> fight::Model {
        fight::ActiveModel {
            started_at: Set(started_at),
            ended_at: Set(None),
            grouping_method: Set("automatic".to_string()),
            grouping_confidence: Set(0.5),
            grouping_version: Set("test".to_string()),
            needs_review: Set(true),
            created_at: Set(started_at),
            updated_at: Set(started_at),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight")
    }

    async fn insert_snapshot(
        db: &DatabaseConnection,
        battle_id: i64,
        started_at: sea_orm::prelude::DateTimeWithTimeZone,
        ended_at: Option<sea_orm::prelude::DateTimeWithTimeZone>,
        total_players: i64,
        total_kills: i64,
        total_fame: i64,
        guilds: Vec<BattleGuildSummary>,
        players: Vec<BattlePlayer>,
        losses: BattleLossEstimate,
    ) {
        crate::modules::battles::entities::ActiveModel {
            battle_id: Set(battle_id),
            start_time: Set(started_at),
            end_time: Set(ended_at),
            total_players: Set(total_players),
            total_kills: Set(total_kills),
            total_fame: Set(total_fame),
            guilds_json: Set(serde_json::to_string(&guilds).expect("serialize guilds")),
            players_json: Set(serde_json::to_string(&players).expect("serialize players")),
            kills_json: Set("[]".to_string()),
            losses_json: Set(serde_json::to_string(&losses).expect("serialize losses")),
            fetched_at: Set(started_at),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert battle snapshot");
    }

    async fn insert_segment(db: &DatabaseConnection, fight_id: i64, battle_id: i64, sequence: i32) {
        fight_battle::ActiveModel {
            fight_id: Set(fight_id),
            battle_id: Set(battle_id),
            sequence_number: Set(sequence),
            created_at: Set(timestamp(0)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight segment");
    }

    fn guild(
        players: i64,
        kills: i64,
        deaths: i64,
        kill_fame: i64,
        winner: bool,
        item_power: f64,
    ) -> BattleGuildSummary {
        BattleGuildSummary {
            id: "friendly".to_string(),
            name: "Weaklings".to_string(),
            alliance_name: None,
            alliance_id: None,
            players,
            kills,
            deaths,
            kill_fame,
            winner,
            average_item_power: item_power,
        }
    }

    fn player(id: &str, kills: i64, deaths: i64, kill_fame: i64, item_power: f64) -> BattlePlayer {
        BattlePlayer {
            id: id.to_string(),
            name: id.to_string(),
            guild_id: "friendly".to_string(),
            guild_name: "Weaklings".to_string(),
            alliance_name: None,
            alliance_id: None,
            kills,
            deaths,
            kill_fame,
            death_fame: deaths * 10,
            item_power,
        }
    }

    fn fight_with_event(event_id: Option<i64>) -> fight::Model {
        let now = Utc::now().into();
        fight::Model {
            id: 1,
            event_id,
            started_at: now,
            ended_at: None,
            grouping_method: "automatic".to_string(),
            grouping_confidence: 0.5,
            grouping_version: "test".to_string(),
            needs_review: true,
            created_at: now,
            updated_at: now,
        }
    }

    fn segment(battle_id: i64, sequence_number: i32) -> fight_battle::Model {
        fight_battle::Model {
            id: battle_id,
            fight_id: 7,
            battle_id,
            sequence_number,
            created_at: Utc::now().into(),
        }
    }

    fn list_item(
        id: i64,
        event_id: Option<i64>,
        total_players: i64,
        total_kills: i64,
        total_fame: i64,
        outcome: FightOutcome,
    ) -> FightListItem {
        FightListItem {
            id,
            event_id,
            event_title: Some(format!("Event {id}")),
            started_at: format!("2026-01-{id:02}T00:00:00Z"),
            ended_at: None,
            grouping_method: "automatic".to_string(),
            grouping_confidence: 1.0,
            needs_review: false,
            segment_count: 1,
            total_players,
            total_kills,
            total_fame,
            outcome: FightOutcomeView {
                outcome,
                evidence_count: 1,
                method: "test".to_string(),
            },
        }
    }

    #[tokio::test]
    async fn manual_mutations_persist_resequenced_segments_and_metadata() {
        let db = seed_db().await;
        let earlier = timestamp(-2);
        let later = timestamp(-1);
        let first_end = timestamp(0);
        let target = insert_fight(&db, later).await;
        let source = insert_fight(&db, earlier).await;
        insert_snapshot(
            &db,
            100,
            later,
            Some(first_end),
            10,
            1,
            100,
            Vec::new(),
            Vec::new(),
            BattleLossEstimate::default(),
        )
        .await;
        insert_snapshot(
            &db,
            200,
            earlier,
            Some(later),
            20,
            2,
            200,
            Vec::new(),
            Vec::new(),
            BattleLossEstimate::default(),
        )
        .await;
        insert_segment(&db, target.id, 100, 1).await;
        insert_segment(&db, source.id, 200, 1).await;

        let Json(merged) = merge_fights(
            test_admin(),
            Extension(Permissions::new_empty()),
            Extension(db.clone()),
            Json(MergeFightsRequest {
                target_fight_id: target.id,
                fight_ids: vec![target.id, source.id],
            }),
        )
        .await
        .expect("merge fights");
        assert_eq!(merged.data.battle_ids, [200, 100]);
        assert_eq!(merged.data.deleted_fight_ids, [source.id]);

        let merged_fight = fight::Entity::find_by_id(target.id)
            .one(&db)
            .await
            .expect("query merged fight")
            .expect("merged fight remains");
        assert_eq!(merged_fight.started_at, earlier);
        assert_eq!(merged_fight.ended_at, Some(first_end));
        assert_eq!(merged_fight.grouping_method, MANUAL_GROUPING_METHOD);
        assert_eq!(merged_fight.grouping_confidence, MANUAL_GROUPING_CONFIDENCE);
        assert!(!merged_fight.needs_review);
        assert!(
            fight::Entity::find_by_id(source.id)
                .one(&db)
                .await
                .expect("query deleted source")
                .is_none()
        );

        let Json(split) = split_fight(
            test_admin(),
            Extension(Permissions::new_empty()),
            Extension(db.clone()),
            Path(target.id),
            Json(SplitFightRequest {
                battle_ids: vec![100],
            }),
        )
        .await
        .expect("split merged fight");
        assert_eq!(split.data.battle_ids, [100]);

        let Json(moved) = move_battle(
            test_admin(),
            Extension(Permissions::new_empty()),
            Extension(db.clone()),
            Path(split.data.fight_id),
            Json(MoveBattleRequest {
                battle_id: 100,
                target_fight_id: target.id,
            }),
        )
        .await
        .expect("move split segment back");
        assert_eq!(moved.data.battle_ids, [200, 100]);
        assert_eq!(moved.data.deleted_fight_ids, [split.data.fight_id]);

        let persisted = fight_battle::Entity::find()
            .filter(fight_battle::Column::FightId.eq(target.id))
            .order_by_asc(fight_battle::Column::SequenceNumber)
            .all(&db)
            .await
            .expect("query resequenced segments");
        assert_eq!(
            persisted
                .iter()
                .map(|segment| (segment.battle_id, segment.sequence_number))
                .collect::<Vec<_>>(),
            [(200, 1), (100, 2)]
        );
    }

    #[tokio::test]
    async fn fight_detail_aggregates_persisted_segment_snapshots() {
        let db = seed_db().await;
        let first_start = timestamp(-2);
        let second_start = timestamp(-1);
        let fight = insert_fight(&db, first_start).await;
        insert_snapshot(
            &db,
            501,
            first_start,
            Some(second_start),
            10,
            4,
            100,
            vec![guild(2, 2, 1, 50, true, 1200.0)],
            vec![
                player("alpha", 1, 0, 40, 1200.0),
                player("bravo", 1, 1, 10, 1200.0),
            ],
            BattleLossEstimate {
                total_estimated_loss: 100,
                priced_items: 1,
                total_items: 2,
                players: vec![PlayerLossEstimate {
                    player_name: "alpha".to_string(),
                    guild_name: Some("Weaklings".to_string()),
                    estimated_loss: 100,
                    deaths: 1,
                    priced_items: 1,
                    total_items: 2,
                }],
                guilds: vec![GuildLossEstimate {
                    guild_name: "Weaklings".to_string(),
                    estimated_loss: 100,
                    deaths: 1,
                    priced_items: 1,
                    total_items: 2,
                }],
            },
        )
        .await;
        insert_snapshot(
            &db,
            502,
            second_start,
            None,
            15,
            3,
            200,
            vec![guild(2, 3, 2, 60, true, 1400.0)],
            vec![
                player("alpha", 2, 1, 60, 1400.0),
                player("charlie", 1, 1, 30, 1400.0),
            ],
            BattleLossEstimate {
                total_estimated_loss: 250,
                priced_items: 2,
                total_items: 3,
                players: vec![PlayerLossEstimate {
                    player_name: "alpha".to_string(),
                    guild_name: Some("Weaklings".to_string()),
                    estimated_loss: 250,
                    deaths: 2,
                    priced_items: 2,
                    total_items: 3,
                }],
                guilds: vec![GuildLossEstimate {
                    guild_name: "Weaklings".to_string(),
                    estimated_loss: 250,
                    deaths: 2,
                    priced_items: 2,
                    total_items: 3,
                }],
            },
        )
        .await;
        insert_segment(&db, fight.id, 501, 1).await;
        insert_segment(&db, fight.id, 502, 2).await;

        let Json(response) = get_fight(
            test_admin(),
            Extension(Permissions::new_empty()),
            Extension(db),
            Extension(test_config()),
            Path(fight.id),
        )
        .await
        .expect("get fight detail");
        let detail = response.data;

        assert_eq!(detail.battle_ids, [501, 502]);
        assert_eq!(detail.segment_count, 2);
        assert_eq!(detail.total_players, 15);
        assert_eq!(detail.total_kills, 7);
        assert_eq!(detail.total_fame, 300);
        assert_eq!(detail.unique_players, 3);
        assert_eq!(detail.outcome.outcome, FightOutcome::Victory);
        assert_eq!(detail.outcome.evidence_count, 2);
        assert_eq!(detail.guilds.len(), 1);
        assert_eq!(detail.guilds[0].players, 3);
        assert_eq!(detail.guilds[0].kills, 5);
        assert_eq!(detail.guilds[0].deaths, 3);
        assert_eq!(detail.guilds[0].kill_fame, 110);
        assert_eq!(detail.guilds[0].average_item_power, 1300.0);
        assert_eq!(detail.players[0].id, "alpha");
        assert_eq!(detail.players[0].kills, 3);
        assert_eq!(detail.players[0].item_power, 1300.0);
        assert_eq!(detail.estimated_losses.total_estimated_loss, 350);
        assert_eq!(detail.estimated_losses.players[0].estimated_loss, 350);
        assert_eq!(detail.observed_friendly_players.len(), 3);
        assert_eq!(detail.observed_friendly_players[0].name, "alpha");
        assert_eq!(detail.observed_friendly_players[0].segments_observed, 2);
        assert_eq!(
            detail.observed_friendly_players[0].average_item_power,
            1300.0
        );
        assert!(!detail.participant_coverage.event_linked);
        assert_eq!(detail.participant_coverage.persisted_segments, 2);
    }

    #[test]
    fn duplicate_manual_membership_ids_are_rejected() {
        let error = unique_ids(vec![11, 12, 11], "battle_ids")
            .expect_err("duplicate battle IDs must not form a manual membership");

        assert!(
            matches!(error, AppError::Validation(message) if message == "battle_ids must not contain duplicates")
        );
    }

    #[test]
    fn empty_manual_membership_ids_are_rejected() {
        let error = unique_ids(Vec::new(), "fight_ids")
            .expect_err("an empty fight selection must be rejected");

        assert!(
            matches!(error, AppError::Validation(message) if message == "fight_ids must not be empty")
        );
    }

    #[test]
    fn matching_or_unassigned_events_are_compatible() {
        let fights = vec![fight_with_event(Some(42)), fight_with_event(None)];

        assert_eq!(
            compatible_event(&fights).expect("events are compatible"),
            Some(42)
        );
    }

    #[test]
    fn cross_event_manual_operations_are_rejected() {
        let fights = vec![fight_with_event(Some(42)), fight_with_event(Some(99))];
        let error = compatible_event(&fights)
            .expect_err("manual operations must not move memberships across events");

        assert!(
            matches!(error, AppError::Conflict(message) if message == "manual fight operations cannot cross Event boundaries")
        );
    }

    #[test]
    fn membership_snapshots_are_stably_sorted_for_audit() {
        let snapshot = membership_snapshot(7, &[segment(30, 2), segment(10, 1), segment(20, 3)]);

        assert_eq!(
            snapshot,
            json!({ "fight_id": 7, "battle_ids": [10, 20, 30] })
        );
    }

    #[test]
    fn manual_metadata_is_applied_consistently() {
        let mut model = <fight::ActiveModel as Default>::default();
        set_manual_fight_metadata(&mut model);

        assert_eq!(
            model.grouping_method,
            Set(MANUAL_GROUPING_METHOD.to_string())
        );
        assert_eq!(model.grouping_confidence, Set(MANUAL_GROUPING_CONFIDENCE));
        assert_eq!(model.needs_review, Set(MANUAL_NEEDS_REVIEW));
    }

    #[test]
    fn fight_listing_filters_aggregated_values_before_pagination() {
        let items = vec![
            list_item(1, Some(5), 20, 4, 100, FightOutcome::Victory),
            list_item(2, Some(5), 10, 8, 300, FightOutcome::Defeat),
            list_item(3, None, 30, 2, 200, FightOutcome::Victory),
        ];
        let query = FightListQuery {
            page: None,
            limit: None,
            search: None,
            event_id: Some(5),
            needs_review: None,
            min_players: Some(15),
            outcome: Some("victory".to_string()),
            sort: Some("fame".to_string()),
            order: Some("asc".to_string()),
        };

        let items = filter_sort_fights(items, &query).expect("Fight-level filters are valid");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, 1);
        assert_eq!(items[0].total_fame, 100);
    }

    #[test]
    fn fight_listing_sorts_outcome_with_a_deterministic_id_tie_breaker() {
        let items = vec![
            list_item(2, None, 0, 0, 0, FightOutcome::Victory),
            list_item(1, None, 0, 0, 0, FightOutcome::Victory),
            list_item(3, None, 0, 0, 0, FightOutcome::Unknown),
        ];
        let query = FightListQuery {
            page: None,
            limit: None,
            search: None,
            event_id: None,
            needs_review: None,
            min_players: None,
            outcome: None,
            sort: Some("outcome".to_string()),
            order: None,
        };

        let items = filter_sort_fights(items, &query).expect("Fight-level sort is valid");

        assert_eq!(
            items.iter().map(|item| item.id).collect::<Vec<_>>(),
            [2, 1, 3]
        );
    }

    #[test]
    fn unanimous_persisted_segment_outcomes_resolve_to_victory() {
        let outcome = resolve_persisted_segment_outcomes(&[vec![true, true], vec![true]]);

        assert_eq!(outcome.outcome, FightOutcome::Victory);
        assert_eq!(outcome.evidence_count, 3);
        assert_eq!(outcome.method, "unanimous_segment_outcomes");
    }

    #[test]
    fn unanimous_persisted_segment_outcomes_resolve_to_defeat() {
        let outcome = resolve_persisted_segment_outcomes(&[vec![false], vec![false, false]]);

        assert_eq!(outcome.outcome, FightOutcome::Defeat);
        assert_eq!(outcome.evidence_count, 3);
        assert_eq!(outcome.method, "unanimous_segment_outcomes");
    }

    #[test]
    fn mixed_fully_evidenced_segments_resolve_to_draw() {
        let outcome = resolve_persisted_segment_outcomes(&[vec![true], vec![false]]);

        assert_eq!(outcome.outcome, FightOutcome::Draw);
        assert_eq!(outcome.evidence_count, 2);
        assert_eq!(outcome.method, "mixed_segment_outcomes");
    }

    #[test]
    fn missing_or_conflicting_segment_evidence_is_unknown() {
        let missing = resolve_persisted_segment_outcomes(&[vec![true], vec![]]);
        let conflicting = resolve_persisted_segment_outcomes(&[vec![true, false]]);

        assert_eq!(missing.outcome, FightOutcome::Unknown);
        assert_eq!(conflicting.outcome, FightOutcome::Unknown);
        assert_eq!(missing.method, "incomplete_or_conflicting_segment_evidence");
        assert_eq!(
            conflicting.method,
            "incomplete_or_conflicting_segment_evidence"
        );
    }

    #[test]
    fn no_segments_has_no_outcome_evidence() {
        let outcome = resolve_persisted_segment_outcomes(&[]);

        assert_eq!(outcome.outcome, FightOutcome::Unknown);
        assert_eq!(outcome.evidence_count, 0);
        assert_eq!(outcome.method, "no_segments");
    }
}

fn add_loss_estimate(
    total: &mut BattleLossEstimate,
    players: &mut HashMap<String, PlayerLossEstimate>,
    guilds: &mut HashMap<String, GuildLossEstimate>,
    estimate: BattleLossEstimate,
) {
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
        let rollup = guilds
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
