//! Split service logic module.
//!
//! Provides the loot-split workflow: a request that includes its participants upfront (starting
//! in `"pending"` status), officer-driven participant adjustments, and officer-driven closing of
//! the split into `"completed"` (generates Guild Bank transactions), `"not_completed"`, or
//! `"lost"`. Request/response types live in `models.rs`; the status enum lives in `status.rs`.

use std::collections::HashSet;
use std::str::FromStr;

use sea_orm::prelude::Decimal;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::albion::entities::albion_link::Entity as AlbionLinkEntity;
use crate::modules::bank::entities::ActiveModel as TransactionActiveModel;
use crate::modules::bank::service::TYPE_SPLIT_CREDIT;
use crate::modules::bank::status::TransactionStatus;
use crate::modules::events::entities::event::Entity as EventEntity;
use crate::modules::events::entities::event_participation::{
    Column as EventParticipationColumn, Entity as EventParticipationEntity,
};
use crate::modules::users::entities::{Column as UserColumn, Entity as UserEntity};
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

use super::city::SplitIslandCity;
use super::entities::split::{
    ActiveModel as SplitActiveModel, Column as SplitColumn, Entity as SplitEntity,
    Model as SplitModel,
};
use super::entities::split_island::{
    ActiveModel as IslandActiveModel, Column as IslandColumn, Entity as IslandEntity,
    Model as IslandModel,
};
use super::entities::split_island_tab::{
    ActiveModel as TabActiveModel, Column as TabColumn, Entity as TabEntity, Model as TabModel,
};
use super::entities::split_participant::{
    ActiveModel as ParticipantActiveModel, Column as ParticipantColumn, Entity as ParticipantEntity,
};
use super::models::{
    BatchFailure, CompleteSplitsBatchResult, CreateIslandRequest, CreateIslandTabRequest,
    CreateSplitRequest, MatchedParticipant, SplitDetail, SplitFilters, SplitIslandTabView,
    SplitIslandView, SplitKpiSummary, SplitParticipantView, SplitSummary, UpdateIslandRequest,
    UpdateIslandTabRequest, UpdateSplitRequest, UpsertParticipantRequest,
};
use super::status::SplitStatus;

/// Parses a split model's stored status string into a [`SplitStatus`].
///
/// The stored value is always one written by this service, so a parse failure indicates
/// database corruption rather than a user-facing condition.
fn parse_status(split: &SplitModel) -> Result<SplitStatus, AppError> {
    SplitStatus::from_str(&split.status)
        .map_err(|_| AppError::Internal(format!("Unknown split status: {}", split.status)))
}

/// Resolves list-splits `sort`/`order` against the whitelist.
///
/// Default is `created_at` descending. An unknown `sort` is a validation error
/// so a typo cannot silently fall back.
fn resolve_split_list_sort(
    sort: Option<&str>,
    order: Option<&str>,
) -> Result<(SplitColumn, SortOrder), AppError> {
    let column = resolve_sort_key(
        sort,
        &[
            ("created_at", SplitColumn::CreatedAt),
            ("status", SplitColumn::Status),
            ("note", SplitColumn::Note),
        ],
        SplitColumn::CreatedAt,
    )?;
    Ok((column, SortOrder::from_query(order)))
}

/// Ensures an optional event link points to a real event.
async fn validate_event_link(
    db: &DatabaseConnection,
    event_id: Option<i64>,
) -> Result<(), AppError> {
    let Some(event_id) = event_id else {
        return Ok(());
    };

    let exists = EventEntity::find_by_id(event_id).count(db).await? > 0;
    if exists {
        return Ok(());
    }

    Err(AppError::NotFound(format!("Event {event_id} not found")))
}

/// Default weight assigned to split participants imported from a linked event.
///
/// Events only record who signed up, not how the loot should be weighted, so imported
/// participants receive this baseline. Officers can still tune weights afterwards via
/// `add_or_update_participant`.
const IMPORTED_EVENT_PARTICIPANT_WEIGHT: i32 = 1;

/// Resolves the user ids of every player signed up to `event_id`.
///
/// Returns an empty `Vec` when the event has no sign-ups yet; callers must decide how to
/// react (e.g. refusing to wipe a split's roster when linking an empty event).
async fn event_participant_ids<C>(db: &C, event_id: i64) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait,
{
    let participations = EventParticipationEntity::find()
        .filter(EventParticipationColumn::EventId.eq(event_id))
        .all(db)
        .await?;
    Ok(participations.into_iter().map(|p| p.user_id).collect())
}

/// Resolves the event title for a linked split summary.
async fn event_title(
    db: &DatabaseConnection,
    event_id: Option<i64>,
) -> Result<Option<String>, AppError> {
    let Some(event_id) = event_id else {
        return Ok(None);
    };

    let title = EventEntity::find_by_id(event_id)
        .one(db)
        .await?
        .map(|event| event.title);
    Ok(title)
}

struct SplitLocation {
    island_id: Option<i64>,
    island_name: Option<String>,
    island_city: Option<String>,
    island_tab_id: Option<i64>,
    island_tab_name: Option<String>,
}

async fn split_location(
    db: &DatabaseConnection,
    island_tab_id: Option<i64>,
) -> Result<SplitLocation, AppError> {
    let Some(tab_id) = island_tab_id else {
        return Ok(SplitLocation {
            island_id: None,
            island_name: None,
            island_city: None,
            island_tab_id: None,
            island_tab_name: None,
        });
    };

    let Some(tab) = TabEntity::find_by_id(tab_id).one(db).await? else {
        return Ok(SplitLocation {
            island_id: None,
            island_name: None,
            island_city: None,
            island_tab_id: Some(tab_id),
            island_tab_name: None,
        });
    };

    let island = IslandEntity::find_by_id(tab.island_id).one(db).await?;
    Ok(SplitLocation {
        island_id: Some(tab.island_id),
        island_name: island.as_ref().map(|island| island.name.clone()),
        island_city: island.as_ref().map(|island| island.city.clone()),
        island_tab_id: Some(tab.id),
        island_tab_name: Some(tab.name),
    })
}

fn parse_city(raw: &str) -> Result<SplitIslandCity, AppError> {
    SplitIslandCity::from_str(raw.trim()).map_err(AppError::Validation)
}

fn trim_required_name(raw: &str, field: &str) -> Result<String, AppError> {
    let name = raw.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation(format!("{field} is required")));
    }
    Ok(name)
}

/// Confirms `island_tab_id` points at a real catalog tab.
///
/// # Errors
///
/// Returns [`AppError::NotFound`] when the tab does not exist.
pub(crate) async fn require_island_tab(
    db: &DatabaseConnection,
    island_tab_id: i64,
) -> Result<TabModel, AppError> {
    TabEntity::find_by_id(island_tab_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("island tab {island_tab_id} not found")))
}

async fn island_name_taken(
    db: &DatabaseConnection,
    city: &str,
    name: &str,
    except_id: Option<i64>,
) -> Result<bool, AppError> {
    let islands = IslandEntity::find()
        .filter(IslandColumn::City.eq(city))
        .all(db)
        .await?;
    Ok(islands
        .iter()
        .any(|island| except_id != Some(island.id) && island.name.eq_ignore_ascii_case(name)))
}

async fn tab_name_taken(
    db: &DatabaseConnection,
    island_id: i64,
    name: &str,
    except_id: Option<i64>,
) -> Result<bool, AppError> {
    let tabs = TabEntity::find()
        .filter(TabColumn::IslandId.eq(island_id))
        .all(db)
        .await?;
    Ok(tabs
        .iter()
        .any(|tab| except_id != Some(tab.id) && tab.name.eq_ignore_ascii_case(name)))
}

async fn tab_is_referenced(db: &DatabaseConnection, tab_id: i64) -> Result<bool, AppError> {
    Ok(SplitEntity::find()
        .filter(SplitColumn::IslandTabId.eq(tab_id))
        .count(db)
        .await?
        > 0)
}

