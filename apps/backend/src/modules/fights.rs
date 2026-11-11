//! Read-only canonical Fight API.

pub mod schemas;

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

use crate::albion_common::{BattleSide, FriendlySide};
use crate::errors::AppError;
use crate::modules::albion::entities::albion_link;
use crate::modules::audit::service::AuditService;
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::modules::battles::entities::{
    BattleLossEstimate, BattlePlayer, Column as GuildBattleSnapshotColumn,
    Entity as GuildBattleSnapshotEntity, GuildLossEstimate, PlayerLossEstimate,
};
use crate::modules::battles::models::BattleGuildSummary;
use crate::modules::battles::outcome::{
    BattleOutcome, GuildLine, OutcomeVerdict, battle_outcome, combine_segments,
};
use crate::modules::comps::entities::{build, comp};
use crate::modules::events::entities::{
    event, event_battle, event_participation, fight, fight_backfill_issue, fight_battle,
};
use crate::modules::fight_analytics;
use crate::modules::fights::schemas::ApiResponseFightBackfillIssueList;
use crate::modules::users::entities as user;
use crate::pagination::{
    PaginatedData, PaginationParams, SortOrder, paginate_vec, resolve_sort_key,
};
use crate::responses::ApiResponse;
use crate::tenant::{ControlDb, CurrentTenantId};
use serde_json::{Value, json};

/// Persisted summary metadata for one ordered battle segment of a fight.
#[derive(Debug, Serialize, ToSchema)]
pub struct FightSegmentSummary {
    /// `AlbionBB` battle ID.
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
    /// Segments that produced a decided outcome. Compare against `segment_count`
    /// to see how much of the fight the verdict actually rests on.
    pub evidence_count: i64,
    /// How the outcome was resolved: `unanimous_segments`, `mixed_segments`,
    /// `no_resolved_segments` or `no_segments`. The first two gain a
    /// `_partial_coverage` suffix when some segments could not be classified.
    pub method: String,
}

/// A canonical Fight's outcome from the configured guild's perspective.
///
/// Kept as a named alias so the `OpenAPI` schema and every existing import stay
/// stable while the definition itself lives in one place.
pub type FightOutcome = BattleOutcome;

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
    /// Technical `AlbionBB` battle IDs that make up this fight, in sequence.
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

/// One row from `fight_backfill_issues`: an `event_battles` row the original
/// migration's one-time backfill could not cleanly convert into a seeded
/// Fight. Write-only until now — this is its first read path.
#[derive(Debug, Serialize, ToSchema)]
pub struct FightBackfillIssueView {
    pub event_battle_id: i64,
    pub albionbb_battle_id: String,
    pub reason: String,
    /// RFC 3339.
    pub created_at: String,
    /// The event this `event_battles` row belonged to, when the row still
    /// exists (the FK is `ON DELETE CASCADE`, so this is always `Some` in
    /// practice — `None` only if `event_battles` were ever deleted through
    /// a path that somehow bypassed the FK, which should not happen).
    pub event_id: Option<i64>,
}

pub fn router() -> Router {
    Router::new()
        .route("/", get(list_fights))
        .route("/merge", post(merge_fights))
        .route("/{id}/move-battle", post(move_battle))
        .route("/{id}/split", post(split_fight))
        .route("/trends", get(get_fight_trends))
        .route("/backfill-issues", get(get_fight_backfill_issues))
        .route("/{id}", get(get_fight))
}

