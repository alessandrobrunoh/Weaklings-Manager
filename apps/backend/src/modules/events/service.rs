//! Business logic for the events module.

use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
    Set, PaginatorTrait,
};

use chrono::{DateTime, Duration as ChronoDuration, Utc};

use crate::errors::AppError;
use crate::pagination::{PaginatedData, PaginationParams};
use crate::modules::comps::entities::{comp, comp_build, build};
use crate::modules::albionbb::client::AlbionBbBattlesFilters;
use crate::modules::albionbb::service::AlbionBbService;
use super::entities::{event, event_battle, event_participation};
use super::models::{
    CreateEventRequest, EventBattleView, EventDetailView, EventParticipantView, EventView,
    ParticipateEventRequest, UpdateEventRequest,
};

/// Hard cap on how long an event session can stay live before the background
/// worker auto-stops it. Tuned to 3 hours per product requirement.
const MAX_SESSION_DURATION: ChronoDuration = ChronoDuration::hours(3);

/// Grace period after a session is stopped during which the linker keeps
/// re-fetching AlbionBB to absorb the upstream's slow ingestion (~30 minutes).
const LINK_GRACE_PERIOD: ChronoDuration = ChronoDuration::minutes(45);



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
        let active = comps_with_capacity.into_iter()
            .find(|(_, cap)| *cap >= target_size as i64);

        if let Some((active_comp, capacity)) = active {
            Ok((active_comp, capacity))
        } else {
            Err(AppError::Validation("La comp è piena".to_string()))
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

        let created_by_username = crate::modules::users::display_name::resolve_by_id(db, model.created_by).await?;

        Ok(EventView {
            id: model.id,
            title: model.title,
            description: model.description,
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
    ) -> Result<PaginatedData<EventView>, AppError> {
        let page = pagination.offset_page();
        let limit = pagination.limit();

        let paginator = event::Entity::find()
            .order_by_asc(event::Column::EventDateUtc)
            .paginate(db, limit);

        let total_items = paginator.num_items().await.map_err(AppError::Database)?;
        let total_pages = paginator.num_pages().await.map_err(AppError::Database)?;
        let current_page = page + 1;

        let models = paginator.fetch_page(page).await.map_err(AppError::Database)?;

        let mut items = Vec::new();
        for m in models {
            items.push(self.to_event_view(db, m).await?);
        }

        Ok(PaginatedData::new(items, total_items, total_pages, current_page, limit))
    }

    /// Gets detailed event information including participants and resolved active comp.
    pub async fn get_event_detail(
        &self,
        db: &DatabaseConnection,
        id: i64,
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
                .ok_or_else(|| AppError::NotFound(format!("Build {} not found", p.primary_build_id)))?;

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
                primary_build_id: p.primary_build_id,
                primary_build_name: primary_build.name,
                secondary_build_id: p.secondary_build_id,
                secondary_build_name,
            });
        }

        let battle_rows = event_battle::Entity::find()
            .filter(event_battle::Column::EventId.eq(id))
            .order_by_asc(event_battle::Column::BattleStartedAt)
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let battles = battle_rows
            .into_iter()
            .map(|b| EventBattleView {
                id: b.id,
                albionbb_battle_id: b.albionbb_battle_id,
                battle_started_at: b.battle_started_at.to_rfc3339(),
                guild_players_count: b.guild_players_count,
                battle_total_players: b.battle_total_players,
                fetched_at: b.fetched_at.to_rfc3339(),
            })
            .collect();

        Ok(EventDetailView {
            event: event_view,
            active_comp_id: active_comp.id,
            active_comp_name: active_comp.name,
            active_comp_capacity: active_capacity,
            participants: participant_views,
            battles,
        })
    }

    /// Creates a new event.
    pub async fn create_event(
        &self,
        db: &DatabaseConnection,
        creator_id: i64,
        req: CreateEventRequest,
    ) -> Result<EventView, AppError> {
        // Validate comp exists
        let comp_exists = comp::Entity::find_by_id(req.comp_id)
            .count(db)
            .await
            .map_err(AppError::Database)?
            > 0;

        if !comp_exists {
            return Err(AppError::NotFound(format!("Composition {} not found", req.comp_id)));
        }

        // Parse date
        let parsed_date = chrono::DateTime::parse_from_rfc3339(&req.event_date_utc)
            .map_err(|e| AppError::Validation(format!("Invalid event date: {e}")))?;

        let event_model = event::ActiveModel {
            title: Set(req.title),
            description: Set(req.description),
            comp_id: Set(req.comp_id),
            created_by: Set(creator_id),
            event_date_utc: Set(parsed_date.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .map_err(AppError::Database)?;

        self.to_event_view(db, event_model).await
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
        if let Some(comp_id) = req.comp_id {
            // Validate comp exists
            let comp_exists = comp::Entity::find_by_id(comp_id)
                .count(db)
                .await
                .map_err(AppError::Database)?
                > 0;
            if !comp_exists {
                return Err(AppError::NotFound(format!("Composition {} not found", comp_id)));
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
    pub async fn delete_event(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<(), AppError> {
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
            return Err(AppError::Conflict(format!(
                "Event {id} is already live"
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
        self.to_event_view(db, updated).await
    }

    // --- Battle linker -----------------------------------------------------

    /// Counts current sign-ups for `event_id`.
    async fn count_participants(
        db: &DatabaseConnection,
        event_id: i64,
    ) -> Result<usize, AppError> {
        let n = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(event_id))
            .count(db)
            .await
            .map_err(AppError::Database)?;
        Ok(n as usize)
    }

    /// Returns the accepted guild-player-count range for the event.
    ///
    /// Rule agreed in planning: if `n` signed up, accept battles where the guild
    /// had between `n/2` and `n*1.5` players (e.g. 20 -> 10..30).
    #[must_use]
    fn participant_target_range(participants: usize) -> (i64, i64) {
        let n = participants as i64;
        let min = (n / 2).max(1);
        let max = ((n * 3) / 2).max(min);
        (min, max)
    }

    /// Links AlbionBB battles to an event by time window and guild-player count.
    ///
    /// The worker calls this repeatedly because AlbionBB can lag up to ~30m.
    /// Each tick re-fetches all battles for the guild and upserts matches in the
    /// event's `[started_at, stopped_at|now]` window.
    pub async fn link_battles_for_event(
        db: &DatabaseConnection,
        albionbb: &AlbionBbService,
        guild_id: &str,
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

        let participant_count = Self::count_participants(db, event_id).await?;
        let (min_guild_players, max_guild_players) =
            Self::participant_target_range(participant_count);

        let filters = AlbionBbBattlesFilters {
            guild_id: Some(guild_id.to_string()),
            min_players: Some(min_guild_players),
            min_guild_players: Some(min_guild_players),
            page: Some(1),
            ..Default::default()
        };
        let (battles, _) = albionbb.get_battles(None, &filters).await?;

        let mut active: event::ActiveModel = model.into();
        active.link_attempts = Set(active.link_attempts.unwrap() + 1);
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

            let guild_players = battle
                .guilds
                .iter()
                .find(|g| g.id == guild_id)
                .map(|g| g.players)
                .unwrap_or(0);
            if guild_players < min_guild_players || guild_players > max_guild_players {
                continue;
            }

            let existing = event_battle::Entity::find()
                .filter(event_battle::Column::EventId.eq(event_id))
                .filter(event_battle::Column::AlbionbbBattleId.eq(battle.id.to_string()))
                .one(db)
                .await
                .map_err(AppError::Database)?;

            if let Some(existing) = existing {
                let mut row: event_battle::ActiveModel = existing.into();
                row.guild_players_count = Set(guild_players as i32);
                row.battle_total_players = Set(Some(battle.total_players as i32));
                row.fetched_at = Set(Utc::now().into());
                row.update(db).await.map_err(AppError::Database)?;
            } else {
                event_battle::ActiveModel {
                    event_id: Set(event_id),
                    albionbb_battle_id: Set(battle.id.to_string()),
                    battle_started_at: Set(started.into()),
                    guild_players_count: Set(guild_players as i32),
                    battle_total_players: Set(Some(battle.total_players as i32)),
                    fetched_at: Set(Utc::now().into()),
                    ..Default::default()
                }
                .insert(db)
                .await
                .map_err(AppError::Database)?;
                inserted += 1;
            }
        }

        Ok(inserted)
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
        // Validate event exists
        let event_model = event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;

        // Validate builds exist in DB
        let primary_exists = build::Entity::find_by_id(req.primary_build_id)
            .count(db)
            .await
            .map_err(AppError::Database)?
            > 0;
        if !primary_exists {
            return Err(AppError::NotFound(format!("Primary build {} not found", req.primary_build_id)));
        }

        if let Some(sec_id) = req.secondary_build_id {
            let secondary_exists = build::Entity::find_by_id(sec_id)
                .count(db)
                .await
                .map_err(AppError::Database)?
                > 0;
            if !secondary_exists {
                return Err(AppError::NotFound(format!("Secondary build {} not found", sec_id)));
            }
        }

        // Fetch current participations
        let current_participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(event_id))
            .all(db)
            .await
            .map_err(AppError::Database)?;

        let existing = current_participations.iter().find(|p| p.user_id == user_id);

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
            .find(|cb| cb.build_id == req.primary_build_id)
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "Primary build {} is not allowed in comp {}",
                    req.primary_build_id, active_comp.name
                ))
            })?;

        // Verify secondary build exists in active comp (if provided)
        if let Some(sec_id) = req.secondary_build_id {
            let exists = active_comp_builds.iter().any(|cb| cb.build_id == sec_id);
            if !exists {
                return Err(AppError::Validation(format!(
                    "Secondary build {} is not allowed in comp {}",
                    sec_id, active_comp.name
                )));
            }
        }

        // Verify primary build slot availability
        let taken_count = current_participations
            .iter()
            .filter(|p| p.user_id != user_id && p.primary_build_id == req.primary_build_id)
            .count();

        if taken_count >= primary_cb.quantity as usize {
            return Err(AppError::Validation(format!(
                "Il ruolo primario per la build '{}' è già al completo (limite comp: {})",
                req.primary_build_id, primary_cb.quantity
            )));
        }

        // Save or update
        if let Some(p) = existing {
            let mut active: event_participation::ActiveModel = p.clone().into();
            active.primary_build_id = Set(req.primary_build_id);
            active.secondary_build_id = Set(req.secondary_build_id);
            active.updated_at = Set(chrono::Utc::now().into());
            active.update(db).await.map_err(AppError::Database)?;
        } else {
            let active = event_participation::ActiveModel {
                event_id: Set(event_id),
                user_id: Set(user_id),
                primary_build_id: Set(req.primary_build_id),
                secondary_build_id: Set(req.secondary_build_id),
                ..Default::default()
            };
            active.insert(db).await.map_err(AppError::Database)?;
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
            return Err(AppError::NotFound(format!("User {user_id} is not registered for event {event_id}")));
        }

        self.get_event_detail(db, event_id).await
    }
}

impl Default for EventService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{Database, ActiveValue::Set};
    use crate::migration::MigratorTrait;
    use crate::modules::users::entities::ActiveModel as UserActiveModel;
    use crate::modules::comps::entities::{comp::ActiveModel as CompActiveModel, comp_build::ActiveModel as CompBuildActiveModel, build::ActiveModel as BuildActiveModel, comp_category::ActiveModel as CompCategoryActiveModel, build_category::ActiveModel as BuildCategoryActiveModel};

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
        cat.insert(db).await.expect("Failed to insert build category").id
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
        cat.insert(db).await.expect("Failed to insert comp category").id
    }

    async fn create_comp(db: &DatabaseConnection, name: &str, category_id: i64, parent_id: Option<i64>, builds: Vec<(i64, i32)>) -> i64 {
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
                    comp_id,
                    event_date_utc: "2026-07-20T20:00:00Z".to_string(),
                },
            )
            .await
            .unwrap();

        assert_eq!(event.title, "ZvZ Castle Fight");
        assert_eq!(event.comp_id, comp_id);
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
        let variant_comp = create_comp(&db, "Variant Comp 2", cat, Some(base_comp), vec![(b1, 1), (b2, 1)]).await;

        let service = EventService::new();
        let event = service
            .create_event(
                &db,
                creator,
                CreateEventRequest {
                    title: "Scaling Event".to_string(),
                    description: None,
                    comp_id: base_comp,
                    event_date_utc: "2026-07-20T20:00:00Z".to_string(),
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
                    comp_id,
                    event_date_utc: "2026-07-20T20:00:00Z".to_string(),
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
}
