//! Read-only canonical Fight API.

use std::collections::{HashMap, HashSet};

use axum::{
    Extension, Json, Router,
    extract::Path,
    routing::{get, post},
};
use chrono::Utc;
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
use crate::modules::events::entities::{event, event_participation, fight, fight_battle};
use crate::modules::users::entities as user;
use crate::modules::{
    audit::service::AuditService,
    auth::{Permission, Permissions, UserContext},
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
pub struct FightDetailView {
    pub id: i64,
    pub event_id: Option<i64>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub grouping_method: String,
    pub grouping_confidence: f64,
    pub needs_review: bool,
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
    pub primary_build_id: i64,
    pub primary_build_name: Option<String>,
    pub secondary_build_id: Option<i64>,
    pub secondary_build_name: Option<String>,
    /// Whether this planned participant was observed in a persisted friendly snapshot.
    pub observed: bool,
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
        .route("/merge", post(merge_fights))
        .route("/{id}/move-battle", post(move_battle))
        .route("/{id}/split", post(split_fight))
        .route("/{id}", get(get_fight))
}

/// Request to merge fights into `target_fight_id`.
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
    user.require(&perms, Permission::FightsManage).await?;

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
    user.require(&perms, Permission::FightsManage).await?;

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
    user.require(&perms, Permission::FightsManage).await?;

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
    let new_fight = fight::ActiveModel {
        event_id: Set(source.event_id),
        started_at: Set(source.started_at),
        ended_at: Set(source.ended_at),
        grouping_method: Set("manual".to_string()),
        grouping_confidence: Set(1.0),
        grouping_version: Set(source.grouping_version),
        needs_review: Set(false),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(&txn)
    .await?;

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
    active.grouping_method = Set("manual".to_string());
    active.grouping_confidence = Set(1.0);
    active.needs_review = Set(false);
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
    _user: UserContext,
    Extension(db): Extension<DatabaseConnection>,
    Extension(config): Extension<Config>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<FightDetailView>>, AppError> {
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
        .flat_map(|row| [Some(row.primary_build_id), row.secondary_build_id])
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
            primary_build_name: build_names.get(&participation.primary_build_id).cloned(),
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
    for player in observed_players {
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