fn to_island_view(island: IslandModel, tabs: Vec<TabModel>) -> SplitIslandView {
    let city = SplitIslandCity::from_str(&island.city).unwrap_or(SplitIslandCity::Lymhurst);
    let mut tabs = tabs;
    tabs.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| a.name.cmp(&b.name))
    });
    SplitIslandView {
        id: island.id,
        name: island.name,
        city,
        tabs: tabs
            .into_iter()
            .map(|tab| SplitIslandTabView {
                id: tab.id,
                name: tab.name,
                sort_order: tab.sort_order,
            })
            .collect(),
    }
}

async fn load_island_view(
    db: &DatabaseConnection,
    island: IslandModel,
) -> Result<SplitIslandView, AppError> {
    let tabs = TabEntity::find()
        .filter(TabColumn::IslandId.eq(island.id))
        .all(db)
        .await?;
    Ok(to_island_view(island, tabs))
}

/// Service for executing business logic operations related to loot splits.
pub struct SplitService;

impl SplitService {
    /// Creates a new instance of the `SplitService`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    pub(crate) async fn to_summary(
        &self,
        db: &DatabaseConnection,
        split: SplitModel,
    ) -> Result<SplitSummary, AppError> {
        let status = parse_status(&split)?;
        let created_by_username =
            crate::modules::users::display_name::resolve_by_id(db, split.created_by).await?;
        let participant_count = ParticipantEntity::find()
            .filter(ParticipantColumn::SplitId.eq(split.id))
            .count(db)
            .await?;
        let linked_event_title = event_title(db, split.event_id).await?;
        let location = split_location(db, split.island_tab_id).await?;

        Ok(SplitSummary {
            id: split.id,
            created_by_username,
            status,
            estimated_market_value: split.estimated_market_value,
            repair_value: split.repair_value,
            bags_value: split.bags_value,
            net_value: split.net_value,
            note: split.note,
            event_id: split.event_id,
            event_title: linked_event_title,
            island_id: location.island_id,
            island_name: location.island_name,
            island_city: location.island_city,
            island_tab_id: location.island_tab_id,
            island_tab_name: location.island_tab_name,
            created_at: split.created_at.to_rfc3339(),
            finalized_at: split.finalized_at.map(|dt| dt.to_rfc3339()),
            participant_count,
            updated_at: split.updated_at.to_rfc3339(),
        })
    }

    async fn to_detail(
        &self,
        db: &DatabaseConnection,
        split: SplitModel,
    ) -> Result<SplitDetail, AppError> {
        let participants = ParticipantEntity::find()
            .filter(ParticipantColumn::SplitId.eq(split.id))
            .all(db)
            .await?;

        let participant_user_ids: Vec<i64> = participants.iter().map(|p| p.user_id).collect();
        let participant_users = UserEntity::find()
            .filter(UserColumn::Id.is_in(participant_user_ids))
            .all(db)
            .await?;
        let discord_ids: std::collections::HashMap<i64, Option<String>> = participant_users
            .into_iter()
            .map(|u| (u.id, u.discord_id))
            .collect();

        let total_weight: i64 = participants.iter().map(|p| i64::from(p.weight)).sum();
        let net_value = split.net_value;

        // Once completed, the authoritative share amounts are whatever was actually written to
        // the transactions table at completion time (which applies remainder-correction so the
        // sum is exact) — read those back rather than recomputing, to avoid the two diverging.
        let generated_amounts: std::collections::HashMap<i64, Decimal> = if net_value.is_some() {
            crate::modules::bank::entities::Entity::find()
                .filter(crate::modules::bank::entities::Column::SplitId.eq(split.id))
                .all(db)
                .await?
                .into_iter()
                .map(|tx| (tx.to_user_id, tx.amount))
                .collect()
        } else {
            std::collections::HashMap::new()
        };

        let participant_ids: Vec<i64> = participants.iter().map(|p| p.user_id).collect();
        let names =
            crate::modules::users::display_name::resolve_by_ids(db, &participant_ids).await?;

        let mut views = Vec::with_capacity(participants.len());
        for p in participants {
            let username = names
                .get(&p.user_id)
                .cloned()
                .unwrap_or_else(|| "Unknown".to_string());
            let share_amount = generated_amounts.get(&p.user_id).copied().or_else(|| {
                net_value.map(|net| {
                    if total_weight == 0 {
                        Decimal::ZERO
                    } else {
                        (net * Decimal::from(p.weight) / Decimal::from(total_weight)).round_dp(2)
                    }
                })
            });
            views.push(SplitParticipantView {
                user_id: p.user_id,
                discord_id: discord_ids.get(&p.user_id).cloned().flatten(),
                username,
                weight: p.weight,
                share_amount,
            });
        }

        let summary = self.to_summary(db, split).await?;

        Ok(SplitDetail {
            summary,
            participants: views,
        })
    }

    /// Requests a new split together with its participants. Starts in [`SplitStatus::Pending`],
    /// awaiting an officer to close it via [`Self::complete_split`], [`Self::mark_not_completed`],
    /// or [`Self::mark_lost`].
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if `participants` is empty, contains a duplicate user id,
    ///   or a non-positive weight.
    /// * Returns `AppError::Database` if the insert fails.
    pub async fn create_split(
        &self,
        db: &DatabaseConnection,
        creator_id: i64,
        req: CreateSplitRequest,
    ) -> Result<SplitDetail, AppError> {
        validate_event_link(db, req.event_id).await?;

        // When no participants are provided but an event is linked, the split's roster is
        // seeded from the event's sign-ups. Each imported participant starts with the
        // baseline event weight.
        let mut participants = req.participants;
        if participants.is_empty()
            && let Some(event_id) = req.event_id
        {
            let event_user_ids = event_participant_ids(db, event_id).await?;
            if event_user_ids.is_empty() {
                return Err(AppError::Validation(format!(
                    "event {event_id} has no participants to import"
                )));
            }
            participants = event_user_ids
                .into_iter()
                .map(|user_id| UpsertParticipantRequest {
                    user_id,
                    weight: IMPORTED_EVENT_PARTICIPANT_WEIGHT,
                })
                .collect();
        }

        if participants.is_empty() {
            return Err(AppError::Validation(
                "a split must be requested with at least one participant".to_string(),
            ));
        }
        if participants.iter().any(|p| p.weight <= 0) {
            return Err(AppError::Validation("weight must be positive".to_string()));
        }
        let mut seen = HashSet::with_capacity(participants.len());
        if !participants.iter().all(|p| seen.insert(p.user_id)) {
            return Err(AppError::Validation(
                "participants must not contain duplicate user ids".to_string(),
            ));
        }

        require_island_tab(db, req.island_tab_id).await?;

        let txn = db.begin().await?;

        let active = SplitActiveModel {
            created_by: Set(creator_id),
            status: Set(SplitStatus::Pending.to_string()),
            estimated_market_value: Set(req.estimated_market_value),
            repair_value: Set(req.repair_value),
            bags_value: Set(req.bags_value),
            net_value: Set(None),
            note: Set(req.note),
            event_id: Set(req.event_id),
            island_tab_id: Set(Some(req.island_tab_id)),
            ..Default::default()
        };
        let inserted = active.insert(&txn).await?;

        for participant in &participants {
            let active = ParticipantActiveModel {
                split_id: Set(inserted.id),
                user_id: Set(participant.user_id),
                weight: Set(participant.weight),
                ..Default::default()
            };
            active.insert(&txn).await?;
        }

        txn.commit().await?;

        self.to_detail(db, inserted).await
    }

    async fn load_with_status(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        expected: SplitStatus,
        action: &str,
    ) -> Result<SplitModel, AppError> {
        let split = SplitEntity::find_by_id(split_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Split {split_id} not found")))?;
        if parse_status(&split)? != expected {
            return Err(AppError::Validation(format!(
                "cannot {action} a split that is not in {expected} status"
            )));
        }
        Ok(split)
    }

    /// Closes a pending split with a terminal, non-completing status (`"not_completed"` or
    /// `"lost"`) — no Guild Bank transactions are generated.
    async fn close_split(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        status: SplitStatus,
    ) -> Result<SplitDetail, AppError> {
        let split = self
            .load_with_status(db, split_id, SplitStatus::Pending, "close")
            .await?;
        let mut active: SplitActiveModel = split.into();
        active.status = Set(status.to_string());
        active.updated_at = Set(chrono::Utc::now().into());
        let updated = active.update(db).await?;
        self.to_detail(db, updated).await
    }

    /// Marks a pending split as not completed (e.g. the distribution didn't happen). Terminal.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if the split does not exist.
    /// * Returns `AppError::Validation` if the split is not in `"pending"` status.
    pub async fn mark_not_completed(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
    ) -> Result<SplitDetail, AppError> {
        self.close_split(db, split_id, SplitStatus::NotCompleted)
            .await
    }

    /// Marks a pending split as lost — the loot was never recovered. Terminal.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if the split does not exist.
    /// * Returns `AppError::Validation` if the split is not in `"pending"` status.
    pub async fn mark_lost(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
    ) -> Result<SplitDetail, AppError> {
        self.close_split(db, split_id, SplitStatus::Lost).await
    }

    /// Updates mutable split values while the split is still pending.
    ///
    /// Linking an event (`event_id` set to `Some(Some(id))`) has a side effect: the split's
    /// roster is synchronized with the event's participants. Participants already in the
    /// split keep their weights; participants absent from the event are dropped; event
    /// sign-ups not yet in the split are added with [`IMPORTED_EVENT_PARTICIPANT_WEIGHT`].
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if the split is not pending, or the linked event has
    ///   no participants to import.
    pub async fn update_split(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        req: UpdateSplitRequest,
    ) -> Result<SplitDetail, AppError> {
        let split = self
            .load_with_status(db, split_id, SplitStatus::Pending, "update")
            .await?;
        let mut active: SplitActiveModel = split.into();

        active.updated_at = Set(chrono::Utc::now().into());

        if let Some(value) = req.estimated_market_value {
            active.estimated_market_value = Set(value);
        }
        if let Some(value) = req.repair_value {
            active.repair_value = Set(value);
        }
        if let Some(value) = req.bags_value {
            active.bags_value = Set(value);
        }
        if let Some(note) = req.note {
            let trimmed = note.trim().to_string();
            active.note = Set((!trimmed.is_empty()).then_some(trimmed));
        }

        let linked_event_id = req.event_id;
        let is_linking_event = matches!(linked_event_id, Some(Some(_)));

        if let Some(Some(event_id)) = linked_event_id {
            validate_event_link(db, Some(event_id)).await?;
        }

        if let Some(tab_id) = req.island_tab_id {
            require_island_tab(db, tab_id).await?;
            active.island_tab_id = Set(Some(tab_id));
        }

        let txn = db.begin().await?;

        if let Some(event_id_opt) = linked_event_id {
            active.event_id = Set(event_id_opt);
        }

        let updated = active.update(&txn).await?;

        if let Some(Some(event_id)) = linked_event_id {
            self.sync_participants_from_event(&txn, updated.id, event_id)
                .await?;
        }

        txn.commit().await?;

        if is_linking_event {
            // Re-read after the participant sync so the returned detail reflects the new roster.
            return self.get_split(db, updated.id).await;
        }

        self.to_detail(db, updated).await
    }

    /// Synchronizes a split's roster with the participants of a linked event.
    ///
    /// Implemented as a set reconciliation over user ids:
    /// - participants present in the split but absent from the event are deleted;
    /// - participants present in the event but absent from the split are inserted with
    ///   [`IMPORTED_EVENT_PARTICIPANT_WEIGHT`];
    /// - participants in both keep their existing weight untouched.
    ///
    /// Refuses to run when the event has no sign-ups, since that would silently empty the
    /// split and leave it impossible to complete.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Validation` if the linked event has no participants.
    async fn sync_participants_from_event<C>(
        &self,
        db: &C,
        split_id: i64,
        event_id: i64,
    ) -> Result<(), AppError>
    where
        C: ConnectionTrait,
    {
        let event_user_ids = event_participant_ids(db, event_id).await?;
        if event_user_ids.is_empty() {
            return Err(AppError::Validation(format!(
                "cannot link event {event_id}: the event has no participants to import"
            )));
        }

        let event_user_set: HashSet<i64> = event_user_ids.into_iter().collect();

        let existing = ParticipantEntity::find()
            .filter(ParticipantColumn::SplitId.eq(split_id))
            .all(db)
            .await?;
        let existing_user_set: HashSet<i64> = existing.iter().map(|p| p.user_id).collect();

        let to_remove: Vec<i64> = existing_user_set
            .difference(&event_user_set)
            .copied()
            .collect();
        if !to_remove.is_empty() {
            ParticipantEntity::delete_many()
                .filter(ParticipantColumn::SplitId.eq(split_id))
                .filter(ParticipantColumn::UserId.is_in(to_remove))
                .exec(db)
                .await?;
        }

        let to_add: Vec<i64> = event_user_set
            .difference(&existing_user_set)
            .copied()
            .collect();
        for user_id in to_add {
            let active = ParticipantActiveModel {
                split_id: Set(split_id),
                user_id: Set(user_id),
                weight: Set(IMPORTED_EVENT_PARTICIPANT_WEIGHT),
                ..Default::default()
            };
            active.insert(db).await?;
        }

        Ok(())
    }

    /// Deletes a split entirely.
    ///
    /// # Errors
    ///
    /// Returns `AppError::NotFound` if the split does not exist.
    pub async fn delete_split(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
    ) -> Result<(), AppError> {
        let split = SplitEntity::find_by_id(split_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Split {split_id} not found")))?;

        let txn = db.begin().await?;
        ParticipantEntity::delete_many()
            .filter(ParticipantColumn::SplitId.eq(split_id))
            .exec(&txn)
            .await?;

        let active: SplitActiveModel = split.into();
        active.delete(&txn).await?;

        txn.commit().await?;
        Ok(())
    }

    /// Guild-wide KPI totals for the splits list page.
    ///
    /// Aggregates every split, not the current list page, so the cards stay
    /// honest when the table is filtered or paginated.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if a query fails.
    pub async fn kpi_summary(&self, db: &DatabaseConnection) -> Result<SplitKpiSummary, AppError> {
        let splits = SplitEntity::find().all(db).await?;
        let mut pending_count = 0_u64;
        let mut completed_count = 0_u64;
        let mut total_net_distributed = Decimal::ZERO;
        let mut total_estimated_volume = Decimal::ZERO;
        for split in &splits {
            total_estimated_volume += split.estimated_market_value;
            match parse_status(split)? {
                SplitStatus::Pending => pending_count += 1,
                SplitStatus::Completed => {
                    completed_count += 1;
                    total_net_distributed += split.net_value.unwrap_or(
                        split.estimated_market_value - split.repair_value + split.bags_value,
                    );
                }
                SplitStatus::NotCompleted | SplitStatus::Lost => {}
            }
        }
        let total_participants = ParticipantEntity::find().count(db).await?;
        Ok(SplitKpiSummary {
            pending_count,
            completed_count,
            total_net_distributed,
            total_estimated_volume,
            total_participants,
        })
    }

    /// Fetches a split's full detail by id.
    ///
    /// # Errors
    ///
    /// Returns `AppError::NotFound` if the split does not exist.
    pub async fn get_split(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
    ) -> Result<SplitDetail, AppError> {
        let split = SplitEntity::find_by_id(split_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Split {split_id} not found")))?;
        self.to_detail(db, split).await
    }

    /// Lists paginated and filtered splits from the database.
    ///
    /// Defaults to `created_at desc`. Use [`Self::list_splits_sorted`] to pick
    /// a column.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the query fails.
    pub async fn list_splits(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        filters: &SplitFilters,
    ) -> Result<PaginatedData<SplitSummary>, AppError> {
        self.list_splits_sorted(db, pagination, filters, None, None)
            .await
    }

    /// Lists paginated splits with an explicit sort column and direction.
    ///
    /// Allowed `sort` keys: `created_at` (default), `status`, `note`. Unknown
    /// keys are a validation error. `order` is `asc` or `desc` (default desc).
    ///
    /// # Errors
    ///
    /// * [`AppError::Validation`] when `sort` is not in the whitelist.
    /// * [`AppError::Database`] if the query fails.
    pub async fn list_splits_sorted(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        filters: &SplitFilters,
        sort: Option<&str>,
        order: Option<&str>,
    ) -> Result<PaginatedData<SplitSummary>, AppError> {
        let (sort_column, sort_order) = resolve_split_list_sort(sort, order)?;
        let mut query = SplitEntity::find();
        if let Some(status) = filters.status {
            query = query.filter(SplitColumn::Status.eq(status.to_string()));
        }
        if let Some(event_id) = filters.event_id {
            query = query.filter(SplitColumn::EventId.eq(event_id));
        }
        if let Some(island_id) = filters.island_id {
            let tab_ids = TabEntity::find()
                .filter(TabColumn::IslandId.eq(island_id))
                .all(db)
                .await?
                .into_iter()
                .map(|tab| tab.id)
                .collect::<Vec<_>>();
            query = query.filter(SplitColumn::IslandTabId.is_in(tab_ids));
        }

        if let Some(search) = filters.search.as_deref().filter(|s| !s.trim().is_empty()) {
            let pattern = format!("%{}%", search.trim());

            let note_cond = sea_orm::sea_query::Expr::expr(sea_orm::sea_query::Func::lower(
                sea_orm::sea_query::Expr::col(SplitColumn::Note),
            ))
            .like(pattern.to_lowercase());

            let user_subquery = sea_orm::sea_query::Query::select()
                .column(UserColumn::Id)
                .from(UserEntity)
                .and_where(
                    sea_orm::sea_query::Expr::expr(sea_orm::sea_query::Func::lower(
                        sea_orm::sea_query::Expr::col(UserColumn::Username),
                    ))
                    .like(pattern.to_lowercase()),
                )
                .to_owned();

            let creator_cond = SplitColumn::CreatedBy.in_subquery(user_subquery);

            query = query.filter(sea_orm::Condition::any().add(note_cond).add(creator_cond));
        }

        if let Some(date_from) = &filters.date_from {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(date_from) {
                query = query.filter(SplitColumn::CreatedAt.gte(dt));
            }
        }

        if let Some(date_to) = &filters.date_to {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(date_to) {
                query = query.filter(SplitColumn::CreatedAt.lte(dt));
            }
        }

        let query = match sort_order {
            SortOrder::Asc => query
                .order_by_asc(sort_column)
                .order_by_asc(SplitColumn::Id),
            SortOrder::Desc => query
                .order_by_desc(sort_column)
                .order_by_desc(SplitColumn::Id),
        };

        let limit = pagination.limit();
        let page = pagination.offset_page();

        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;

        let mut items = Vec::with_capacity(models.len());
        for model in models {
            items.push(self.to_summary(db, model).await?);
        }

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Lists every island in the catalog, tabs nested and ordered.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] if the query fails.
    pub async fn list_islands(
        &self,
        db: &DatabaseConnection,
    ) -> Result<Vec<SplitIslandView>, AppError> {
        let islands = IslandEntity::find()
            .order_by_asc(IslandColumn::City)
            .order_by_asc(IslandColumn::Name)
            .all(db)
            .await?;
        let mut views = Vec::with_capacity(islands.len());
        for island in islands {
            views.push(load_island_view(db, island).await?);
        }
        Ok(views)
    }

    /// Creates an island together with at least one named tab.
    ///
    /// # Errors
    ///
    /// `Validation` for empty name, unknown city, zero tabs, or duplicate names.
    pub async fn create_island(
        &self,
        db: &DatabaseConnection,
        req: CreateIslandRequest,
    ) -> Result<SplitIslandView, AppError> {
        let name = trim_required_name(&req.name, "name")?;
        let city = parse_city(&req.city)?;
        let mut tab_names = Vec::new();
        for raw in &req.tabs {
            let tab_name = trim_required_name(raw, "tab name")?;
            if tab_names
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(&tab_name))
            {
                return Err(AppError::Validation(format!(
                    "duplicate tab name on island: {tab_name}"
                )));
            }
            tab_names.push(tab_name);
        }
        if tab_names.is_empty() {
            return Err(AppError::Validation(
                "an island must be created with at least one tab".to_string(),
            ));
        }
        if island_name_taken(db, city.as_str(), &name, None).await? {
            return Err(AppError::Validation(format!(
                "island {name} already exists in {}",
                city.as_str()
            )));
        }

        let txn = db.begin().await?;
        let island = IslandActiveModel {
            name: Set(name),
            city: Set(city.to_string()),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        for (index, tab_name) in tab_names.into_iter().enumerate() {
            TabActiveModel {
                island_id: Set(island.id),
                name: Set(tab_name),
                sort_order: Set(i32::try_from(index).unwrap_or(i32::MAX)),
                ..Default::default()
            }
            .insert(&txn)
            .await?;
        }
        txn.commit().await?;

        load_island_view(db, island).await
    }

    /// Renames an island or moves it to another city.
    ///
    /// # Errors
    ///
    /// `NotFound` if the island is missing; `Validation` for empty name, unknown city, or clash.
    pub async fn update_island(
        &self,
        db: &DatabaseConnection,
        island_id: i64,
        req: UpdateIslandRequest,
    ) -> Result<SplitIslandView, AppError> {
        let island = IslandEntity::find_by_id(island_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("island {island_id} not found")))?;

        let mut active: IslandActiveModel = island.clone().into();
        let next_name = if let Some(name) = req.name {
            Some(trim_required_name(&name, "name")?)
        } else {
            None
        };
        let next_city = if let Some(city) = req.city {
            Some(parse_city(&city)?)
        } else {
            None
        };

        let check_name = next_name.as_deref().unwrap_or(&island.name);
        let check_city = next_city
            .map(|city| city.to_string())
            .unwrap_or_else(|| island.city.clone());
        if island_name_taken(db, &check_city, check_name, Some(island.id)).await? {
            return Err(AppError::Validation(format!(
                "island {check_name} already exists in {check_city}"
            )));
        }

        if let Some(name) = next_name {
            active.name = Set(name);
        }
        if let Some(city) = next_city {
            active.city = Set(city.to_string());
        }
        let updated = active.update(db).await?;
        load_island_view(db, updated).await
    }

    /// Deletes an island and its tabs when none of the tabs are referenced by a split.
    ///
    /// # Errors
    ///
    /// `NotFound` if missing; `Validation` if a tab is still used by a split.
    pub async fn delete_island(
        &self,
        db: &DatabaseConnection,
        island_id: i64,
    ) -> Result<(), AppError> {
        let island = IslandEntity::find_by_id(island_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("island {island_id} not found")))?;
        let tabs = TabEntity::find()
            .filter(TabColumn::IslandId.eq(island.id))
            .all(db)
            .await?;
        for tab in &tabs {
            if tab_is_referenced(db, tab.id).await? {
                return Err(AppError::Validation(
                    "cannot delete an island while a split still uses one of its tabs".to_string(),
                ));
            }
        }
        IslandEntity::delete_by_id(island.id).exec(db).await?;
        Ok(())
    }

    /// Adds a named tab to an existing island.
    ///
    /// # Errors
    ///
    /// `NotFound` if the island is missing; `Validation` for empty or duplicate names.
    pub async fn add_island_tab(
        &self,
        db: &DatabaseConnection,
        island_id: i64,
        req: CreateIslandTabRequest,
    ) -> Result<SplitIslandView, AppError> {
        let island = IslandEntity::find_by_id(island_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("island {island_id} not found")))?;
        let name = trim_required_name(&req.name, "tab name")?;
        if tab_name_taken(db, island.id, &name, None).await? {
            return Err(AppError::Validation(format!(
                "tab {name} already exists on this island"
            )));
        }
        let sort_order = if let Some(order) = req.sort_order {
            order
        } else {
            let existing = TabEntity::find()
                .filter(TabColumn::IslandId.eq(island.id))
                .all(db)
                .await?;
            existing
                .iter()
                .map(|tab| tab.sort_order)
                .max()
                .unwrap_or(-1)
                .saturating_add(1)
        };
        TabActiveModel {
            island_id: Set(island.id),
            name: Set(name),
            sort_order: Set(sort_order),
            ..Default::default()
        }
        .insert(db)
        .await?;
        load_island_view(db, island).await
    }

    /// Renames or reorders a tab.
    ///
    /// # Errors
    ///
    /// `NotFound` if the island or tab is missing; `Validation` for empty or duplicate names.
    pub async fn update_island_tab(
        &self,
        db: &DatabaseConnection,
        island_id: i64,
        tab_id: i64,
        req: UpdateIslandTabRequest,
    ) -> Result<SplitIslandView, AppError> {
        let island = IslandEntity::find_by_id(island_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("island {island_id} not found")))?;
        let tab = TabEntity::find_by_id(tab_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("island tab {tab_id} not found")))?;
        if tab.island_id != island.id {
            return Err(AppError::NotFound(format!(
                "island tab {tab_id} not found on island {island_id}"
            )));
        }
        let mut active: TabActiveModel = tab.clone().into();
        if let Some(name) = req.name {
            let name = trim_required_name(&name, "tab name")?;
            if tab_name_taken(db, island.id, &name, Some(tab.id)).await? {
                return Err(AppError::Validation(format!(
                    "tab {name} already exists on this island"
                )));
            }
            active.name = Set(name);
        }
        if let Some(sort_order) = req.sort_order {
            active.sort_order = Set(sort_order);
        }
        active.update(db).await?;
        load_island_view(db, island).await
    }

    /// Deletes a tab that is not the island's last tab and is not used by a split.
    ///
    /// # Errors
    ///
    /// `NotFound` if missing; `Validation` if it is the last tab or still referenced.
    pub async fn delete_island_tab(
        &self,
        db: &DatabaseConnection,
        island_id: i64,
        tab_id: i64,
    ) -> Result<SplitIslandView, AppError> {
        let island = IslandEntity::find_by_id(island_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("island {island_id} not found")))?;
        let tab = TabEntity::find_by_id(tab_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("island tab {tab_id} not found")))?;
        if tab.island_id != island.id {
            return Err(AppError::NotFound(format!(
                "island tab {tab_id} not found on island {island_id}"
            )));
        }
        let tab_count = TabEntity::find()
            .filter(TabColumn::IslandId.eq(island.id))
            .count(db)
            .await?;
        if tab_count <= 1 {
            return Err(AppError::Validation(
                "cannot delete the last tab; delete the island instead".to_string(),
            ));
        }
        if tab_is_referenced(db, tab.id).await? {
            return Err(AppError::Validation(
                "cannot delete a tab while a split still uses it".to_string(),
            ));
        }
        TabEntity::delete_by_id(tab.id).exec(db).await?;
        load_island_view(db, island).await
    }

    /// Adds a new participant to a pending split, or updates their weight if already present.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if the split does not exist.
    /// * Returns `AppError::Validation` if the split is not pending, or the weight is not positive.
    pub async fn add_or_update_participant(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        req: UpsertParticipantRequest,
    ) -> Result<SplitDetail, AppError> {
        let split = self
            .load_with_status(db, split_id, SplitStatus::Pending, "modify")
            .await?;

        if req.weight <= 0 {
            return Err(AppError::Validation("weight must be positive".to_string()));
        }

        let existing = ParticipantEntity::find()
            .filter(ParticipantColumn::SplitId.eq(split_id))
            .filter(ParticipantColumn::UserId.eq(req.user_id))
            .one(db)
            .await?;

        if let Some(existing) = existing {
            let mut active: ParticipantActiveModel = existing.into();
            active.weight = Set(req.weight);
            active.update(db).await?;
        } else {
            let active = ParticipantActiveModel {
                split_id: Set(split_id),
                user_id: Set(req.user_id),
                weight: Set(req.weight),
                ..Default::default()
            };
            active.insert(db).await?;
        }

        let mut split_active: SplitActiveModel = split.into();
        split_active.updated_at = Set(chrono::Utc::now().into());
        let split = split_active.update(db).await?;
        self.to_detail(db, split).await
    }

    /// Removes a participant from a pending split.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::NotFound` if the split does not exist.
    /// * Returns `AppError::Validation` if the split is not pending.
    pub async fn remove_participant(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        user_id: i64,
    ) -> Result<SplitDetail, AppError> {
        let split = self
            .load_with_status(db, split_id, SplitStatus::Pending, "modify")
            .await?;

        ParticipantEntity::delete_many()
            .filter(ParticipantColumn::SplitId.eq(split_id))
            .filter(ParticipantColumn::UserId.eq(user_id))
            .exec(db)
            .await?;

        let mut split_active: SplitActiveModel = split.into();
        split_active.updated_at = Set(chrono::Utc::now().into());
        let split = split_active.update(db).await?;
        self.to_detail(db, split).await
    }

    /// Completes a pending split: computes the net value and atomically generates one Guild Bank
    /// transaction per participant.
    ///
    /// # Errors
    ///
    /// * Returns `AppError::Validation` if the split is not pending, has no participants, or the
    ///   net value is not positive.
    /// * Returns `AppError::Database` if the transaction fails.
    /// Completes several splits in one action.
    ///
    /// Each split is completed independently and failures are collected rather
    /// than aborting: settling a night's splits should not lose the ones that
    /// worked because a later one was already paid out or had no participants.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Validation` if no split ids were supplied.
    pub async fn complete_splits_batch(
        &self,
        db: &DatabaseConnection,
        split_ids: &[i64],
        officer_user_id: i64,
    ) -> Result<CompleteSplitsBatchResult, AppError> {
        if split_ids.is_empty() {
            return Err(AppError::Validation(
                "must provide at least one split id".to_string(),
            ));
        }

        let mut completed = Vec::new();
        let mut failed = Vec::new();
        let mut total_distributed = Decimal::ZERO;

        for split_id in split_ids {
            match self.complete_split(db, *split_id, officer_user_id).await {
                Ok(detail) => {
                    total_distributed += detail.summary.net_value.unwrap_or(Decimal::ZERO);
                    completed.push(*split_id);
                }
                Err(err) => failed.push(BatchFailure {
                    split_id: *split_id,
                    reason: err.to_string(),
                }),
            }
        }

        Ok(CompleteSplitsBatchResult {
            completed,
            failed,
            total_distributed,
        })
    }

    pub async fn complete_split(
        &self,
        db: &DatabaseConnection,
        split_id: i64,
        officer_user_id: i64,
    ) -> Result<SplitDetail, AppError> {
        let split = self
            .load_with_status(db, split_id, SplitStatus::Pending, "complete")
            .await?;

        let participants = ParticipantEntity::find()
            .filter(ParticipantColumn::SplitId.eq(split_id))
            .all(db)
            .await?;

        if participants.is_empty() {
            return Err(AppError::Validation(
                "cannot complete a split with no participants".to_string(),
            ));
        }

        let net_value = split.estimated_market_value - split.repair_value + split.bags_value;
        if net_value <= Decimal::ZERO {
            return Err(AppError::Validation(
                "split net value must be positive to complete".to_string(),
            ));
        }

        let total_weight: i64 = participants.iter().map(|p| i64::from(p.weight)).sum();

        let txn = db.begin().await?;

        let mut running_total = Decimal::ZERO;
        let last_index = participants.len() - 1;
        for (i, participant) in participants.iter().enumerate() {
            let share = if i == last_index {
                net_value - running_total
            } else {
                let s = (net_value * Decimal::from(participant.weight)
                    / Decimal::from(total_weight))
                .round_dp(2);
                running_total += s;
                s
            };

            let active = TransactionActiveModel {
                from_user_id: Set(None),
                to_user_id: Set(participant.user_id),
                amount: Set(share),
                status: Set(TransactionStatus::Pending.to_string()),
                r#type: Set(TYPE_SPLIT_CREDIT.to_string()),
                split_id: Set(Some(split_id)),
                ..Default::default()
            };
            let inserted_tx = active.insert(&txn).await?;
            let _ = crate::modules::audit::service::AuditService::log(
                db,
                "TRANSACTION_CREATED",
                Some("TRANSACTION"),
                Some(inserted_tx.id),
                Some(officer_user_id),
                Some(serde_json::json!({
                    "split_id": split_id,
                    "amount": share,
                    "type": TYPE_SPLIT_CREDIT,
                    "target_user_id": participant.user_id
                })),
            )
            .await;
        }

        let mut split_active: SplitActiveModel = split.into();
        split_active.updated_at = Set(chrono::Utc::now().into());
        split_active.status = Set(SplitStatus::Completed.to_string());
        split_active.net_value = Set(Some(net_value));
        split_active.finalized_at = Set(Some(chrono::Utc::now().into()));
        let updated_split = split_active.update(&txn).await?;

        txn.commit().await?;

        let recipients: Vec<i64> = participants
            .iter()
            .map(|participant| participant.user_id)
            .filter(|user_id| *user_id != officer_user_id)
            .collect();
        if !recipients.is_empty() {
            crate::modules::notifications::notify_best_effort(
                db,
                crate::modules::notifications::NotifySpec {
                    kind: crate::modules::notifications::NotificationKind::SplitCredited,
                    user_ids: &recipients,
                    title: "Loot split credited".into(),
                    body: format!(
                        "Your share from split #{split_id} was credited to the guild bank."
                    ),
                    link_path: Some(format!("/splits/{split_id}")),
                    source_type: "split",
                    source_id: split_id,
                    created_by_user_id: Some(officer_user_id),
                },
            )
            .await;
        }

        self.to_detail(db, updated_split).await
    }

    /// Matches a list of raw candidate names (e.g. OCR'd from a screenshot) against known,
    /// already-linked Albion Online players, resolving each match to a `users.id`.
    ///
    /// Matching is case-insensitive against each user's linked Albion Online character name
    /// (`albion_links.albion_player_name`). Only names that resolve all the way to an existing
    /// `users` row are returned — unmatched names, or names linked to a Discord account that
    /// has never logged into this app (so has no `discord_id` on its `users` row), are silently
    /// dropped rather than surfaced as an error. Results are deduplicated by `user_id`.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the underlying queries fail.
    pub async fn match_participants(
        &self,
        db: &DatabaseConnection,
        names: &[String],
    ) -> Result<Vec<MatchedParticipant>, AppError> {
        if names.is_empty() {
            return Ok(vec![]);
        }

        let links = AlbionLinkEntity::find().all(db).await?;

        let mut seen = HashSet::new();
        let mut out = Vec::new();

        for name in names {
            let needle = name.trim().to_lowercase();
            if needle.is_empty() {
                continue;
            }

            let Some(link) = links
                .iter()
                .find(|l| l.albion_player_name.to_lowercase() == needle)
            else {
                continue;
            };

            let user = UserEntity::find()
                .filter(UserColumn::DiscordId.eq(&link.discord_id))
                .one(db)
                .await?;

            if let Some(user) = user
                && seen.insert(user.id)
            {
                out.push(MatchedParticipant {
                    user_id: user.id,
                    username: user.username,
                    matched_name: link.albion_player_name.clone(),
                });
            }
        }

        Ok(out)
    }
}