/// Lists every recorded backfill issue: an `event_battles` row the
/// migration's one-time backfill could not cleanly convert into a seeded
/// Fight, kept for officer reconciliation rather than silently discarded.
/// Diagnostic drill-down of the same resource as `GET /api/fights`, so it
/// is gated on the same `fights.view` permission rather than a separate
/// tier.
///
/// # Errors
///
/// Returns `403 Forbidden` if the caller lacks `fights.view`.
#[utoipa::path(
    get,
    path = "/api/fights/backfill-issues",
    tag = "fights",
    summary = "List fight backfill issues",
    description = "Rows from `fight_backfill_issues`, an `event_battles` row the original \
        migration's one-time backfill could not cleanly convert into a seeded Fight (an \
        unparseable AlbionBB battle ID, or a battle already assigned to another event). \
        Write-only until now; this is its first read path. Ordered newest first.",
    security(("session_cookie" = ["fights.view"])),
    responses(
        (status = 200, description = "Backfill issues retrieved", body = ApiResponseFightBackfillIssueList),
        (status = 401, description = "Unauthorized", body = crate::errors::ProblemDetails),
        (status = 403, description = "Forbidden - lacks fights.view", body = crate::errors::ProblemDetails)
    )
)]
pub async fn get_fight_backfill_issues(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<FightBackfillIssueView>>>, AppError> {
    user.require(&perms, Permission::FightsView).await?;
    let issues = list_fight_backfill_issues(&db).await?;
    Ok(Json(ApiResponse::new(issues)))
}

/// Reads every recorded backfill issue, newest first, with the owning
/// event's id when the source `event_battles` row still exists.
async fn list_fight_backfill_issues(
    db: &DatabaseConnection,
) -> Result<Vec<FightBackfillIssueView>, AppError> {
    let issues = fight_backfill_issue::Entity::find()
        .order_by_desc(fight_backfill_issue::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)?;
    let event_battle_ids = issues
        .iter()
        .map(|issue| issue.event_battle_id)
        .collect::<Vec<_>>();
    let event_ids_by_event_battle = if event_battle_ids.is_empty() {
        HashMap::new()
    } else {
        event_battle::Entity::find()
            .filter(event_battle::Column::Id.is_in(event_battle_ids))
            .all(db)
            .await
            .map_err(AppError::Database)?
            .into_iter()
            .map(|row| (row.id, row.event_id))
            .collect::<HashMap<_, _>>()
    };
    Ok(issues
        .into_iter()
        .map(|issue| FightBackfillIssueView {
            event_id: event_ids_by_event_battle
                .get(&issue.event_battle_id)
                .copied(),
            event_battle_id: issue.event_battle_id,
            albionbb_battle_id: issue.albionbb_battle_id,
            reason: issue.reason,
            created_at: issue.created_at.to_rfc3339(),
        })
        .collect())
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
        (status = 200, description = "Paginated fight summaries", body = ApiResponse<PaginatedFightList>),
        (status = 401, description = "Unauthorized", body = crate::errors::ProblemDetails)
    )
)]
pub(crate) async fn list_fights(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Query(query): Query<FightListQuery>,
) -> Result<Json<ApiResponse<PaginatedFightList>>, AppError> {
    user.require(&perms, Permission::FightsView).await?;
    let side = tenant_friendly_side(&control, &tenant_id).await?;
    let pagination = query.pagination();
    // Outcome and combat values are derived from every Fight's persisted segments, so pagination
    // must happen after hydration, filtering, and sorting rather than on the raw `fights` rows.
    let mut find = fight::Entity::find();
    if let Some(needs_review) = query.needs_review {
        find = find.filter(fight::Column::NeedsReview.eq(needs_review));
    }
    let fights = find.all(&db).await.map_err(AppError::Database)?;
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
                outcome: resolve_fight_outcome(fight_segments, &snapshots_by_battle, &side)?,
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

/// Our side, as configured for the requesting tenant.
///
/// Never falls back to the process-wide `ALBION_*` environment: that names one
/// deployment guild and would misclassify every other tenant. A tenant without
/// an Albion identity simply has no friendly side, so its outcomes are
/// `unknown` instead of an error that would break the whole page.
async fn tenant_friendly_side(
    control: &DatabaseConnection,
    tenant_id: &str,
) -> Result<FriendlySide, AppError> {
    match crate::albion_scope::load_friendly_side(control, tenant_id).await {
        Ok(side) => Ok(side),
        Err(crate::albion_scope::AlbionScopeError::NotConfigured) => Ok(FriendlySide::default()),
        Err(crate::albion_scope::AlbionScopeError::Database(err)) => Err(AppError::Database(err)),
    }
}

/// Stable rollup key for a snapshot player.
///
/// `AlbionBB` does not expose player ids, so the stored players usually carry
/// a blank `id`. Keying by it would merge every player into one row; the
/// fallback is the lower-cased name qualified by guild, because two players
/// of different guilds can share a display name.
fn player_rollup_key(player: &BattlePlayer) -> String {
    let id = player.id.trim();
    if id.is_empty() {
        format!(
            "name:{}|{}",
            player.name.trim().to_ascii_lowercase(),
            player.guild_name.trim().to_ascii_lowercase()
        )
    } else {
        format!("id:{id}")
    }
}

/// Resolves a snapshot's side against its own guild rows.
fn snapshot_side<'a>(side: &'a FriendlySide, guilds: &[BattleGuildSummary]) -> BattleSide<'a> {
    side.for_battle(
        guilds
            .iter()
            .map(|guild| (guild.id.as_str(), guild.name.as_str())),
    )
}

/// Resolves the canonical Fight outcome from its persisted battle segments.
///
/// The persisted snapshot is the only evidence. `event_battles.is_win` used to
/// be mixed in as a second stream, but it was written from the *raw* upstream
/// payload while `guilds_json` stored the crowned copy — so the two disagreed
/// on almost every decided battle and the resolver reported "conflicting
/// evidence" (`Unknown`). Both are now derived from
/// [`crate::modules::battles::outcome`], so there is nothing left to reconcile.
///
/// A segment that has not been hydrated yet simply does not vote; see
/// [`combine_segments`] for why that no longer poisons the whole fight.
fn resolve_fight_outcome(
    fight_battles: &[fight_battle::Model],
    snapshots_by_battle: &HashMap<i64, crate::modules::battles::entities::Model>,
    side: &FriendlySide,
) -> Result<FightOutcomeView, AppError> {
    let mut verdicts = Vec::with_capacity(fight_battles.len());

    for segment in fight_battles {
        let Some(snapshot) = snapshots_by_battle.get(&segment.battle_id) else {
            verdicts.push(OutcomeVerdict {
                outcome: BattleOutcome::Unknown,
                method: "segment_not_hydrated",
                fame_share: 0.0,
            });
            continue;
        };
        let guilds: Vec<BattleGuildSummary> =
            parse_snapshot(&snapshot.guilds_json, "guild", snapshot.battle_id)?;
        let lines = guilds
            .iter()
            .map(|guild| GuildLine {
                id: &guild.id,
                name: &guild.name,
                kills: guild.kills,
                deaths: guild.deaths,
                kill_fame: guild.kill_fame,
                winner: guild.winner,
            })
            .collect::<Vec<_>>();
        verdicts.push(battle_outcome(&lines, snapshot.total_fame, side));
    }

    let combined = combine_segments(&verdicts);
    Ok(FightOutcomeView {
        outcome: combined.outcome,
        evidence_count: combined.segments_resolved,
        method: combined.method,
    })
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
    /// Canonical `AlbionBB` battle ID linked to the source fight.
    pub battle_id: i64,
    /// Destination fight. It must belong to the same Event as the source fight (or neither may).
    pub target_fight_id: i64,
}