impl Default for SplitService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::users::entities::ActiveModel as UserActiveModel;
    use sea_orm::Database;

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

    async fn insert_user_with_discord_id(
        db: &DatabaseConnection,
        username: &str,
        email: &str,
        discord_id: &str,
    ) -> i64 {
        let user = UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            discord_id: Set(Some(discord_id.to_string())),
            ..Default::default()
        };
        user.insert(db).await.expect("Failed to insert user").id
    }

    async fn insert_albion_link(
        db: &DatabaseConnection,
        discord_id: &str,
        player_id: &str,
        player_name: &str,
    ) {
        use crate::modules::albion::entities::albion_link::ActiveModel as AlbionLinkActiveModel;

        let link = AlbionLinkActiveModel {
            discord_id: Set(discord_id.to_string()),
            albion_player_id: Set(player_id.to_string()),
            albion_player_name: Set(player_name.to_string()),
            linked_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        };
        link.insert(db).await.expect("Failed to insert albion link");
    }

    fn request(
        market: &str,
        repair: &str,
        bags: &str,
        participants: Vec<UpsertParticipantRequest>,
    ) -> CreateSplitRequest {
        CreateSplitRequest {
            estimated_market_value: market.parse().unwrap(),
            repair_value: repair.parse().unwrap(),
            bags_value: bags.parse().unwrap(),
            note: None,
            event_id: None,
            island_tab_id: 0,
            participants,
        }
    }

    fn located(mut req: CreateSplitRequest, island_tab_id: i64) -> CreateSplitRequest {
        req.island_tab_id = island_tab_id;
        req
    }

    async fn seed_tab(db: &DatabaseConnection) -> i64 {
        let island = SplitService::new()
            .create_island(
                db,
                CreateIslandRequest {
                    name: "x".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec!["Loot".to_string()],
                },
            )
            .await
            .expect("island");
        island.tabs[0].id
    }

    #[tokio::test]
    async fn test_create_split_requires_at_least_one_participant() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;

        let service = SplitService::new();
        let result = service
            .create_split(&db, admin, request("50.00", "0.00", "0.00", vec![]))
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_split_rejects_duplicate_participants() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;

        let service = SplitService::new();
        let result = service
            .create_split(
                &db,
                admin,
                request(
                    "50.00",
                    "0.00",
                    "0.00",
                    vec![
                        UpsertParticipantRequest {
                            user_id: alice,
                            weight: 1,
                        },
                        UpsertParticipantRequest {
                            user_id: alice,
                            weight: 2,
                        },
                    ],
                ),
            )
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_create_split_starts_pending_with_participants() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let tab_id = seed_tab(&db).await;

        let service = SplitService::new();
        let split = service
            .create_split(
                &db,
                admin,
                located(
                    request(
                        "50.00",
                        "0.00",
                        "0.00",
                        vec![UpsertParticipantRequest {
                            user_id: alice,
                            weight: 1,
                        }],
                    ),
                    tab_id,
                ),
            )
            .await
            .unwrap();

        assert_eq!(split.summary.status, SplitStatus::Pending);
        assert_eq!(split.participants.len(), 1);
    }

    #[tokio::test]
    async fn test_complete_split_distributes_exact_net_value_with_rounding() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let bob = insert_user(&db, "bob", "bob@example.com").await;
        let carol = insert_user(&db, "carol", "carol@example.com").await;
        let tab_id = seed_tab(&db).await;

        let service = SplitService::new();
        let split = service
            .create_split(
                &db,
                admin,
                located(
                    request(
                        "100.00",
                        "0.00",
                        "0.00",
                        vec![alice, bob, carol]
                            .into_iter()
                            .map(|user_id| UpsertParticipantRequest { user_id, weight: 1 })
                            .collect(),
                    ),
                    tab_id,
                ),
            )
            .await
            .unwrap();

        let completed = service
            .complete_split(&db, split.summary.id, admin)
            .await
            .unwrap();
        assert_eq!(completed.summary.status, SplitStatus::Completed);

        let total: Decimal = completed
            .participants
            .iter()
            .map(|p| p.share_amount.unwrap())
            .sum();
        assert_eq!(total, "100.00".parse::<Decimal>().unwrap());
    }

    #[tokio::test]
    async fn test_complete_split_twice_fails() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let tab_id = seed_tab(&db).await;

        let service = SplitService::new();
        let split = service
            .create_split(
                &db,
                admin,
                located(
                    request(
                        "50.00",
                        "0.00",
                        "0.00",
                        vec![UpsertParticipantRequest {
                            user_id: alice,
                            weight: 1,
                        }],
                    ),
                    tab_id,
                ),
            )
            .await
            .unwrap();

        service
            .complete_split(&db, split.summary.id, admin)
            .await
            .unwrap();
        let second = service.complete_split(&db, split.summary.id, admin).await;
        assert!(second.is_err());
    }

    #[tokio::test]
    async fn test_mark_not_completed_is_terminal() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let tab_id = seed_tab(&db).await;

        let service = SplitService::new();
        let split = service
            .create_split(
                &db,
                admin,
                located(
                    request(
                        "50.00",
                        "0.00",
                        "0.00",
                        vec![UpsertParticipantRequest {
                            user_id: alice,
                            weight: 1,
                        }],
                    ),
                    tab_id,
                ),
            )
            .await
            .unwrap();

        let closed = service
            .mark_not_completed(&db, split.summary.id)
            .await
            .unwrap();
        assert_eq!(closed.summary.status, SplitStatus::NotCompleted);

        let complete_result = service.complete_split(&db, split.summary.id, admin).await;
        assert!(complete_result.is_err());
    }

    #[tokio::test]
    async fn test_mark_lost_is_terminal() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let tab_id = seed_tab(&db).await;

        let service = SplitService::new();
        let split = service
            .create_split(
                &db,
                admin,
                located(
                    request(
                        "50.00",
                        "0.00",
                        "0.00",
                        vec![UpsertParticipantRequest {
                            user_id: alice,
                            weight: 1,
                        }],
                    ),
                    tab_id,
                ),
            )
            .await
            .unwrap();

        let closed = service.mark_lost(&db, split.summary.id).await.unwrap();
        assert_eq!(closed.summary.status, SplitStatus::Lost);

        let complete_result = service.complete_split(&db, split.summary.id, admin).await;
        assert!(complete_result.is_err());
    }

    #[tokio::test]
    async fn test_match_participants_matches_linked_case_insensitively() {
        let db = seed_db().await;
        let alice_id = insert_user_with_discord_id(&db, "alice", "alice@example.com", "111").await;
        insert_albion_link(&db, "111", "player-1", "AliceInAlbion").await;

        let service = SplitService::new();
        let matched = service
            .match_participants(
                &db,
                &["aliceinalbion".to_string(), "NoSuchPlayer".to_string()],
            )
            .await
            .unwrap();

        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].user_id, alice_id);
        assert_eq!(matched[0].matched_name, "AliceInAlbion");
    }

    #[tokio::test]
    async fn test_match_participants_skips_links_with_no_matching_user() {
        let db = seed_db().await;
        insert_albion_link(&db, "222", "player-2", "GhostPlayer").await;

        let service = SplitService::new();
        let matched = service
            .match_participants(&db, &["GhostPlayer".to_string()])
            .await
            .unwrap();

        assert!(matched.is_empty());
    }

    #[tokio::test]
    async fn test_match_participants_dedupes_by_user_id() {
        let db = seed_db().await;
        let bob_id = insert_user_with_discord_id(&db, "bob", "bob@example.com", "333").await;
        insert_albion_link(&db, "333", "player-3", "Bobby").await;

        let service = SplitService::new();
        let matched = service
            .match_participants(&db, &["Bobby".to_string(), "bobby".to_string()])
            .await
            .unwrap();

        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].user_id, bob_id);
    }

    #[tokio::test]
    async fn create_island_with_tabs_returns_nested_view() {
        let db = seed_db().await;
        let service = SplitService::new();
        let island = service
            .create_island(
                &db,
                CreateIslandRequest {
                    name: "x".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec!["Loot".to_string(), "Silver".to_string()],
                },
            )
            .await
            .unwrap();

        assert_eq!(island.name, "x");
        assert_eq!(island.city, SplitIslandCity::Lymhurst);
        assert_eq!(island.tabs.len(), 2);
        assert_eq!(island.tabs[0].name, "Loot");
        assert_eq!(island.tabs[1].name, "Silver");

        let listed = service.list_islands(&db).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].tabs.len(), 2);
    }

    #[tokio::test]
    async fn create_island_rejects_unknown_city() {
        let db = seed_db().await;
        let err = SplitService::new()
            .create_island(
                &db,
                CreateIslandRequest {
                    name: "x".to_string(),
                    city: "narnia".to_string(),
                    tabs: vec!["Loot".to_string()],
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn create_island_requires_at_least_one_tab() {
        let db = seed_db().await;
        let err = SplitService::new()
            .create_island(
                &db,
                CreateIslandRequest {
                    name: "x".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec![],
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn create_island_rejects_duplicate_name_in_same_city() {
        let db = seed_db().await;
        let service = SplitService::new();
        let req = CreateIslandRequest {
            name: "x".to_string(),
            city: "lymhurst".to_string(),
            tabs: vec!["Loot".to_string()],
        };
        service.create_island(&db, req.clone()).await.unwrap();
        let err = service.create_island(&db, req).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn add_tab_rejects_duplicate_name_on_island() {
        let db = seed_db().await;
        let service = SplitService::new();
        let island = service
            .create_island(
                &db,
                CreateIslandRequest {
                    name: "x".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec!["Loot".to_string()],
                },
            )
            .await
            .unwrap();
        let err = service
            .add_island_tab(
                &db,
                island.id,
                CreateIslandTabRequest {
                    name: "loot".to_string(),
                    sort_order: None,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn delete_last_tab_is_rejected() {
        let db = seed_db().await;
        let service = SplitService::new();
        let island = service
            .create_island(
                &db,
                CreateIslandRequest {
                    name: "x".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec!["Loot".to_string()],
                },
            )
            .await
            .unwrap();
        let err = service
            .delete_island_tab(&db, island.id, island.tabs[0].id)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn create_split_rejects_unknown_tab() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let err = SplitService::new()
            .create_split(
                &db,
                admin,
                located(
                    request(
                        "50.00",
                        "0.00",
                        "0.00",
                        vec![UpsertParticipantRequest {
                            user_id: alice,
                            weight: 1,
                        }],
                    ),
                    999,
                ),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn create_split_summary_includes_island_and_tab_labels() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let tab_id = seed_tab(&db).await;
        let split = SplitService::new()
            .create_split(
                &db,
                admin,
                located(
                    request(
                        "50.00",
                        "0.00",
                        "0.00",
                        vec![UpsertParticipantRequest {
                            user_id: alice,
                            weight: 1,
                        }],
                    ),
                    tab_id,
                ),
            )
            .await
            .unwrap();
        assert_eq!(split.summary.island_tab_id, Some(tab_id));
        assert_eq!(split.summary.island_name.as_deref(), Some("x"));
        assert_eq!(split.summary.island_city.as_deref(), Some("lymhurst"));
        assert_eq!(split.summary.island_tab_name.as_deref(), Some("Loot"));
    }

    #[tokio::test]
    async fn list_splits_filters_by_island_id() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let service = SplitService::new();
        let first = service
            .create_island(
                &db,
                CreateIslandRequest {
                    name: "alpha".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec!["Loot".to_string()],
                },
            )
            .await
            .unwrap();
        let second = service
            .create_island(
                &db,
                CreateIslandRequest {
                    name: "beta".to_string(),
                    city: "bridgewatch".to_string(),
                    tabs: vec!["Loot".to_string()],
                },
            )
            .await
            .unwrap();
        let participant = vec![UpsertParticipantRequest {
            user_id: alice,
            weight: 1,
        }];
        service
            .create_split(
                &db,
                admin,
                located(
                    request("10.00", "0.00", "0.00", participant.clone()),
                    first.tabs[0].id,
                ),
            )
            .await
            .unwrap();
        service
            .create_split(
                &db,
                admin,
                located(
                    request("20.00", "0.00", "0.00", participant),
                    second.tabs[0].id,
                ),
            )
            .await
            .unwrap();

        let listed = service
            .list_splits(
                &db,
                &PaginationParams {
                    page: None,
                    limit: Some(10),
                },
                &SplitFilters {
                    status: None,
                    event_id: None,
                    island_id: Some(first.id),
                    search: None,
                    date_from: None,
                    date_to: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(listed.items.len(), 1);
        assert_eq!(listed.items[0].island_id, Some(first.id));
    }

    #[tokio::test]
    async fn kpi_summary_counts_all_splits_not_the_current_page() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let service = SplitService::new();
        let island = service
            .create_island(
                &db,
                CreateIslandRequest {
                    name: "kpi".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec!["Loot".to_string()],
                },
            )
            .await
            .unwrap();
        let participant = vec![UpsertParticipantRequest {
            user_id: alice,
            weight: 1,
        }];
        service
            .create_split(
                &db,
                admin,
                located(
                    request("10.00", "0.00", "0.00", participant.clone()),
                    island.tabs[0].id,
                ),
            )
            .await
            .unwrap();
        let completed = service
            .create_split(
                &db,
                admin,
                located(
                    request("20.00", "1.00", "2.00", participant),
                    island.tabs[0].id,
                ),
            )
            .await
            .unwrap();
        SplitActiveModel {
            id: Set(completed.summary.id),
            status: Set(SplitStatus::Completed.to_string()),
            net_value: Set(Some("21.00".parse().unwrap())),
            ..Default::default()
        }
        .update(&db)
        .await
        .unwrap();

        let kpi = service.kpi_summary(&db).await.unwrap();
        assert_eq!(kpi.pending_count, 1);
        assert_eq!(kpi.completed_count, 1);
        assert_eq!(kpi.total_participants, 2);
        assert_eq!(kpi.total_net_distributed, "21.00".parse().unwrap());
        assert_eq!(kpi.total_estimated_volume, "30.00".parse().unwrap());
    }

    #[tokio::test]
    async fn legacy_split_without_location_still_lists() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        SplitActiveModel {
            created_by: Set(admin),
            status: Set(SplitStatus::Pending.to_string()),
            estimated_market_value: Set("10".parse().unwrap()),
            repair_value: Set(Decimal::ZERO),
            bags_value: Set(Decimal::ZERO),
            note: Set(Some("legacy".to_string())),
            event_id: Set(None),
            island_tab_id: Set(None),
            ..Default::default()
        }
        .insert(&db)
        .await
        .unwrap();

        let listed = SplitService::new()
            .list_splits(
                &db,
                &PaginationParams {
                    page: None,
                    limit: Some(10),
                },
                &SplitFilters {
                    status: None,
                    event_id: None,
                    island_id: None,
                    search: None,
                    date_from: None,
                    date_to: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(listed.items.len(), 1);
        assert_eq!(listed.items[0].island_tab_id, None);
    }

    #[test]
    fn list_splits_rejects_unknown_sort_column() {
        let error = resolve_split_list_sort(Some("fame"), None).unwrap_err();
        match error {
            AppError::Validation(message) => assert!(message.contains("fame")),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[test]
    fn list_splits_default_sort_is_created_at_desc() {
        let (column, order) = resolve_split_list_sort(None, None).unwrap();
        assert!(matches!(column, SplitColumn::CreatedAt));
        assert_eq!(order, SortOrder::Desc);
        let (column, order) = resolve_split_list_sort(Some("NOTE"), Some("asc")).unwrap();
        assert!(matches!(column, SplitColumn::Note));
        assert_eq!(order, SortOrder::Asc);
    }

    #[tokio::test]
    async fn list_splits_sorts_by_note() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let tab_id = seed_tab(&db).await;
        let service = SplitService::new();
        let participant = vec![UpsertParticipantRequest {
            user_id: alice,
            weight: 1,
        }];
        let mut zebra = located(
            request("10.00", "0.00", "0.00", participant.clone()),
            tab_id,
        );
        zebra.note = Some("Zebra".to_string());
        service.create_split(&db, admin, zebra).await.unwrap();
        let mut alpha = located(request("20.00", "0.00", "0.00", participant), tab_id);
        alpha.note = Some("Alpha".to_string());
        service.create_split(&db, admin, alpha).await.unwrap();

        let listed = service
            .list_splits_sorted(
                &db,
                &PaginationParams {
                    page: None,
                    limit: Some(10),
                },
                &SplitFilters::default(),
                Some("note"),
                Some("asc"),
            )
            .await
            .unwrap();
        let notes: Vec<_> = listed
            .items
            .iter()
            .map(|split| split.note.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(notes, vec!["Alpha", "Zebra"]);
    }

    #[tokio::test]
    async fn list_splits_sorted_rejects_unknown_column() {
        let db = seed_db().await;
        let error = SplitService::new()
            .list_splits_sorted(
                &db,
                &PaginationParams {
                    page: None,
                    limit: Some(10),
                },
                &SplitFilters::default(),
                Some("fame"),
                None,
            )
            .await
            .unwrap_err();
        match error {
            AppError::Validation(message) => assert!(message.contains("fame")),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn update_pending_split_relocates_tab() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let service = SplitService::new();
        let island = service
            .create_island(
                &db,
                CreateIslandRequest {
                    name: "x".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec!["Loot".to_string(), "Silver".to_string()],
                },
            )
            .await
            .unwrap();
        let split = service
            .create_split(
                &db,
                admin,
                located(
                    request(
                        "50.00",
                        "0.00",
                        "0.00",
                        vec![UpsertParticipantRequest {
                            user_id: alice,
                            weight: 1,
                        }],
                    ),
                    island.tabs[0].id,
                ),
            )
            .await
            .unwrap();
        let updated = service
            .update_split(
                &db,
                split.summary.id,
                UpdateSplitRequest {
                    estimated_market_value: None,
                    repair_value: None,
                    bags_value: None,
                    note: None,
                    event_id: None,
                    island_tab_id: Some(island.tabs[1].id),
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.summary.island_tab_id, Some(island.tabs[1].id));
        assert_eq!(updated.summary.island_tab_name.as_deref(), Some("Silver"));
    }

    #[tokio::test]
    async fn update_completed_split_rejects_relocation() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let service = SplitService::new();
        let island = service
            .create_island(
                &db,
                CreateIslandRequest {
                    name: "x".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec!["Loot".to_string(), "Silver".to_string()],
                },
            )
            .await
            .unwrap();
        let split = service
            .create_split(
                &db,
                admin,
                located(
                    request(
                        "50.00",
                        "0.00",
                        "0.00",
                        vec![UpsertParticipantRequest {
                            user_id: alice,
                            weight: 1,
                        }],
                    ),
                    island.tabs[0].id,
                ),
            )
            .await
            .unwrap();
        service
            .complete_split(&db, split.summary.id, admin)
            .await
            .unwrap();
        let err = service
            .update_split(
                &db,
                split.summary.id,
                UpdateSplitRequest {
                    estimated_market_value: None,
                    repair_value: None,
                    bags_value: None,
                    note: None,
                    event_id: None,
                    island_tab_id: Some(island.tabs[1].id),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn delete_tab_used_by_split_is_rejected() {
        let db = seed_db().await;
        let admin = insert_user(&db, "admin", "admin@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let service = SplitService::new();
        let island = service
            .create_island(
                &db,
                CreateIslandRequest {
                    name: "x".to_string(),
                    city: "lymhurst".to_string(),
                    tabs: vec!["Loot".to_string(), "Silver".to_string()],
                },
            )
            .await
            .unwrap();
        service
            .create_split(
                &db,
                admin,
                located(
                    request(
                        "50.00",
                        "0.00",
                        "0.00",
                        vec![UpsertParticipantRequest {
                            user_id: alice,
                            weight: 1,
                        }],
                    ),
                    island.tabs[0].id,
                ),
            )
            .await
            .unwrap();
        let err = service
            .delete_island_tab(&db, island.id, island.tabs[0].id)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