/// Request to take selected Battle segments out of a fight and form a new fight.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SplitFightRequest {
    /// Canonical `AlbionBB` battle IDs currently linked to the source fight.
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
        (status = 200, description = "Fights merged", body = ApiResponse<FightMutationResult>),
        (status = 400, description = "Invalid fight selection", body = crate::errors::ProblemDetails),
        (status = 401, description = "Unauthorized", body = crate::errors::ProblemDetails),
        (status = 403, description = "Missing fights.manage permission", body = crate::errors::ProblemDetails),
        (status = 404, description = "Fight not found", body = crate::errors::ProblemDetails),
        (status = 409, description = "Fights belong to different Events", body = crate::errors::ProblemDetails)
    )
)]
pub(crate) async fn merge_fights(
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
    if let Some(event_id) = event_id {
        for battle_id in &battle_ids {
            sync_event_battle_for_battle(&txn, event_id, *battle_id).await?;
        }
    }
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

    // Best-effort, additive telemetry: recomputes the surviving fight's
    // aggregated outcome/stats now that its segments have changed. A bug
    // here must never affect this mutation's already-committed result.
    if let Err(error) =
        fight_analytics::writer::recompute_fight_analytics(&db, request.target_fight_id).await
    {
        tracing::warn!(fight_id = request.target_fight_id, error = %error, "failed to recompute fight analytics after merge");
    }

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
    responses((status = 200, description = "Battle moved", body = ApiResponse<FightMutationResult>))
)]
pub(crate) async fn move_battle(
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
    if let Some(event_id) = event_id {
        for battle_id in &battle_ids {
            sync_event_battle_for_battle(&txn, event_id, *battle_id).await?;
        }
    }
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

    // Best-effort, additive telemetry: recomputes the target fight (and the
    // source fight, when it survived the move) now that their segments have
    // changed. A bug here must never affect this mutation's already-committed
    // result.
    let mut affected_fight_ids = vec![request.target_fight_id];
    if !deleted_fight_ids.contains(&source_fight_id) {
        affected_fight_ids.push(source_fight_id);
    }
    for affected_fight_id in affected_fight_ids {
        if let Err(error) =
            fight_analytics::writer::recompute_fight_analytics(&db, affected_fight_id).await
        {
            tracing::warn!(fight_id = affected_fight_id, error = %error, "failed to recompute fight analytics after battle move");
        }
    }

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
    responses((status = 200, description = "Fight split", body = ApiResponse<FightMutationResult>))
)]
pub(crate) async fn split_fight(
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
    if let Some(event_id) = source.event_id {
        for battle_id in &battle_ids {
            sync_event_battle_for_battle(&txn, event_id, *battle_id).await?;
        }
    }
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

    // Best-effort, additive telemetry: recomputes both the original fight
    // and the newly created one now that their segments have changed. A bug
    // here must never affect this mutation's already-committed result.
    for affected_fight_id in [source_fight_id, new_fight.id] {
        if let Err(error) =
            fight_analytics::writer::recompute_fight_analytics(&db, affected_fight_id).await
        {
            tracing::warn!(fight_id = affected_fight_id, error = %error, "failed to recompute fight analytics after split");
        }
    }

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

async fn sync_event_battle_for_battle(
    db: &DatabaseTransaction,
    event_id: i64,
    battle_id: i64,
) -> Result<(), AppError> {
    let existing = event_battle::Entity::find()
        .filter(event_battle::Column::EventId.eq(event_id))
        .filter(event_battle::Column::AlbionbbBattleId.eq(battle_id.to_string()))
        .one(db)
        .await?;
    if existing.is_some() {
        return Ok(());
    }

    let snapshot = GuildBattleSnapshotEntity::find()
        .filter(GuildBattleSnapshotColumn::BattleId.eq(battle_id))
        .one(db)
        .await?;
    let Some(snapshot) = snapshot else {
        return Ok(());
    };

    let total_players = i32::try_from(snapshot.total_players).ok();
    let now = Utc::now().into();
    let row = event_battle::ActiveModel {
        event_id: Set(event_id),
        albionbb_battle_id: Set(battle_id.to_string()),
        battle_started_at: Set(snapshot.start_time),
        guild_players_count: Set(0),
        battle_total_players: Set(total_players),
        fetched_at: Set(now),
        ..Default::default()
    };
    row.insert(db).await?;
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
        (status = 200, description = "Fight trends", body = ApiResponse<FightTrendView>),
        (status = 401, description = "Unauthorized", body = crate::errors::ProblemDetails)
    )
)]
pub(crate) async fn get_fight_trends(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
) -> Result<Json<ApiResponse<FightTrendView>>, AppError> {
    user.require(&perms, Permission::FightsView).await?;
    let side = tenant_friendly_side(&control, &tenant_id).await?;
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
    let comp_ids = events
        .iter()
        .filter_map(|row| row.comp_id)
        .collect::<Vec<_>>();
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
        &side,
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
        &side,
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

#[allow(clippy::too_many_arguments)]
fn build_fight_trend_period(
    fights: &[fight::Model],
    segments_by_fight: &HashMap<i64, Vec<fight_battle::Model>>,
    snapshots_by_battle: &HashMap<i64, crate::modules::battles::entities::Model>,
    events_by_id: &HashMap<i64, event::Model>,
    participations_by_event: &HashMap<i64, Vec<event_participation::Model>>,
    build_names: &HashMap<i64, String>,
    comp_names: &HashMap<i64, String>,
    side: &FriendlySide,
    window_start: chrono::DateTime<Utc>,
    window_end: chrono::DateTime<Utc>,
) -> Result<FightTrendPeriod, AppError> {
    let period_fights = fights.iter().filter(|fight| {
        let started_at = fight.started_at.with_timezone(&Utc);
        started_at >= window_start && started_at < window_end
    });
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
            let snapshot_guilds: Vec<BattleGuildSummary> =
                parse_snapshot(&snapshot.guilds_json, "guild", snapshot.battle_id)?;
            let battle_side = snapshot_side(side, &snapshot_guilds);
            let snapshot_players: Vec<BattlePlayer> =
                parse_snapshot(&snapshot.players_json, "player", snapshot.battle_id)?;
            for player in snapshot_players
                .into_iter()
                .filter(|player| battle_side.contains(&player.guild_id, &player.guild_name))
            {
                kills += player.kills;
                deaths += player.deaths;
                kill_fame += player.kill_fame;
            }
            for guild in snapshot_guilds
                .into_iter()
                .filter(|guild| battle_side.contains(&guild.id, &guild.name))
            {
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
            if let Some(event) = events_by_id.get(&event_id)
                && let Some(comp_id) = event.comp_id
            {
                *comps.entry(comp_id).or_default() += 1;
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
        (status = 200, description = "Fight detail", body = ApiResponse<FightDetailView>),
        (status = 401, description = "Unauthorized", body = crate::errors::ProblemDetails),
        (status = 404, description = "Fight not found", body = crate::errors::ProblemDetails)
    )
)]
pub(crate) async fn get_fight(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(ControlDb(control)): Extension<ControlDb>,
    Extension(CurrentTenantId(tenant_id)): Extension<CurrentTenantId>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<FightDetailView>>, AppError> {
    user.require(&perms, Permission::FightsView).await?;
    let side = tenant_friendly_side(&control, &tenant_id).await?;
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
    let outcome = resolve_fight_outcome(&fight_battles, &snapshots_by_battle, &side)?;
    let analytics = build_fight_analytics(&fight_battles, &snapshots_by_battle, &side)?;
    let mut observed_friendly_players = observed_friendly_players(&snapshots_by_battle, &side)?;
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
    // Flash masses have no planned comp.
    let Some(comp_id) = event.comp_id else {
        return Ok(None);
    };
    let comp_name = comp::Entity::find_by_id(comp_id)
        .one(db)
        .await?
        .map(|comp| comp.name);
    Ok(Some(FightPlannedCompView {
        id: comp_id,
        name: comp_name,
    }))
}

fn observed_friendly_players(
    snapshots_by_battle: &HashMap<i64, crate::modules::battles::entities::Model>,
    side: &FriendlySide,
) -> Result<Vec<ObservedFriendlyPlayerView>, AppError> {
    let mut players = HashMap::<String, PlayerRollup>::new();

    for snapshot in snapshots_by_battle.values() {
        let snapshot_guilds: Vec<BattleGuildSummary> =
            parse_snapshot(&snapshot.guilds_json, "guild", snapshot.battle_id)?;
        let battle_side = snapshot_side(side, &snapshot_guilds);
        let snapshot_players: Vec<BattlePlayer> =
            parse_snapshot(&snapshot.players_json, "player", snapshot.battle_id)?;
        for player in snapshot_players
            .into_iter()
            .filter(|player| battle_side.contains(&player.guild_id, &player.guild_name))
        {
            players
                .entry(player_rollup_key(&player))
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
        // Snapshot players usually have no id; a blank id identifies nobody.
        player.user_id = (!player.albion_player_id.is_empty())
            .then(|| user_ids_by_albion.get(&player.albion_player_id).copied())
            .flatten();
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
    side: &FriendlySide,
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

        let battle_side = snapshot_side(side, &snapshot_guilds);
        for mut guild in snapshot_guilds {
            guild.is_own = battle_side.is_own(&guild.id);
            guild.is_friendly = guild.is_own || battle_side.contains(&guild.id, &guild.name);
            guilds
                .entry(guild_key(&guild.id, &guild.name))
                .or_insert_with(|| GuildRollup::new(guild.clone()))
                .add_summary(&guild);
        }
        for mut player in snapshot_players {
            player.is_friendly = battle_side.contains(&player.guild_id, &player.guild_name);
            let key = player_rollup_key(&player);
            player_ids.insert(key.clone());
            guilds
                .entry(guild_key(&player.guild_id, &player.guild_name))
                .or_insert_with(|| GuildRollup::from_player(&player, &battle_side))
                .players
                .insert(key.clone());
            players
                .entry(key)
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

    fn from_player(player: &BattlePlayer, battle_side: &BattleSide<'_>) -> Self {
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
            is_friendly: player.is_friendly,
            is_own: battle_side.is_own(&player.guild_id),
        })
    }

    fn add_summary(&mut self, summary: &BattleGuildSummary) {
        self.summary.kills += summary.kills;
        self.summary.deaths += summary.deaths;
        self.summary.kill_fame += summary.kill_fame;
        self.summary.winner |= summary.winner;
        self.summary.is_friendly |= summary.is_friendly;
        self.summary.is_own |= summary.is_own;
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
        self.player.is_friendly |= player.is_friendly;
        self.item_power_total += player.item_power;
        self.appearances += 1;
    }

    fn into_player(mut self) -> BattlePlayer {
        self.player.item_power = self.item_power_total / self.appearances as f64;
        self.player
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::battles::entities as battle_snapshot;
    use crate::modules::comps::entities::comp_category;
    use crate::testkit::{ALBION_GUILDS, GUILDS, World};

    async fn seed_db() -> DatabaseConnection {
        crate::testkit::tenant_schema::migrated_sqlite().await
    }

    fn timestamp(offset_hours: i64) -> sea_orm::prelude::DateTimeWithTimeZone {
        (Utc::now() + Duration::hours(offset_hours)).into()
    }

    /// Tenant "ours" in the shared fixtures: the first seeded Albion guild.
    fn own_guild() -> &'static str {
        ALBION_GUILDS[0]
    }

    fn test_side() -> FriendlySide {
        FriendlySide::new(own_guild(), &[], &[])
    }

    /// Control plane with the seeded Albion tenants, plus the extensions a
    /// handler needs to resolve `tenant_id`'s side from it.
    async fn tenant_extensions(
        world: &World,
        tenant_id: &str,
    ) -> (Extension<ControlDb>, Extension<CurrentTenantId>) {
        (
            Extension(ControlDb(world.control.clone())),
            Extension(CurrentTenantId(tenant_id.to_owned())),
        )
    }

    async fn seeded_world() -> World {
        let world = World::new().await;
        world.seed_albion_control().await;
        world
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
            is_tenant_owner: false,
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

    #[allow(clippy::too_many_arguments)]
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
            id: own_guild().to_string(),
            name: "Weaklings".to_string(),
            alliance_name: None,
            alliance_id: None,
            players,
            kills,
            deaths,
            kill_fame,
            winner,
            average_item_power: item_power,
            is_friendly: false,
            is_own: false,
        }
    }

    fn player(id: &str, kills: i64, deaths: i64, kill_fame: i64, item_power: f64) -> BattlePlayer {
        BattlePlayer {
            id: id.to_string(),
            name: id.to_string(),
            guild_id: own_guild().to_string(),
            guild_name: "Weaklings".to_string(),
            alliance_name: None,
            alliance_id: None,
            kills,
            deaths,
            kill_fame,
            death_fame: deaths * 10,
            item_power,
            is_friendly: false,
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
            outcome: "unknown".to_string(),
            outcome_method: None,
            analytics_computed_at: None,
            analytics_stale: true,
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

    /// Best-effort wiring check: `merge_fights`, `split_fight` and
    /// `move_battle` each trigger `fight_analytics::writer::recompute_fight_analytics`
    /// for every fight id they affect, after their own transaction commits.
    /// Reuses the same fixtures as `manual_mutations_persist_resequenced_segments_and_metadata`
    /// rather than building new ones — this test does not re-cover any of
    /// that test's own resequencing/metadata assertions.
    #[tokio::test]
    async fn manual_mutations_trigger_best_effort_fight_analytics_recompute() {
        use crate::modules::fight_analytics::entities::fight_stat;

        let db = seed_db().await;
        let earlier = timestamp(-2);
        let later = timestamp(-1);
        let target = insert_fight(&db, later).await;
        let source = insert_fight(&db, earlier).await;
        insert_snapshot(
            &db,
            100,
            later,
            None,
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
            None,
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

        // `merge_fights`: only the surviving target fight is recomputed.
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

        let merged_fight = fight::Entity::find_by_id(merged.data.fight_id)
            .one(&db)
            .await
            .expect("query merged fight")
            .expect("merged fight exists");
        assert!(
            merged_fight.analytics_computed_at.is_some(),
            "merge_fights must trigger a recompute for the surviving fight"
        );
        assert!(!merged_fight.analytics_stale);
        let merged_stats = fight_stat::Entity::find()
            .filter(fight_stat::Column::FightId.eq(merged.data.fight_id))
            .one(&db)
            .await
            .expect("query fight_stats")
            .expect("fight_stats row was computed for the merged fight");
        assert_eq!(merged_stats.segment_count, 2);

        // `split_fight`: both the original and the newly created fight are
        // recomputed.
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

        let original_stats = fight_stat::Entity::find()
            .filter(fight_stat::Column::FightId.eq(target.id))
            .one(&db)
            .await
            .expect("query fight_stats")
            .expect("fight_stats row was recomputed for the original fight");
        assert_eq!(original_stats.segment_count, 1);
        let new_stats = fight_stat::Entity::find()
            .filter(fight_stat::Column::FightId.eq(split.data.fight_id))
            .one(&db)
            .await
            .expect("query fight_stats")
            .expect("fight_stats row was computed for the newly created fight");
        assert_eq!(new_stats.segment_count, 1);

        // `move_battle`: both the source and target fights are recomputed.
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
        assert_eq!(moved.data.deleted_fight_ids, [split.data.fight_id]);

        let final_stats = fight_stat::Entity::find()
            .filter(fight_stat::Column::FightId.eq(target.id))
            .one(&db)
            .await
            .expect("query fight_stats")
            .expect("fight_stats row was recomputed for the target fight after the move");
        assert_eq!(
            final_stats.segment_count, 2,
            "move_battle's single remaining source segment rejoins the target fight"
        );
    }

    #[tokio::test]
    async fn fight_detail_aggregates_persisted_segment_snapshots() {
        let world = seeded_world().await;
        let db = world.guild(1).db.clone();
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

        let (control, tenant) = tenant_extensions(&world, GUILDS[0]).await;
        let Json(response) = get_fight(
            test_admin(),
            Extension(Permissions::new_empty()),
            Extension(db),
            control,
            tenant,
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

    /// Builds a persisted snapshot where our side takes `our_fame` of `total_fame`.
    fn snapshot(battle_id: i64, our_fame: i64, total_fame: i64) -> battle_snapshot::Model {
        let guilds = vec![
            BattleGuildSummary {
                id: own_guild().to_string(),
                name: "Weaklings".to_string(),
                alliance_name: None,
                alliance_id: None,
                players: 20,
                kills: 5,
                deaths: 5,
                kill_fame: our_fame,
                winner: false,
                average_item_power: 0.0,
                is_friendly: false,
                is_own: false,
            },
            BattleGuildSummary {
                id: "enemy".to_string(),
                name: "ARCH".to_string(),
                alliance_name: None,
                alliance_id: None,
                players: 20,
                kills: 5,
                deaths: 5,
                kill_fame: total_fame - our_fame,
                winner: false,
                average_item_power: 0.0,
                is_friendly: false,
                is_own: false,
            },
        ];
        battle_snapshot::Model {
            id: battle_id,
            battle_id,
            start_time: timestamp(0),
            end_time: None,
            total_players: 40,
            total_kills: 10,
            total_fame,
            guilds_json: serde_json::to_string(&guilds).expect("guilds serialize"),
            players_json: "[]".to_string(),
            kills_json: "[]".to_string(),
            losses_json: serde_json::to_string(&BattleLossEstimate::default())
                .expect("estimate serializes"),
            fetched_at: timestamp(0),
        }
    }

    #[test]
    fn segments_our_side_wins_resolve_the_fight_to_victory() {
        let segments = [segment(10, 1), segment(11, 2)];
        let snapshots = HashMap::from([
            (10, snapshot(10, 700_000, 1_000_000)),
            (11, snapshot(11, 800_000, 1_000_000)),
        ]);

        let outcome =
            resolve_fight_outcome(&segments, &snapshots, &test_side()).expect("outcome resolves");

        assert_eq!(outcome.outcome, FightOutcome::Victory);
        assert_eq!(outcome.method, "unanimous_segments");
        assert_eq!(outcome.evidence_count, 2);
    }

    #[test]
    fn segments_that_disagree_resolve_the_fight_to_a_draw() {
        let segments = [segment(10, 1), segment(11, 2)];
        let snapshots = HashMap::from([
            (10, snapshot(10, 700_000, 1_000_000)),
            (11, snapshot(11, 100_000, 1_000_000)),
        ]);

        let outcome =
            resolve_fight_outcome(&segments, &snapshots, &test_side()).expect("outcome resolves");

        assert_eq!(outcome.outcome, FightOutcome::Draw);
        assert_eq!(outcome.method, "mixed_segments");
    }

    /// The regression that motivated the shared rule: an unhydrated segment used
    /// to make the whole fight `Unknown`.
    #[test]
    fn an_unhydrated_segment_no_longer_poisons_the_fight() {
        let segments = [segment(10, 1), segment(11, 2)];
        let snapshots = HashMap::from([(10, snapshot(10, 700_000, 1_000_000))]);

        let outcome =
            resolve_fight_outcome(&segments, &snapshots, &test_side()).expect("outcome resolves");

        assert_eq!(outcome.outcome, FightOutcome::Victory);
        assert_eq!(outcome.method, "unanimous_segments_partial_coverage");
        assert_eq!(
            outcome.evidence_count, 1,
            "the verdict must disclose that it rests on one of two segments"
        );
    }

    #[test]
    fn a_fight_with_no_hydrated_segment_stays_unknown() {
        let segments = [segment(10, 1)];

        let outcome = resolve_fight_outcome(&segments, &HashMap::new(), &test_side())
            .expect("outcome resolves");

        assert_eq!(outcome.outcome, FightOutcome::Unknown);
        assert_eq!(outcome.method, "no_resolved_segments");
    }

    #[test]
    fn a_fight_with_no_segments_has_no_outcome_evidence() {
        let outcome =
            resolve_fight_outcome(&[], &HashMap::new(), &test_side()).expect("outcome resolves");

        assert_eq!(outcome.outcome, FightOutcome::Unknown);
        assert_eq!(outcome.evidence_count, 0);
        assert_eq!(outcome.method, "no_segments");
    }

    /// Minimal fixture chain (comp category -> comp -> event) mirroring
    /// `economy::service`'s own test helper, so a backfill issue's owning
    /// event can be exercised end to end without depending on the events
    /// module's own test helpers.
    async fn insert_event_for_backfill(db: &DatabaseConnection, title: &str) -> i64 {
        let user_id = user::ActiveModel {
            username: Set(format!("creator-{title}")),
            email: Set(format!("{title}@example.com")),
            role: Set("member".to_string()),
            discord_id: Set(Some(format!("discord-{title}"))),
            created_at: Set(timestamp(0)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id;

        let comp_category_id = comp_category::ActiveModel {
            name: Set("Comp Category".to_string()),
            slug: Set(format!("comp-category-{title}")),
            description: Set(None),
            created_at: Set(timestamp(0)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert comp category")
        .id;

        let comp_id = comp::ActiveModel {
            name: Set(format!("Comp {title}")),
            description: Set(None),
            category_id: Set(comp_category_id),
            version: Set(1),
            created_by: Set(user_id),
            created_at: Set(timestamp(0)),
            updated_at: Set(timestamp(0)),
            parent_id: Set(None),
            archived_at: Set(None),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert comp")
        .id;

        event::ActiveModel {
            title: Set(title.to_string()),
            description: Set(None),
            call_to_arms: Set(false),
            regear: Set(true),
            comp_id: Set(Some(comp_id)),
            player_cap: Set(None),
            created_by: Set(user_id),
            event_date_utc: Set(timestamp(0)),
            mass_time_utc: Set(None),
            start_time_utc: Set(None),
            created_at: Set(timestamp(0)),
            updated_at: Set(timestamp(0)),
            status: Set("completed".to_string()),
            started_at: Set(None),
            stopped_at: Set(None),
            auto_stop_deadline: Set(None),
            link_status: Set("idle".to_string()),
            link_attempts: Set(0),
            link_last_error: Set(None),
            link_battles_completed_at: Set(None),
            discord_voice_channel_id: Set(None),
            roster_version: Set(0),
            archived_at: Set(None),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert event")
        .id
    }

    async fn insert_event_battle_for_backfill(
        db: &DatabaseConnection,
        event_id: i64,
        albionbb_battle_id: &str,
    ) -> i64 {
        event_battle::ActiveModel {
            event_id: Set(event_id),
            albionbb_battle_id: Set(albionbb_battle_id.to_string()),
            battle_started_at: Set(timestamp(0)),
            guild_players_count: Set(10),
            battle_total_players: Set(None),
            fetched_at: Set(timestamp(0)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert event battle")
        .id
    }

    #[tokio::test]
    async fn backfill_issues_read_path_returns_empty_when_none_recorded() {
        let db = seed_db().await;

        let issues = list_fight_backfill_issues(&db)
            .await
            .expect("list backfill issues");

        assert!(issues.is_empty());
    }

    #[tokio::test]
    async fn backfill_issues_read_path_returns_seeded_row_with_event_id() {
        let db = seed_db().await;
        let event_id = insert_event_for_backfill(&db, "Backfill Event").await;
        let event_battle_id = insert_event_battle_for_backfill(&db, event_id, "not-a-number").await;
        fight_backfill_issue::ActiveModel {
            event_battle_id: Set(event_battle_id),
            albionbb_battle_id: Set("not-a-number".to_string()),
            reason: Set("invalid AlbionBB battle ID".to_string()),
            created_at: Set(timestamp(0)),
        }
        .insert(&db)
        .await
        .expect("insert backfill issue");

        let issues = list_fight_backfill_issues(&db)
            .await
            .expect("list backfill issues");

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].event_battle_id, event_battle_id);
        assert_eq!(issues[0].albionbb_battle_id, "not-a-number");
        assert_eq!(issues[0].reason, "invalid AlbionBB battle ID");
        assert_eq!(issues[0].event_id, Some(event_id));
    }

    // No direct HTTP-layer permission test idiom exists for `fights.rs` (no
    // `tower::ServiceExt::oneshot` usage anywhere in `modules/`, matching the
    // rationale already documented in `attention::router`'s own test module),
    // so `403` gating for `GET /api/fights/backfill-issues` is not separately
    // asserted here; `user.require` is exercised the same way every other
    // handler in this file already relies on it.

    #[tokio::test]
    async fn list_fights_pushes_the_needs_review_filter_down_to_sql() {
        let world = seeded_world().await;
        let db = world.guild(1).db.clone();
        let reviewed = insert_fight(&db, timestamp(0)).await;
        let reviewed_id = reviewed.id;
        let mut active: fight::ActiveModel = reviewed.into();
        active.needs_review = Set(false);
        active.update(&db).await.expect("clear needs_review");
        insert_fight(&db, timestamp(1)).await; // needs_review defaults to true
        insert_fight(&db, timestamp(2)).await; // needs_review defaults to true

        let (control, tenant) = tenant_extensions(&world, GUILDS[0]).await;
        let Json(response) = list_fights(
            test_admin(),
            Extension(Permissions::new_empty()),
            Extension(db.clone()),
            control,
            tenant,
            Query(FightListQuery {
                page: None,
                limit: None,
                search: None,
                event_id: None,
                needs_review: Some(true),
                min_players: None,
                outcome: None,
                sort: None,
                order: None,
            }),
        )
        .await
        .expect("list fights");

        assert_eq!(response.data.total_items, 2);
        assert!(response.data.items.iter().all(|item| item.needs_review));
        assert!(
            response
                .data
                .items
                .iter()
                .all(|item| item.id != reviewed_id),
            "the fight already cleared of review must not come back"
        );
    }

    /// Two Albion guilds fought each other: guild 1 holds 75% of the fame.
    fn rival_guilds() -> Vec<BattleGuildSummary> {
        let line = |id: &str, name: &str, kills: i64, deaths: i64, kill_fame: i64, winner: bool| {
            BattleGuildSummary {
                id: id.to_string(),
                name: name.to_string(),
                alliance_name: None,
                alliance_id: None,
                players: 20,
                kills,
                deaths,
                kill_fame,
                winner,
                average_item_power: 0.0,
                is_friendly: false,
                is_own: false,
            }
        };
        vec![
            line(ALBION_GUILDS[0], "Alpha", 8, 2, 750_000, true),
            line(ALBION_GUILDS[1], "Beta", 2, 8, 250_000, false),
        ]
    }

    /// A player as the real `AlbionBB` payload ships it: name and guild name only.
    fn id_less_player(name: &str, guild_name: &str, kills: i64, deaths: i64) -> BattlePlayer {
        BattlePlayer {
            id: String::new(),
            name: name.to_string(),
            guild_id: String::new(),
            guild_name: guild_name.to_string(),
            alliance_name: None,
            alliance_id: None,
            kills,
            deaths,
            kill_fame: kills * 100,
            death_fame: deaths * 10,
            item_power: 1000.0,
            is_friendly: false,
        }
    }

    async fn seed_rival_fight(db: &DatabaseConnection) -> fight::Model {
        let started = timestamp(-2);
        let fight = insert_fight(db, started).await;
        insert_snapshot(
            db,
            900,
            started,
            None,
            40,
            10,
            1_000_000,
            rival_guilds(),
            vec![
                id_less_player("Hawk", "Alpha", 3, 1),
                id_less_player("Wren", "Alpha", 2, 0),
                // Same display name in both guilds: still two players.
                id_less_player("Shared", "Alpha", 1, 1),
                id_less_player("Shared", "Beta", 4, 2),
            ],
            BattleLossEstimate::default(),
        )
        .await;
        insert_segment(db, fight.id, 900, 1).await;
        fight
    }

    async fn fight_detail_for(world: &World, tenant_id: &str, fight_id: i64) -> FightDetailView {
        let (control, tenant) = tenant_extensions(world, tenant_id).await;
        let Json(response) = get_fight(
            test_admin(),
            Extension(Permissions::new_empty()),
            Extension(world.guild(1).db.clone()),
            control,
            tenant,
            Path(fight_id),
        )
        .await
        .expect("get fight detail");
        response.data
    }

    #[test]
    fn the_same_fight_resolves_differently_for_two_albion_guilds() {
        let segments = [segment(10, 1)];
        let battle = battle_snapshot::Model {
            guilds_json: serde_json::to_string(&rival_guilds()).expect("guilds serialize"),
            total_fame: 1_000_000,
            ..snapshot(10, 700_000, 1_000_000)
        };
        let snapshots = HashMap::from([(10, battle)]);
        let outcome_for = |side: FriendlySide| {
            resolve_fight_outcome(&segments, &snapshots, &side)
                .expect("outcome resolves")
                .outcome
        };

        assert_eq!(
            outcome_for(FriendlySide::new(ALBION_GUILDS[0], &[], &[])),
            FightOutcome::Victory
        );
        assert_eq!(
            outcome_for(FriendlySide::new(ALBION_GUILDS[1], &[], &[])),
            FightOutcome::Defeat
        );
        // A tenant that owns neither guild is not on any side.
        assert_eq!(
            outcome_for(FriendlySide::new("someone-else", &[], &[])),
            FightOutcome::Unknown
        );
        assert_eq!(outcome_for(FriendlySide::default()), FightOutcome::Unknown);
    }

    #[test]
    fn players_without_ids_get_distinct_rollup_keys_per_name_and_guild() {
        let hawk = id_less_player("Hawk", "Alpha", 0, 0);
        assert_eq!(player_rollup_key(&hawk), player_rollup_key(&hawk.clone()));
        assert_ne!(
            player_rollup_key(&hawk),
            player_rollup_key(&id_less_player("Wren", "Alpha", 0, 0))
        );
        assert_ne!(
            player_rollup_key(&id_less_player("Shared", "Alpha", 0, 0)),
            player_rollup_key(&id_less_player("Shared", "Beta", 0, 0))
        );
        assert_eq!(
            player_rollup_key(&id_less_player(" HAWK ", "alpha", 0, 0)),
            player_rollup_key(&hawk)
        );
        let mut with_id = hawk;
        with_id.id = "abc".to_string();
        assert_eq!(player_rollup_key(&with_id), "id:abc");
    }

    #[tokio::test]
    async fn fight_detail_without_player_ids_keeps_players_apart_and_flags_our_side() {
        let world = seeded_world().await;
        let fight = seed_rival_fight(&world.guild(1).db).await;

        let detail = fight_detail_for(&world, GUILDS[0], fight.id).await;

        assert_eq!(
            detail.unique_players, 4,
            "no id must not collapse the roster"
        );
        assert_eq!(detail.players.len(), 4);
        assert_eq!(detail.outcome.outcome, FightOutcome::Victory);
        let mut observed = detail
            .observed_friendly_players
            .iter()
            .map(|player| player.name.as_str())
            .collect::<Vec<_>>();
        observed.sort_unstable();
        assert_eq!(observed, ["Hawk", "Shared", "Wren"]);
        let flag = |name: &str, guild: &str| {
            detail
                .players
                .iter()
                .find(|player| player.name == name && player.guild_name == guild)
                .map(|player| player.is_friendly)
                .expect("player in roster")
        };
        assert!(flag("Hawk", "Alpha"));
        assert!(flag("Shared", "Alpha"));
        assert!(!flag("Shared", "Beta"));
        let alpha = detail
            .guilds
            .iter()
            .find(|guild| guild.name == "Alpha")
            .unwrap();
        let beta = detail
            .guilds
            .iter()
            .find(|guild| guild.name == "Beta")
            .unwrap();
        assert!(alpha.is_friendly && alpha.is_own);
        assert!(!beta.is_friendly && !beta.is_own);
    }

    #[tokio::test]
    async fn two_tenants_classify_one_fight_differently_in_one_process() {
        let world = seeded_world().await;
        let fight = seed_rival_fight(&world.guild(1).db).await;

        let first = fight_detail_for(&world, GUILDS[0], fight.id).await;
        let second = fight_detail_for(&world, GUILDS[1], fight.id).await;
        let unconfigured = fight_detail_for(&world, GUILDS[2], fight.id).await;
        let alliance = fight_detail_for(&world, crate::testkit::ALLIANCE, fight.id).await;

        assert_eq!(first.outcome.outcome, FightOutcome::Victory);
        assert_eq!(second.outcome.outcome, FightOutcome::Defeat);
        assert_eq!(unconfigured.outcome.outcome, FightOutcome::Unknown);
        assert!(unconfigured.observed_friendly_players.is_empty());
        // Beta is guild 2's own side: one observed player, and Alpha is the enemy.
        assert_eq!(second.observed_friendly_players.len(), 1);
        assert_eq!(second.observed_friendly_players[0].name, "Shared");
        assert!(
            second
                .guilds
                .iter()
                .any(|guild| guild.name == "Beta" && guild.is_own)
        );
        // An alliance of both guilds fights on both sides: nobody is "own".
        assert_eq!(alliance.observed_friendly_players.len(), 4);
        assert!(
            alliance
                .guilds
                .iter()
                .all(|guild| guild.is_friendly && !guild.is_own)
        );
    }

    #[tokio::test]
    async fn list_and_trends_use_the_requesting_tenants_side() {
        let world = seeded_world().await;
        seed_rival_fight(&world.guild(1).db).await;

        for (tenant_id, outcome, kills, deaths, wins) in [
            (GUILDS[0], FightOutcome::Victory, 6, 2, 1),
            (GUILDS[1], FightOutcome::Defeat, 4, 2, 0),
            (GUILDS[2], FightOutcome::Unknown, 0, 0, 0),
        ] {
            let (control, tenant) = tenant_extensions(&world, tenant_id).await;
            let Json(list) = list_fights(
                test_admin(),
                Extension(Permissions::new_empty()),
                Extension(world.guild(1).db.clone()),
                control,
                tenant,
                Query(FightListQuery {
                    page: None,
                    limit: None,
                    search: None,
                    event_id: None,
                    needs_review: None,
                    min_players: None,
                    outcome: None,
                    sort: None,
                    order: None,
                }),
            )
            .await
            .expect("list fights");
            assert_eq!(list.data.items[0].outcome.outcome, outcome, "{tenant_id}");

            let (control, tenant) = tenant_extensions(&world, tenant_id).await;
            let Json(trends) = get_fight_trends(
                test_admin(),
                Extension(Permissions::new_empty()),
                Extension(world.guild(1).db.clone()),
                control,
                tenant,
            )
            .await
            .expect("fight trends");
            let period = trends.data.last_30_days;
            assert_eq!(period.kills, kills, "{tenant_id} kills");
            assert_eq!(period.deaths, deaths, "{tenant_id} deaths");
            assert_eq!(period.wins, wins, "{tenant_id} wins");
        }
    }
}
