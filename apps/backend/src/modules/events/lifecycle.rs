//! Owner-authorized lifecycle synchronization for linked event copies.
//!
//! Event content and lifecycle state (update, cancel/uncancel, archive) flow
//! from the source event to every active copy. Alliance-owned events use the
//! durable fanout outbox so a failed target stays visible and retryable;
//! guild-origin events with an alliance mirror converge inline, and a failure
//! is returned to the caller so repeating the request retries the copy.
//! No cross-tenant write is atomic: each destination converges independently
//! to the current source state, which makes every retry idempotent.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction,
    DbBackend, EntityTrait, QueryFilter, QuerySelect, Set, Statement, TransactionTrait,
    sea_query::Expr,
};
use serde::Serialize;
use serde_json::json;
use utoipa::ToSchema;

use crate::{
    discord_delivery::{
        kinds::{Cause as OutboxCause, EffectKind},
        outbox::{self, Effect, EmitOutcome},
    },
    errors::AppError,
    modules::splits::{
        entities::split,
        service::{SplitService, SplitSyncState},
    },
    tenant::TenantRegistry,
};

use super::{
    entities::event,
    fanout_outbox,
    models::EventView,
    service::{EventService, MAX_SESSION_DURATION, reject_if_event_archived},
    sync::{canonical_event_origin, linked_event_peers},
};

// --- Transition core -------------------------------------------------------

/// Which participants receive completion XP when a session stops.
///
/// Replaces the legacy `award_xp: bool`: `true` maps to [`XpFilter::Everyone`] and `false`
/// (alliance mirrors, where only the originating guild is authoritative for progression) to
/// [`XpFilter::OwnMembersOnly`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XpFilter {
    /// Snapshot the creator and every participant of the event.
    Everyone,
    /// Snapshot only members that belong to this tenant by attribution. Participant
    /// attribution does not exist yet, so a copy has no such members and nothing is
    /// snapshotted, which is exactly the legacy `award_xp = false` behavior.
    OwnMembersOnly,
}

impl XpFilter {
    /// Maps the legacy `award_xp` flag onto a filter.
    #[must_use]
    pub const fn from_award_xp(award_xp: bool) -> Self {
        if award_xp {
            Self::Everyone
        } else {
            Self::OwnMembersOnly
        }
    }
}

/// An event status change handled by [`transition_in_txn`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    /// `scheduled -> live`.
    Start,
    /// `live -> stopped | auto_stopped`, snapshotting completion XP per `xp`.
    Stop {
        /// `true` selects `auto_stopped` (the scheduler hit the session deadline).
        auto: bool,
        /// Which participants are snapshotted for completion XP.
        xp: XpFilter,
    },
    /// `scheduled | live -> cancelled`.
    Cancel,
    /// `cancelled -> scheduled`.
    Uncancel,
    /// Sets `archived_at` on the event and its linked splits.
    Archive,
    /// Clears `archived_at` on the event and its linked splits.
    Unarchive,
}

/// What triggered a transition. Only labels the outcome (and, later, effect rows); it never
/// changes which rows are written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    /// An authenticated web/API request.
    Web,
    /// A Discord interaction forwarded by the bot.
    Discord,
    /// The background scheduler (auto-stop).
    Scheduler,
    /// The sync engine applying an origin change to a copy.
    Sync {
        /// True for backfills (membership backfill, reconcile re-create, legacy import).
        backfill: bool,
    },
    /// A settings change.
    Settings,
    /// A reconcile pass.
    Reconcile,
    /// A data import.
    Import,
    /// Direct service use (tests, tooling) without a request context.
    Manual,
}

/// Reference to an effect row written by a transition or a reminder (DO §5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct EffectRef {
    /// Outbox row id.
    pub id: i64,
    /// Effect kind (`discord_delivery::kinds`), in its stored string form.
    pub kind: String,
}

/// Background loops a committed transition should kick. Empty until the runtime module
/// (F3) and the queues it wakes exist.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WakeSet {
    /// The sync relay has a new outbox row to pick up.
    pub sync_relay: bool,
    /// The Discord delivery loop has a new effect to pick up.
    pub discord_outbox: bool,
}

impl WakeSet {
    /// True when no loop needs to be woken.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        !self.sync_relay && !self.discord_outbox
    }
}

/// Result of [`transition_in_txn`]; valid only once the caller commits the transaction.
#[derive(Debug, Clone)]
pub struct TransitionOutcome {
    /// The event row as written by the transition (or as found, for a no-op).
    pub model: event::Model,
    /// The transition that was applied.
    pub transition: Transition,
    /// What triggered it.
    pub cause: Cause,
    /// False when the event already was in the target state and its row was left untouched.
    pub changed: bool,
    /// State of the local-split roster sync; `None` for transitions that do not run it.
    pub splits: Option<SplitSyncState>,
    /// Effects written in the transaction (none yet).
    pub effects: Vec<EffectRef>,
    /// Sync outbox row written in the transaction (none yet).
    pub sync_outbox_id: Option<i64>,
    /// Loops to wake after commit (none yet).
    pub wake: WakeSet,
}

/// An outcome together with the hydrated view, returned by [`EventService::transition`].
#[derive(Debug, Clone)]
pub struct Transitioned {
    /// The committed outcome.
    pub outcome: TransitionOutcome,
    /// The event as the API renders it, hydrated after commit.
    pub view: EventView,
}

/// Everything [`TransitionOutcome::after_commit`] may need once the transaction committed.
///
/// Today that is only the legacy cross-tenant propagation; the runtime wake handle joins it
/// when the runtime module exists. `AfterCommit::default()` does nothing.
#[derive(Default)]
pub struct AfterCommit<'a> {
    legacy: Option<LegacyPropagation<'a>>,
}

struct LegacyPropagation<'a> {
    control: &'a DatabaseConnection,
    registry: &'a TenantRegistry,
    tenant_id: &'a str,
}

impl<'a> AfterCommit<'a> {
    /// Propagates the committed change to the event's copies through the legacy fanout or
    /// inline converge path, as the routes did before the core existed.
    #[must_use]
    pub fn legacy_propagation(
        control: &'a DatabaseConnection,
        registry: &'a TenantRegistry,
        tenant_id: &'a str,
    ) -> Self {
        Self {
            legacy: Some(LegacyPropagation {
                control,
                registry,
                tenant_id,
            }),
        }
    }
}

impl TransitionOutcome {
    /// Post-commit work: legacy propagation to copies (a failure is returned so repeating the
    /// request retries the copy; the transition itself stays committed).
    ///
    /// Runs even for a no-op so a repeated request still retries a copy that failed earlier.
    pub async fn after_commit(&self, ctx: &AfterCommit<'_>) -> Result<(), AppError> {
        if let Some(legacy) = &ctx.legacy {
            propagate_source_change(
                legacy.control,
                legacy.registry,
                legacy.tenant_id,
                &self.model,
            )
            .await?;
        }
        Ok(())
    }
}

/// Propagates a committed source-event change to its copies.
///
/// A cancelled or archived source archives its copies; anything else updates them.
pub(super) async fn propagate_source_change(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    tenant_id: &str,
    model: &event::Model,
) -> Result<(), AppError> {
    let operation = if model.archived_at.is_some() || model.status == "cancelled" {
        fanout_outbox::Operation::Archive
    } else {
        fanout_outbox::Operation::Update
    };
    sync_owner_change_to_copies(control, registry, tenant_id, model, operation).await
}

/// The single place that changes an event's status.
///
/// Locks the event row, validates the transition against its current state, writes the new
/// state, and runs the transition's in-transaction side effects (completion-XP snapshot and
/// local-split roster sync for a stop; linked-split archiving for archive/unarchive). The
/// caller owns the transaction: commit it, then call [`TransitionOutcome::after_commit`].
///
/// Idempotent exactly like the legacy functions: stopping a stopped event and cancelling a
/// cancelled one write nothing (`changed == false`); starting a live event is a conflict.
/// The split roster sync of a stop runs in a SAVEPOINT, so its failure never fails the stop.
///
/// `actor` is the Discord id of the requester when there is one; it is not stored yet.
///
/// # Errors
///
/// [`AppError::NotFound`] for an unknown event, [`AppError::Conflict`] when the current state
/// does not allow the transition or the event is archived, [`AppError::Database`] otherwise.
pub async fn transition_in_txn(
    txn: &DatabaseTransaction,
    event_id: i64,
    transition: Transition,
    cause: Cause,
    actor: Option<&str>,
) -> Result<TransitionOutcome, AppError> {
    let _ = actor;
    let model = event::Entity::find_by_id(event_id)
        .lock_exclusive()
        .one(txn)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;

    let mut splits = None;
    let (model, changed) = match transition {
        Transition::Start => (apply_start(txn, model).await?, true),
        Transition::Stop { auto, xp } => {
            reject_if_event_archived(&model)?;
            if model.status == "stopped" || model.status == "auto_stopped" {
                // Idempotent: no row change. A stop whose split sync failed earlier is the
                // natural moment to retry it.
                let split_service = SplitService::new();
                if split_service.event_has_stale_splits(txn, event_id).await? {
                    splits = Some(
                        split_service
                            .sync_event_participants_isolated(txn, event_id)
                            .await?,
                    );
                }
                (model, false)
            } else {
                let updated = apply_stop(txn, model, auto).await?;
                splits = Some(finish_session_in_txn(txn, &updated, xp).await?);
                (updated, true)
            }
        }
        Transition::Cancel => {
            reject_if_event_archived(&model)?;
            if model.status == "cancelled" {
                (model, false)
            } else {
                let updated = apply_cancel(txn, model).await?;
                // A cancelled event releases its awaiting splits to pending, in this transaction.
                SplitService::new()
                    .recompute_awaiting_for_event(txn, event_id)
                    .await?;
                (updated, true)
            }
        }
        Transition::Uncancel => {
            let updated = apply_uncancel(txn, model).await?;
            SplitService::new()
                .recompute_awaiting_for_event(txn, event_id)
                .await?;
            (updated, true)
        }
        Transition::Archive => (apply_archive(txn, model).await?, true),
        Transition::Unarchive => (apply_unarchive(txn, model).await?, true),
    };

    // Effects only for a row that changed: a repeated stop or cancel writes nothing new.
    let effects = if changed {
        emit_transition_effects(txn, transition, &model, cause).await?
    } else {
        Vec::new()
    };
    let wake = WakeSet {
        discord_outbox: !effects.is_empty(),
        ..WakeSet::default()
    };

    Ok(TransitionOutcome {
        model,
        transition,
        cause,
        changed,
        splits,
        effects,
        sync_outbox_id: None,
        wake,
    })
}

/// Grace period after a session stops before its voice channel is released (DO §4).
const VOICE_RELEASE_HOURS: i64 = 6;

/// Debounce of `calendar.sync` (DO catalogue): a burst of transitions rebuilds the calendar once.
const CALENDAR_DEBOUNCE_SECS: i64 = 5;

/// Maps the lifecycle cause onto the outbox label. The label is stored, never branched on,
/// except by the manual reminder key (which callers pass explicitly).
const fn outbox_cause(cause: Cause) -> OutboxCause {
    match cause {
        Cause::Web => OutboxCause::Web,
        Cause::Discord => OutboxCause::Discord,
        Cause::Scheduler => OutboxCause::Scheduler,
        Cause::Sync { .. } => OutboxCause::Sync,
        Cause::Settings => OutboxCause::Settings,
        Cause::Reconcile => OutboxCause::Reconcile,
        Cause::Import => OutboxCause::Import,
        Cause::Manual => OutboxCause::Manual,
    }
}

/// Writes one effect and records its row id. An already-done once key writes nothing.
async fn record_effect(
    txn: &impl ConnectionTrait,
    now: DateTime<Utc>,
    cause: OutboxCause,
    effect: Effect,
    written: &mut Vec<EffectRef>,
) -> Result<(), AppError> {
    let kind = effect.kind;
    match outbox::emit(txn, now, cause, None, effect).await? {
        EmitOutcome::Inserted(id) | EmitOutcome::Coalesced(id) => written.push(EffectRef {
            id,
            kind: kind.as_str().to_owned(),
        }),
        EmitOutcome::AlreadyDone => {}
    }
    Ok(())
}

/// Writes the Discord effects of a transition that changed the row, inside its transaction.
async fn emit_transition_effects(
    txn: &DatabaseTransaction,
    transition: Transition,
    event: &event::Model,
    cause: Cause,
) -> Result<Vec<EffectRef>, AppError> {
    let now = Utc::now();
    let mut written = Vec::new();
    for effect in transition_effects(transition, event, now) {
        record_effect(txn, now, outbox_cause(cause), effect, &mut written).await?;
    }
    Ok(written)
}

/// The effects of a transition in DO §5.2 order. Depends on the transition and the stored
/// row only, never on the cause, so every cause yields the same `(kind, payload)` list.
fn transition_effects(
    transition: Transition,
    event: &event::Model,
    now: DateTime<Utc>,
) -> Vec<Effect> {
    let id = event.id;
    let stopped_at = event.stopped_at.map_or(now, |at| at.with_timezone(&Utc));
    let voice_release = || {
        let mut effect = Effect::new(EffectKind::VoiceRelease, id);
        effect.expires_at = Some(stopped_at + ChronoDuration::hours(VOICE_RELEASE_HOURS));
        effect
    };
    let close = |reason: &str| {
        let mut effect = Effect::new(EffectKind::EventClose, id);
        effect.payload = json!({ "reason": reason });
        effect
    };
    let calendar = || {
        let mut effect = Effect::new(EffectKind::CalendarSync, 0);
        effect.available_at = Some(now + ChronoDuration::seconds(CALENDAR_DEBOUNCE_SECS));
        effect
    };
    match transition {
        Transition::Start => {
            let started_at = event.started_at.map_or(now, |at| at.with_timezone(&Utc));
            let mut start = Effect::new(EffectKind::EventStart, id);
            start.key_suffix = Some(started_at.timestamp().to_string());
            start.expires_at = event.auto_stop_deadline.map(|at| at.with_timezone(&Utc));
            vec![start, Effect::new(EffectKind::EventUpsert, id), calendar()]
        }
        Transition::Stop { auto, .. } => vec![
            close(if auto { "auto_stopped" } else { "stopped" }),
            voice_release(),
            calendar(),
        ],
        Transition::Cancel => vec![close("cancelled"), voice_release(), calendar()],
        Transition::Uncancel | Transition::Unarchive => {
            vec![Effect::new(EffectKind::EventUpsert, id), calendar()]
        }
        Transition::Archive => {
            let mut effects = vec![Effect::new(EffectKind::EventRemove, id)];
            if event.vod_forum_thread_id.is_some() {
                effects.push(Effect::new(EffectKind::VodDelete, id));
            }
            if event.discord_voice_channel_id.is_some() {
                effects.push(voice_release());
            }
            effects.push(calendar());
            effects
        }
    }
}

/// Emits the manual "starts in less than one hour" reminder (DO §5.2, `remind`).
///
/// Always `cause = manual`, whoever asked, and coalesced per minute, so the web and the Discord
/// remind produce the same effect. Only the caller checks that the event is still scheduled.
///
/// # Errors
///
/// [`AppError::NotFound`] for an unknown event, [`AppError::Database`] otherwise.
pub async fn emit_manual_reminder(
    db: &DatabaseConnection,
    event_id: i64,
) -> Result<Vec<EffectRef>, AppError> {
    let txn = db.begin().await.map_err(AppError::Database)?;
    let event = event::Entity::find_by_id(event_id)
        .one(&txn)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
    let now = Utc::now();
    let mut effect = Effect::new(EffectKind::EventReminder, event_id);
    effect.key_suffix = Some(now.format("%Y%m%d%H%M").to_string());
    effect.expires_at = Some(
        event
            .start_time_utc
            .unwrap_or(event.event_date_utc)
            .with_timezone(&Utc),
    );
    let mut written = Vec::new();
    record_effect(&txn, now, OutboxCause::Manual, effect, &mut written).await?;
    txn.commit().await.map_err(AppError::Database)?;
    Ok(written)
}

/// What happens after a stop wrote the status: the completion-XP snapshot (per `xp`) and the
/// local-split roster sync in a SAVEPOINT. Shared by the stop transition and
/// [`EventService::finish_copy_session`].
pub(super) async fn finish_session_in_txn(
    txn: &DatabaseTransaction,
    stopped: &event::Model,
    xp: XpFilter,
) -> Result<SplitSyncState, AppError> {
    if xp == XpFilter::Everyone {
        let completed_at = stopped.stopped_at.unwrap_or_else(|| Utc::now().into());
        EventService::snapshot_event_completion_xp(
            txn,
            stopped.id,
            stopped.created_by,
            completed_at,
        )
        .await?;
    }
    // Keep linked splits' roster and lifecycle condition current as soon as the event ends.
    SplitService::new()
        .sync_event_participants_isolated(txn, stopped.id)
        .await
}

async fn apply_start(
    txn: &DatabaseTransaction,
    model: event::Model,
) -> Result<event::Model, AppError> {
    let id = model.id;
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

    let now = Utc::now();
    let deadline = now + MAX_SESSION_DURATION;
    // A live event no longer needs the mass notice or the one-hour reminder: starting stamps
    // both, keeping any stamp that was already set.
    let mass_notified_at = model.mass_notified_at.or(Some(now.into()));
    let reminder_notified_at = model.reminder_notified_at.or(Some(now.into()));
    let mut active: event::ActiveModel = model.into();
    active.status = Set("live".to_string());
    active.started_at = Set(Some(now.into()));
    active.stopped_at = Set(None);
    active.auto_stop_deadline = Set(Some(deadline.into()));
    active.link_status = Set("in_progress".to_string());
    active.link_attempts = Set(0);
    active.link_last_error = Set(None);
    active.link_battles_completed_at = Set(None);
    active.mass_notified_at = Set(mass_notified_at);
    active.reminder_notified_at = Set(reminder_notified_at);
    active.updated_at = Set(now.into());
    active.update(txn).await.map_err(AppError::Database)
}

async fn apply_stop(
    txn: &DatabaseTransaction,
    model: event::Model,
    auto: bool,
) -> Result<event::Model, AppError> {
    if model.status != "live" {
        return Err(AppError::Conflict(format!(
            "Event {} is not live (status={})",
            model.id, model.status
        )));
    }
    let now = Utc::now();
    let mut active: event::ActiveModel = model.into();
    active.status = Set(if auto { "auto_stopped" } else { "stopped" }.to_string());
    active.stopped_at = Set(Some(now.into()));
    active.updated_at = Set(now.into());
    active.update(txn).await.map_err(AppError::Database)
}

async fn apply_cancel(
    txn: &DatabaseTransaction,
    model: event::Model,
) -> Result<event::Model, AppError> {
    if model.status != "scheduled" && model.status != "live" {
        return Err(AppError::Conflict(format!(
            "Event {} cannot be cancelled (status={})",
            model.id, model.status
        )));
    }
    let now = Utc::now();
    let mut active: event::ActiveModel = model.into();
    active.status = Set("cancelled".to_string());
    active.stopped_at = Set(Some(now.into()));
    active.auto_stop_deadline = Set(None);
    active.updated_at = Set(now.into());
    active.update(txn).await.map_err(AppError::Database)
}

async fn apply_uncancel(
    txn: &DatabaseTransaction,
    model: event::Model,
) -> Result<event::Model, AppError> {
    reject_if_event_archived(&model)?;
    if model.status != "cancelled" {
        return Err(AppError::Conflict(format!(
            "Event {} cannot be restored (status={})",
            model.id, model.status
        )));
    }
    let now = Utc::now();
    // A restored event that is still ahead of its start is a reschedule: its mass and
    // reminder stamps no longer describe the schedule it returns to (R22).
    let rescheduled = model
        .start_time_utc
        .unwrap_or(model.event_date_utc)
        .with_timezone(&Utc)
        > now;
    let mut active: event::ActiveModel = model.into();
    active.status = Set("scheduled".to_string());
    active.started_at = Set(None);
    active.stopped_at = Set(None);
    active.auto_stop_deadline = Set(None);
    active.link_status = Set("pending".to_string());
    active.link_attempts = Set(0);
    active.link_last_error = Set(None);
    active.link_battles_completed_at = Set(None);
    if rescheduled {
        active.mass_notified_at = Set(None);
        active.reminder_notified_at = Set(None);
    }
    active.updated_at = Set(now.into());
    active.update(txn).await.map_err(AppError::Database)
}

async fn apply_archive(
    txn: &DatabaseTransaction,
    model: event::Model,
) -> Result<event::Model, AppError> {
    let id = model.id;
    let now: chrono::DateTime<chrono::FixedOffset> = Utc::now().into();
    let mut active: event::ActiveModel = model.into();
    active.archived_at = Set(Some(now));
    active.updated_at = Set(now);
    let updated = active.update(txn).await.map_err(AppError::Database)?;

    // A deleted/archived event must not leave its loot split in the officer queue.
    split::Entity::update_many()
        .filter(split::Column::EventId.eq(id))
        .filter(split::Column::ArchivedAt.is_null())
        .col_expr(split::Column::ArchivedAt, Expr::value(now))
        .col_expr(split::Column::UpdatedAt, Expr::value(now))
        .exec(txn)
        .await
        .map_err(AppError::Database)?;
    Ok(updated)
}

async fn apply_unarchive(
    txn: &DatabaseTransaction,
    model: event::Model,
) -> Result<event::Model, AppError> {
    let id = model.id;
    let should_requeue_vod =
        model.vod_forum_post_enabled && model.vod_forum_post_status == "deleted";
    let now = Utc::now();
    let mut active: event::ActiveModel = model.into();
    active.archived_at = Set(None);
    active.updated_at = Set(now.into());
    if should_requeue_vod {
        // A confirmed archive deletion is safe to replace: the next poll will create a
        // fresh VOD post for the restored event. Ambiguous `attempted` posts deliberately
        // remain non-retriable.
        active.vod_forum_post_status = Set("pending".to_string());
        active.vod_forum_thread_id = Set(None);
    }
    let updated = active.update(txn).await.map_err(AppError::Database)?;

    let linked = split::Entity::find()
        .filter(split::Column::EventId.eq(id))
        .filter(split::Column::ArchivedAt.is_not_null())
        .all(txn)
        .await
        .map_err(AppError::Database)?;
    for linked_split in linked {
        let mut split_active: split::ActiveModel = linked_split.into();
        split_active.archived_at = Set(None);
        split_active.updated_at = Set(now.into());
        split_active.update(txn).await.map_err(AppError::Database)?;
    }
    Ok(updated)
}

/// Converges one copy's content and lifecycle state to the current source.
///
/// Content and status follow the source unconditionally. Discord voice channels
/// and battle-linker progress stay tenant-local. A cancelled or archived
/// source archives the copy; an unarchived source restores it.
pub async fn converge_copy_to_source(
    target_db: &DatabaseConnection,
    source: &event::Model,
    copy_id: i64,
) -> Result<(), AppError> {
    let Some(copy) = event::Entity::find_by_id(copy_id).one(target_db).await? else {
        return Ok(());
    };
    let copy_archived = copy.archived_at.is_some();
    let requeue_deleted_vod =
        source.vod_forum_post_enabled && copy.vod_forum_post_status == "deleted";
    // A schedule moved into the future re-arms the mass notice and the reminder on the origin;
    // the copy must follow or its Discord server never announces the postponed event again.
    let rescheduled = (copy.mass_time_utc != source.mass_time_utc
        || copy.start_time_utc != source.start_time_utc)
        && source
            .start_time_utc
            .is_some_and(|start| start.to_utc() > chrono::Utc::now());
    let mut active: event::ActiveModel = copy.into();
    if rescheduled {
        active.mass_notified_at = Set(None);
        active.reminder_notified_at = Set(None);
    }
    active.title = Set(source.title.clone());
    active.description = Set(source.description.clone());
    active.call_to_arms = Set(source.call_to_arms);
    active.regear = Set(source.regear);
    active.player_cap = Set(source.player_cap);
    active.event_date_utc = Set(source.event_date_utc);
    active.mass_time_utc = Set(source.mass_time_utc);
    active.start_time_utc = Set(source.start_time_utc);
    active.vod_forum_post_enabled = Set(source.vod_forum_post_enabled);
    let source_terminal = source.archived_at.is_some() || source.status == "cancelled";
    if source_terminal {
        active.status = Set(source.status.clone());
        if !copy_archived {
            active.archived_at = Set(Some(chrono::Utc::now().into()));
        }
    } else {
        active.status = Set(source.status.clone());
        active.started_at = Set(source.started_at);
        active.stopped_at = Set(source.stopped_at);
        active.auto_stop_deadline = Set(source.auto_stop_deadline);
        if requeue_deleted_vod {
            // A confirmed archive deletion is safe to replace with a new
            // tenant-local VOD post after the source event is restored.
            active.vod_forum_post_status = Set("pending".to_owned());
            active.vod_forum_thread_id = Set(None);
        }
        // Source session state is authoritative, but its Discord voice channel
        // and local battle-link progress remain destination-specific.
        active.archived_at = Set(None);
    }
    active.updated_at = Set(chrono::Utc::now().into());
    active.update(target_db).await?;
    Ok(())
}

/// Propagates an owner-authorized source change to every active copy.
///
/// Alliance sources enqueue a durable fanout job (operation `update` or
/// `archive`) with the current active-membership snapshot and process it once
/// inline; failures remain in the outbox, visible through the fanout status
/// endpoint and retried by the periodic worker. Guild sources converge their
/// alliance mirrors inline; an error is returned so the caller can retry.
pub async fn sync_owner_change_to_copies(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    tenant_id: &str,
    source: &event::Model,
    operation: fanout_outbox::Operation,
) -> Result<(), AppError> {
    // A copy never propagates: its canonical source owns the change.
    let (canonical_tenant, _canonical_event) =
        canonical_event_origin(control, tenant_id, source.id).await?;
    if canonical_tenant != tenant_id {
        return Ok(());
    }
    let peers = linked_event_peers(control, tenant_id, source.id).await?;
    if peers.is_empty() {
        return Ok(());
    }

    let kind = super::attribution::tenant_kind(control, tenant_id).await?;
    if kind == "alliance" {
        let rows = control
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT guild_tenant_id FROM alliance_memberships \
                 WHERE alliance_tenant_id = $1 AND status = 'active' \
                 ORDER BY guild_tenant_id",
                [tenant_id.into()],
            ))
            .await?;
        let targets = rows
            .into_iter()
            .map(|row| row.try_get_by_index::<String>(0))
            .collect::<Result<Vec<_>, _>>()?;
        let job_id = fanout_outbox::enqueue(
            control,
            tenant_id,
            source.id,
            operation,
            &format!(
                "{}:{}",
                operation_key(operation),
                source.updated_at.to_utc().to_rfc3339()
            ),
            &targets,
        )
        .await?;
        if let Err(error) = super::fanout_worker::process_due_targets(control, registry).await {
            // The job row is durable: report it, keep it retryable, do not fail
            // the already-committed source mutation.
            tracing::error!(
                job_id = %job_id,
                source_event_id = source.id,
                error = %error,
                "event lifecycle fanout queued but immediate processing failed"
            );
        }
        return Ok(());
    }

    for (peer_tenant, peer_event_id) in peers {
        let peer = registry.get_or_load(&peer_tenant).await?;
        converge_copy_to_source(&peer.db, source, peer_event_id).await?;
    }
    Ok(())
}

fn operation_key(operation: fanout_outbox::Operation) -> &'static str {
    match operation {
        fanout_outbox::Operation::Publish => "publish",
        fanout_outbox::Operation::Update => "update",
        fanout_outbox::Operation::Archive => "archive",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::alliance_share::ShareActor;
    use crate::modules::events::{
        fanout_outbox::{self, Operation},
        models::{CreateEventRequest, ParticipateEventRequest},
        participation_outbox,
        service::EventService,
        sync::{process_due_forwards, sync_participation},
    };
    use crate::modules::sync::{LegacyLinks, SyncKind, assert_writable};
    use crate::modules::users::identity::upsert_discord_user;
    use crate::postgres::{
        connect_with_search_path, drop_schema, ensure_schema,
        test_support::{try_admin_db, unique_schema},
    };
    use crate::tenant::TenantRegistry;
    use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter};
    use sea_orm_migration::MigratorTrait;

    struct TestWorld {
        admin: DatabaseConnection,
        control: DatabaseConnection,
        registry: TenantRegistry,
        tenant_dbs: Vec<DatabaseConnection>,
        schemas: Vec<String>,
    }

    impl TestWorld {
        /// One alliance tenant and two member guild tenants.
        async fn new() -> Option<Self> {
            let (url, admin) = try_admin_db().await?;
            let control_schema = unique_schema("life_ctl");
            ensure_schema(&admin, &control_schema)
                .await
                .expect("create control schema");
            let control = connect_with_search_path(&url, &control_schema)
                .await
                .expect("connect control schema");
            crate::control_migration::Migrator::up(&control, None)
                .await
                .expect("apply control migrations");

            let mut schemas = vec![control_schema];
            let mut tenant_dbs = Vec::new();
            for (id, kind) in [
                ("alliance", "alliance"),
                ("guild-a", "guild"),
                ("guild-b", "guild"),
            ] {
                let schema = unique_schema("life_ten");
                ensure_schema(&admin, &schema)
                    .await
                    .expect("create tenant schema");
                let db = connect_with_search_path(&url, &schema)
                    .await
                    .expect("connect tenant schema");
                crate::migration::Migrator::up(&db, None)
                    .await
                    .expect("apply tenant migrations");
                control
                    .execute(Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        "INSERT INTO tenants (id, slug, name, schema_name, status, kind) \
                         VALUES ($1,$1,$1,$2,'active',$3)",
                        [id.into(), schema.clone().into(), kind.into()],
                    ))
                    .await
                    .expect("insert tenant");
                if kind == "guild" {
                    control
                        .execute(Statement::from_sql_and_values(
                            DbBackend::Postgres,
                            "INSERT INTO alliance_memberships \
                             (alliance_tenant_id,guild_tenant_id,status) \
                             VALUES ('alliance',$1,'active')",
                            [id.into()],
                        ))
                        .await
                        .expect("insert membership");
                }
                schemas.push(schema);
                tenant_dbs.push(db);
            }
            let registry = TenantRegistry::new(url, control.clone());
            Some(Self {
                admin,
                control,
                registry,
                tenant_dbs,
                schemas,
            })
        }

        async fn add_user_membership(&self, discord_id: &str, tenant_id: &str) {
            self.control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO user_tenant_memberships (discord_id, tenant_id) VALUES ($1,$2)",
                    [discord_id.into(), tenant_id.into()],
                ))
                .await
                .expect("user membership");
        }

        /// The guild copy of an alliance source event, panicking when absent.
        async fn guild_copy(&self, guild_index: usize, source_event_id: i64) -> event::Model {
            event::Entity::find()
                .filter(event::Column::SourceTenantId.eq("alliance"))
                .filter(event::Column::SourceEventId.eq(source_event_id))
                .one(&self.tenant_dbs[guild_index])
                .await
                .expect("query guild copy")
                .expect("guild copy exists")
        }

        async fn close(self) {
            let Self {
                admin,
                control,
                registry,
                tenant_dbs,
                schemas,
            } = self;
            drop(registry);
            for db in tenant_dbs {
                db.close().await.expect("close tenant DB");
            }
            control.close().await.expect("close control DB");
            for schema in schemas {
                drop_schema(&admin, &schema)
                    .await
                    .expect("drop test schema");
            }
        }
    }

    fn flash_event(title: &str) -> CreateEventRequest {
        CreateEventRequest {
            title: title.to_owned(),
            description: None,
            call_to_arms: false,
            regear: false,
            event_kind: Some("flash".to_owned()),
            comp_id: None,
            player_cap: None,
            event_date_utc: Some("2026-07-20T20:00:00Z".to_owned()),
            mass_time_utc: None,
            start_time_utc: None,
            discord_role_ids: Vec::new(),
            create_split: false,
            island_tab_id: None,
            origin_guild_id: None,
            ping_alliance: false,
            vod_forum_post_enabled: false,
            discord_delivery: "message".to_owned(),
        }
    }

    fn rename_event(title: &str) -> crate::modules::events::models::UpdateEventRequest {
        crate::modules::events::models::UpdateEventRequest {
            title: Some(title.to_owned()),
            description: None,
            call_to_arms: None,
            regear: None,
            comp_id: None,
            event_date_utc: None,
            mass_time_utc: None,
            start_time_utc: None,
            ping_alliance: None,
            alliance_discord_message_id: None,
        }
    }

    async fn publish_alliance_event(world: &TestWorld, title: &str) -> event::Model {
        let alliance_db = &world.tenant_dbs[0];
        let creator_id = upsert_discord_user(
            alliance_db,
            "discord-creator",
            "Creator",
            "creator@example.invalid",
            "User",
            false,
        )
        .await
        .expect("create owner");
        let created = EventService::new()
            .create_event(alliance_db, creator_id, flash_event(title))
            .await
            .expect("create source event");
        fanout_outbox::enqueue(
            &world.control,
            "alliance",
            created.id,
            Operation::Publish,
            &format!("publish:{}", created.id),
            &["guild-a".to_owned(), "guild-b".to_owned()],
        )
        .await
        .expect("enqueue publish");
        super::super::fanout_worker::process_due_targets(&world.control, &world.registry)
            .await
            .expect("process publish");
        event::Entity::find_by_id(created.id)
            .one(alliance_db)
            .await
            .expect("reload source")
            .expect("source event row")
    }

    #[tokio::test]
    async fn guild_copies_reject_management_and_owner_changes_converge() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Owner-managed event").await;
        let copy_a = world.guild_copy(1, source.id).await;

        // Guild copies reject management; the owner tenant does not.
        let guild_a_db = &world.tenant_dbs[1];
        let alliance_db = &world.tenant_dbs[0];
        assert!(matches!(
            assert_writable(
                guild_a_db,
                LegacyLinks {
                    control: &world.control,
                    tenant_id: "guild-a",
                },
                SyncKind::Event,
                copy_a.id,
            )
            .await,
            Err(AppError::ReadOnlyCopy(_))
        ));
        assert_writable(
            alliance_db,
            LegacyLinks {
                control: &world.control,
                tenant_id: "alliance",
            },
            SyncKind::Event,
            source.id,
        )
        .await
        .expect("owner tenant may manage");

        // An owner update converges every active copy.
        let alliance_db = &world.tenant_dbs[0];
        EventService::new()
            .update_event(alliance_db, source.id, rename_event("Renamed by owner"))
            .await
            .expect("update source");
        let updated = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &updated,
            Operation::Update,
        )
        .await
        .expect("sync owner change");
        for guild_index in [1, 2] {
            let copy = world.guild_copy(guild_index, source.id).await;
            assert_eq!(copy.title, "Renamed by owner");
            assert!(copy.archived_at.is_none());
        }

        // Starting/stopping is owner state; the copy's Discord voice channel
        // remains local, but its visible event status and timestamps converge.
        EventService::new()
            .start_event(alliance_db, source.id)
            .await
            .expect("start source");
        let live = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload live")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &live,
            Operation::Update,
        )
        .await
        .expect("sync live");
        for guild_index in [1, 2] {
            let copy = world.guild_copy(guild_index, source.id).await;
            assert_eq!(copy.status, "live");
            assert_eq!(copy.started_at, live.started_at);
            assert_eq!(copy.discord_voice_channel_id, None);
        }

        // Cancelling the source cancels and archives every copy.
        EventService::new()
            .cancel_event(alliance_db, source.id)
            .await
            .expect("cancel source");
        let cancelled = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &cancelled,
            Operation::Archive,
        )
        .await
        .expect("sync cancel");
        for guild_index in [1, 2] {
            let copy = world.guild_copy(guild_index, source.id).await;
            assert_eq!(copy.status, "cancelled");
            assert!(copy.archived_at.is_some());
        }

        // Uncancel restores the copies.
        EventService::new()
            .uncancel_event(alliance_db, source.id)
            .await
            .expect("uncancel source");
        let restored = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &restored,
            Operation::Update,
        )
        .await
        .expect("sync uncancel");
        for guild_index in [1, 2] {
            let copy = world.guild_copy(guild_index, source.id).await;
            assert_eq!(copy.status, "scheduled");
            assert!(copy.archived_at.is_none());
        }
        world.close().await;
    }

    #[tokio::test]
    async fn restoring_archived_event_requeues_deleted_vod_posts_per_tenant() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Restore VOD posts").await;
        let databases = [
            &world.tenant_dbs[0],
            &world.tenant_dbs[1],
            &world.tenant_dbs[2],
        ];
        for (index, db) in databases.into_iter().enumerate() {
            let mut active: event::ActiveModel = event::Entity::find_by_id(source.id)
                .one(db)
                .await
                .expect("load event")
                .expect("event exists")
                .into();
            active.vod_forum_post_enabled = Set(true);
            active.vod_forum_post_status = Set("created".to_owned());
            active.vod_forum_thread_id = Set(Some(format!("vod-thread-{index}")));
            active.update(db).await.expect("seed created VOD post");
        }

        let alliance_db = &world.tenant_dbs[0];
        EventService::new()
            .archive_event(alliance_db, source.id)
            .await
            .expect("archive source");
        let archived = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload archived source")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &archived,
            Operation::Archive,
        )
        .await
        .expect("archive copies");

        for (index, db) in databases.into_iter().enumerate() {
            assert!(
                EventService::new()
                    .record_vod_forum_post_deleted(db, source.id, &format!("vod-thread-{index}"),)
                    .await
                    .expect("record VOD deletion")
            );
        }

        let restored = EventService::new()
            .unarchive_event(alliance_db, source.id)
            .await
            .expect("restore source");
        assert_eq!(restored.vod_forum_post_status, "pending");
        assert_eq!(restored.vod_forum_thread_id, None);
        let restored_model = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload restored source")
            .expect("source row");
        sync_owner_change_to_copies(
            &world.control,
            &world.registry,
            "alliance",
            &restored_model,
            Operation::Update,
        )
        .await
        .expect("restore copies");

        for guild_index in [1, 2] {
            let copy = world.guild_copy(guild_index, source.id).await;
            assert_eq!(copy.vod_forum_post_status, "pending");
            assert_eq!(copy.vod_forum_thread_id, None);
            assert!(copy.archived_at.is_none());
        }
        world.close().await;
    }

    #[tokio::test]
    async fn update_job_recovers_after_a_partial_target_failure() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Retry event").await;
        let alliance_db = &world.tenant_dbs[0];
        EventService::new()
            .update_event(alliance_db, source.id, rename_event("Retried title"))
            .await
            .expect("update source");
        let updated = event::Entity::find_by_id(source.id)
            .one(alliance_db)
            .await
            .expect("reload")
            .expect("source row");

        let job_id = fanout_outbox::enqueue(
            &world.control,
            "alliance",
            source.id,
            Operation::Update,
            &format!("update:{}", updated.updated_at.to_utc().to_rfc3339()),
            &["guild-a".to_owned(), "guild-b".to_owned()],
        )
        .await
        .expect("enqueue update");

        // Claim exactly one target and fail it, simulating a partial failure.
        let claimed = fanout_outbox::claim_due(&world.control, 1, 60)
            .await
            .expect("claim one target");
        let failed_target = claimed
            .into_iter()
            .find(|target| target.tenant_id == "guild-a")
            .expect("guild-a claimed first");
        fanout_outbox::mark_retryable(
            &world.control,
            job_id,
            "guild-a",
            failed_target.lease_token,
            "simulated transient failure",
            3600,
        )
        .await
        .expect("mark target failed");

        // The retry worker still converges the healthy target.
        super::super::fanout_worker::process_due_targets(&world.control, &world.registry)
            .await
            .expect("process remaining target");
        assert_eq!(
            world.guild_copy(2, source.id).await.title,
            "Retried title",
            "healthy target converged"
        );
        assert_ne!(
            world.guild_copy(1, source.id).await.title,
            "Retried title",
            "failed target not yet converged"
        );
        let statuses = fanout_outbox::target_statuses(&world.control, job_id)
            .await
            .unwrap();
        let failed = statuses
            .iter()
            .find(|status| status.tenant_id == "guild-a")
            .expect("failed target status");
        assert_eq!(failed.state, "failed");
        assert!(
            failed
                .last_error
                .as_deref()
                .is_some_and(|error| error.contains("simulated transient failure"))
        );

        // Once the retry delay elapses, the failed target converges too.
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE event_fanout_targets SET next_attempt_at = NOW() \
                 WHERE job_id=$1 AND tenant_id='guild-a'",
                [job_id.into()],
            ))
            .await
            .expect("force retry due");
        super::super::fanout_worker::process_due_targets(&world.control, &world.registry)
            .await
            .expect("retry failed target");
        assert_eq!(
            world.guild_copy(1, source.id).await.title,
            "Retried title",
            "failed target converged after retry"
        );
        let statuses = fanout_outbox::target_statuses(&world.control, job_id)
            .await
            .unwrap();
        assert!(statuses.iter().all(|status| status.state == "complete"));
        world.close().await;
    }

    #[tokio::test]
    async fn worker_exhausts_a_permanently_failing_target_and_stops_retrying() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        // The source event does not exist, so every attempt fails.
        let job_id = fanout_outbox::enqueue(
            &world.control,
            "alliance",
            987_654,
            Operation::Update,
            "update:never",
            &["guild-a".to_owned()],
        )
        .await
        .expect("enqueue");
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE event_fanout_targets SET attempts=$2 WHERE job_id=$1",
                [job_id.into(), (fanout_outbox::MAX_ATTEMPTS - 1).into()],
            ))
            .await
            .expect("spend all but the last attempt");

        let processed =
            super::super::fanout_worker::process_due_targets(&world.control, &world.registry)
                .await
                .expect("worker tick");
        assert_eq!(processed, 1);
        let status = fanout_outbox::target_statuses(&world.control, job_id)
            .await
            .unwrap()
            .remove(0);
        assert_eq!(status.state, "exhausted");
        assert!(status.last_error.is_some_and(|e| e.contains("987654")));

        let again =
            super::super::fanout_worker::process_due_targets(&world.control, &world.registry)
                .await
                .expect("second tick");
        assert_eq!(again, 0, "an exhausted target is not retried");
        world.close().await;
    }

    async fn participation_count(db: &DatabaseConnection, event_id: i64) -> i64 {
        crate::modules::events::entities::event_participation::Entity::find()
            .filter(
                crate::modules::events::entities::event_participation::Column::EventId.eq(event_id),
            )
            .count(db)
            .await
            .expect("count participations") as i64
    }

    fn actor(discord_id: &str) -> ShareActor {
        ShareActor {
            discord_id: discord_id.to_owned(),
            username: "Participant".to_owned(),
            email: None,
        }
    }

    #[tokio::test]
    async fn alliance_join_reaches_every_guild_copy_and_leave_from_any_copy() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Attribution event").await;
        let copy_a = world.guild_copy(1, source.id).await;
        let copy_b = world.guild_copy(2, source.id).await;
        let alliance_db = &world.tenant_dbs[0];

        // A caller in two guilds must choose explicitly.
        world.add_user_membership("discord-7", "guild-a").await;
        world.add_user_membership("discord-7", "guild-b").await;
        assert!(matches!(
            super::super::attribution::resolve_join_attribution(
                &world.control,
                "alliance",
                source.id,
                "discord-7",
                None,
            )
            .await,
            Err(AppError::Conflict(_))
        ));
        let attributed = super::super::attribution::resolve_join_attribution(
            &world.control,
            "alliance",
            source.id,
            "discord-7",
            Some("guild-b"),
        )
        .await
        .expect("explicit guild choice resolves");
        assert_eq!(attributed, "guild-b");

        // Join from the alliance copy.
        let user_id = upsert_discord_user(
            alliance_db,
            "discord-7",
            "Participant",
            "discord-7@example.invalid",
            "User",
            false,
        )
        .await
        .expect("alliance user");
        let request = ParticipateEventRequest {
            primary_build_id: None,
            secondary_build_id: None,
        };
        EventService::new()
            .participate_with_roster_version(alliance_db, source.id, user_id, request.clone())
            .await
            .expect("join canonical event");
        let synced = sync_participation(
            &world.control,
            &world.registry,
            "alliance",
            source.id,
            &actor("discord-7"),
            Some(request),
        )
        .await
        .expect("fanout");
        // The caller broadcasts a roster change for exactly these copies.
        assert_eq!(
            synced,
            vec![
                ("guild-a".to_owned(), copy_a.id),
                ("guild-b".to_owned(), copy_b.id)
            ]
        );

        assert_eq!(participation_count(alliance_db, source.id).await, 1);
        assert_eq!(
            participation_count(&world.tenant_dbs[2], copy_b.id).await,
            1,
            "attributed guild copy receives the signup"
        );
        assert_eq!(
            participation_count(&world.tenant_dbs[1], copy_a.id).await,
            1,
            "the sibling guild copy shows the same roster"
        );

        // Leave from the attributed guild copy removes the canonical signup too.
        let guild_b_user = upsert_discord_user(
            &world.tenant_dbs[2],
            "discord-7",
            "Participant",
            "discord-7@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild-b user");
        EventService::new()
            .cancel_participation(&world.tenant_dbs[2], copy_b.id, guild_b_user)
            .await
            .expect("leave from guild copy");
        sync_participation(
            &world.control,
            &world.registry,
            "guild-b",
            copy_b.id,
            &actor("discord-7"),
            None,
        )
        .await
        .expect("leave fanout");
        assert_eq!(participation_count(alliance_db, source.id).await, 0);
        assert_eq!(
            participation_count(&world.tenant_dbs[2], copy_b.id).await,
            0
        );
        assert_eq!(
            participation_count(&world.tenant_dbs[1], copy_a.id).await,
            0
        );
        world.close().await;
    }

    #[tokio::test]
    async fn guild_tenant_join_attributes_to_itself_and_reaches_sibling_guilds() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Guild-context event").await;
        let copy_a = world.guild_copy(1, source.id).await;
        let copy_b = world.guild_copy(2, source.id).await;

        let attributed = super::super::attribution::resolve_join_attribution(
            &world.control,
            "guild-a",
            copy_a.id,
            "discord-9",
            None,
        )
        .await
        .expect("guild context auto-selects the current tenant");
        assert_eq!(attributed, "guild-a");

        let guild_a_db = &world.tenant_dbs[1];
        let user_id = upsert_discord_user(
            guild_a_db,
            "discord-9",
            "Member",
            "discord-9@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild-a user");
        let request = ParticipateEventRequest {
            primary_build_id: None,
            secondary_build_id: None,
        };
        EventService::new()
            .participate_with_roster_version(guild_a_db, copy_a.id, user_id, request.clone())
            .await
            .expect("join guild copy");
        sync_participation(
            &world.control,
            &world.registry,
            "guild-a",
            copy_a.id,
            &actor("discord-9"),
            Some(request),
        )
        .await
        .expect("guild join fanout");

        assert_eq!(participation_count(guild_a_db, copy_a.id).await, 1);
        assert_eq!(
            participation_count(&world.tenant_dbs[0], source.id).await,
            1,
            "the canonical event receives the signup"
        );
        assert_eq!(
            participation_count(&world.tenant_dbs[2], copy_b.id).await,
            1,
            "the sibling guild copy shows the same roster"
        );

        // Leaving from the sibling copy clears it everywhere, and a copy the
        // user never joined (diverged roster) is not an error.
        let guild_b_user = upsert_discord_user(
            &world.tenant_dbs[2],
            "discord-9",
            "Member",
            "discord-9@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild-b user");
        EventService::new()
            .cancel_participation(&world.tenant_dbs[2], copy_b.id, guild_b_user)
            .await
            .expect("leave sibling copy");
        // Simulate a roster that diverged before this fix: the origin has no signup.
        EventService::new()
            .cancel_participation(
                &world.tenant_dbs[0],
                source.id,
                upsert_discord_user(
                    &world.tenant_dbs[0],
                    "discord-9",
                    "Member",
                    "discord-9@example.invalid",
                    "User",
                    false,
                )
                .await
                .expect("alliance user"),
            )
            .await
            .expect("diverge the origin");
        let synced = sync_participation(
            &world.control,
            &world.registry,
            "guild-b",
            copy_b.id,
            &actor("discord-9"),
            None,
        )
        .await
        .expect("leave fanout");
        assert_eq!(
            synced.len(),
            2,
            "peers lacking the signup still count as synced"
        );
        assert_eq!(participation_count(guild_a_db, copy_a.id).await, 0);
        world.close().await;
    }

    #[tokio::test]
    async fn the_reconcile_sweep_gives_every_copy_a_signup_it_missed_exactly_once() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Diverged roster").await;
        let copy_a = world.guild_copy(1, source.id).await;
        let copy_b = world.guild_copy(2, source.id).await;

        // A signup that was only ever saved on guild A's copy.
        let guild_a_db = &world.tenant_dbs[1];
        let user_id = upsert_discord_user(
            guild_a_db,
            "discord-11",
            "Early bird",
            "discord-11@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild-a user");
        EventService::new()
            .participate_with_roster_version(
                guild_a_db,
                copy_a.id,
                user_id,
                ParticipateEventRequest {
                    primary_build_id: None,
                    secondary_build_id: None,
                },
            )
            .await
            .expect("local signup");

        let added = super::super::sync::reconcile_rosters(&world.control, &world.registry)
            .await
            .expect("sweep");
        assert_eq!(added, 2, "the origin and the sibling copy each gain it");
        assert_eq!(
            participation_count(&world.tenant_dbs[0], source.id).await,
            1
        );
        assert_eq!(
            participation_count(&world.tenant_dbs[2], copy_b.id).await,
            1
        );
        assert_eq!(participation_count(guild_a_db, copy_a.id).await, 1);

        let again = super::super::sync::reconcile_rosters(&world.control, &world.registry)
            .await
            .expect("second sweep");
        assert_eq!(again, 0, "nothing is written once the rosters agree");
        world.close().await;
    }

    /// A build picked on one guild's copy must resolve to the sibling guild's own build, not to
    /// the origin's id.
    #[tokio::test]
    async fn builds_map_between_sibling_copies_through_the_origin() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Sibling builds").await;
        let job_id: uuid::Uuid = world
            .control
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT id FROM event_fanout_jobs WHERE source_event_id = $1 LIMIT 1",
                [source.id.into()],
            ))
            .await
            .expect("job")
            .expect("job row")
            .try_get_by_index(0)
            .expect("job id");
        for (tenant, destination) in [("guild-a", 110_i64), ("guild-b", 210_i64)] {
            world
                .control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO event_fanout_assets \
                     (job_id, tenant_id, asset_type, source_id, destination_id) \
                     VALUES ($1,$2,'build',10,$3)",
                    [job_id.into(), tenant.into(), destination.into()],
                ))
                .await
                .expect("asset");
        }
        let map = |from: &'static str, to: &'static str, id: i64| {
            let control = &world.control;
            let origin = source.id;
            async move {
                super::super::sync::map_build(control, from, to, Some(id), "alliance", origin)
                    .await
                    .expect("map")
            }
        };
        assert_eq!(map("guild-a", "guild-b", 110).await, Some(210));
        assert_eq!(map("guild-b", "guild-a", 210).await, Some(110));
        assert_eq!(map("guild-a", "alliance", 110).await, Some(10));
        assert_eq!(map("alliance", "guild-b", 10).await, Some(210));
        world.close().await;
    }

    /// Archiving a copy makes it refuse every roster change, which is how these tests make one
    /// peer unavailable and then fix it.
    async fn set_copy_archived(db: &DatabaseConnection, event_id: i64, archived: bool) {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            if archived {
                "UPDATE events SET archived_at = NOW() WHERE id = $1"
            } else {
                "UPDATE events SET archived_at = NULL WHERE id = $1"
            },
            [event_id.into()],
        ))
        .await
        .expect("toggle archived copy");
    }

    async fn make_forwards_due(world: &TestWorld) {
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE event_participation_forwards \
                 SET next_attempt_at = NOW() - INTERVAL '1 second'",
                [],
            ))
            .await
            .expect("make forwards due");
    }

    /// Saves the alliance-side change, then forwards it, like the route handlers do.
    async fn change_participation_on_alliance(
        world: &TestWorld,
        event_id: i64,
        discord_id: &str,
        join: bool,
    ) -> Vec<(String, i64)> {
        let alliance_db = &world.tenant_dbs[0];
        let user_id = upsert_discord_user(
            alliance_db,
            discord_id,
            "Participant",
            &format!("{discord_id}@example.invalid"),
            "User",
            false,
        )
        .await
        .expect("alliance user");
        let request = ParticipateEventRequest {
            primary_build_id: None,
            secondary_build_id: None,
        };
        let forwarded = if join {
            EventService::new()
                .participate_with_roster_version(alliance_db, event_id, user_id, request.clone())
                .await
                .expect("join canonical event");
            Some(request)
        } else {
            EventService::new()
                .cancel_participation(alliance_db, event_id, user_id)
                .await
                .expect("leave canonical event");
            None
        };
        sync_participation(
            &world.control,
            &world.registry,
            "alliance",
            event_id,
            &actor(discord_id),
            forwarded,
        )
        .await
        .expect("forward")
    }

    #[tokio::test]
    async fn a_forward_that_fails_is_retried_and_delivered_exactly_once() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Retried join").await;
        let copy_a = world.guild_copy(1, source.id).await;
        let copy_b = world.guild_copy(2, source.id).await;
        let guild_b_db = &world.tenant_dbs[2];

        set_copy_archived(guild_b_db, copy_b.id, true).await;
        let synced = change_participation_on_alliance(&world, source.id, "discord-21", true).await;
        assert_eq!(
            synced,
            vec![("guild-a".to_owned(), copy_a.id)],
            "the fast path stays synchronous for the copies that took the change"
        );
        assert_eq!(
            participation_count(&world.tenant_dbs[1], copy_a.id).await,
            1
        );
        assert_eq!(participation_count(guild_b_db, copy_b.id).await, 0);
        let queued = participation_outbox::statuses(&world.control, "alliance", source.id)
            .await
            .unwrap();
        assert_eq!(
            queued.len(),
            1,
            "only the failed copy is queued: {queued:?}"
        );
        assert_eq!(queued[0].peer_tenant_id, "guild-b");
        assert_eq!(queued[0].operation, "join");
        assert_eq!(queued[0].state, "failed");
        assert_eq!(queued[0].attempts, 1);
        assert!(queued[0].last_error.is_some());

        // Not due yet: backoff holds the retry back.
        assert_eq!(
            process_due_forwards(&world.control, &world.registry)
                .await
                .unwrap(),
            0
        );

        // Still failing: another attempt is spent, nothing is delivered.
        make_forwards_due(&world).await;
        assert_eq!(
            process_due_forwards(&world.control, &world.registry)
                .await
                .unwrap(),
            1
        );
        let queued = participation_outbox::statuses(&world.control, "alliance", source.id)
            .await
            .unwrap();
        assert_eq!(queued[0].attempts, 2);
        assert_eq!(participation_count(guild_b_db, copy_b.id).await, 0);

        // The peer is fixed: the next retry delivers once and clears the entry.
        set_copy_archived(guild_b_db, copy_b.id, false).await;
        make_forwards_due(&world).await;
        assert_eq!(
            process_due_forwards(&world.control, &world.registry)
                .await
                .unwrap(),
            1
        );
        assert_eq!(participation_count(guild_b_db, copy_b.id).await, 1);
        assert!(
            participation_outbox::statuses(&world.control, "alliance", source.id)
                .await
                .unwrap()
                .is_empty()
        );
        make_forwards_due(&world).await;
        assert_eq!(
            process_due_forwards(&world.control, &world.registry)
                .await
                .unwrap(),
            0,
            "a delivered entry is never replayed"
        );
        assert_eq!(participation_count(guild_b_db, copy_b.id).await, 1);
        assert_eq!(
            participation_count(&world.tenant_dbs[0], source.id).await,
            1
        );
        world.close().await;
    }

    #[tokio::test]
    async fn a_lost_leave_converges_and_the_sweep_does_not_resurrect_the_user() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Lost leave").await;
        let copy_a = world.guild_copy(1, source.id).await;
        let copy_b = world.guild_copy(2, source.id).await;
        let guild_a_db = &world.tenant_dbs[1];
        let guild_b_db = &world.tenant_dbs[2];

        let synced = change_participation_on_alliance(&world, source.id, "discord-22", true).await;
        assert_eq!(synced.len(), 2);
        assert_eq!(participation_count(guild_b_db, copy_b.id).await, 1);

        // The user leaves while guild B's copy cannot take the change.
        set_copy_archived(guild_b_db, copy_b.id, true).await;
        let synced = change_participation_on_alliance(&world, source.id, "discord-22", false).await;
        assert_eq!(synced, vec![("guild-a".to_owned(), copy_a.id)]);
        assert_eq!(
            participation_count(&world.tenant_dbs[0], source.id).await,
            0
        );
        assert_eq!(participation_count(guild_a_db, copy_a.id).await, 0);
        assert_eq!(participation_count(guild_b_db, copy_b.id).await, 1);

        // Guild B is reachable again but the retry has not run: the sweep sees a signup that
        // only guild B holds and must leave it alone instead of copying it back.
        set_copy_archived(guild_b_db, copy_b.id, false).await;
        let added = super::super::sync::reconcile_rosters(&world.control, &world.registry)
            .await
            .expect("sweep");
        assert_eq!(added, 0, "a queued leave is not undone by the sweep");
        assert_eq!(
            participation_count(&world.tenant_dbs[0], source.id).await,
            0
        );
        assert_eq!(participation_count(guild_a_db, copy_a.id).await, 0);

        make_forwards_due(&world).await;
        process_due_forwards(&world.control, &world.registry)
            .await
            .unwrap();
        assert_eq!(participation_count(guild_b_db, copy_b.id).await, 0);
        assert!(
            participation_outbox::statuses(&world.control, "alliance", source.id)
                .await
                .unwrap()
                .is_empty()
        );
        let added = super::super::sync::reconcile_rosters(&world.control, &world.registry)
            .await
            .expect("sweep after convergence");
        assert_eq!(added, 0);
        for (db, event_id) in [
            (&world.tenant_dbs[0], source.id),
            (guild_a_db, copy_a.id),
            (guild_b_db, copy_b.id),
        ] {
            assert_eq!(participation_count(db, event_id).await, 0);
        }
        world.close().await;
    }

    #[tokio::test]
    async fn the_latest_intent_replaces_a_queued_one() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Join then leave").await;
        let copy_b = world.guild_copy(2, source.id).await;
        let guild_b_db = &world.tenant_dbs[2];

        set_copy_archived(guild_b_db, copy_b.id, true).await;
        change_participation_on_alliance(&world, source.id, "discord-23", true).await;
        change_participation_on_alliance(&world, source.id, "discord-23", false).await;
        let queued = participation_outbox::statuses(&world.control, "alliance", source.id)
            .await
            .unwrap();
        assert_eq!(queued.len(), 1, "one entry per participant and peer");
        assert_eq!(queued[0].operation, "leave");
        assert_eq!(queued[0].attempts, 1, "a new intent re-arms the attempts");

        set_copy_archived(guild_b_db, copy_b.id, false).await;
        make_forwards_due(&world).await;
        process_due_forwards(&world.control, &world.registry)
            .await
            .unwrap();
        assert_eq!(
            participation_count(guild_b_db, copy_b.id).await,
            0,
            "the queued join never lands after the leave"
        );
        assert!(
            participation_outbox::statuses(&world.control, "alliance", source.id)
                .await
                .unwrap()
                .is_empty()
        );
        world.close().await;
    }

    #[tokio::test]
    async fn forward_attempts_are_capped_and_a_new_change_rearms_them() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Capped forward").await;
        let copy_b = world.guild_copy(2, source.id).await;
        let guild_b_db = &world.tenant_dbs[2];

        set_copy_archived(guild_b_db, copy_b.id, true).await;
        change_participation_on_alliance(&world, source.id, "discord-24", true).await;
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE event_participation_forwards SET attempts = $1",
                [(participation_outbox::MAX_ATTEMPTS - 1).into()],
            ))
            .await
            .unwrap();
        make_forwards_due(&world).await;
        assert_eq!(
            process_due_forwards(&world.control, &world.registry)
                .await
                .unwrap(),
            1
        );
        let queued = participation_outbox::statuses(&world.control, "alliance", source.id)
            .await
            .unwrap();
        assert_eq!(queued[0].state, "exhausted");
        assert_eq!(queued[0].attempts, participation_outbox::MAX_ATTEMPTS);

        // An exhausted entry is parked: the peer recovering does not revive it by itself.
        set_copy_archived(guild_b_db, copy_b.id, false).await;
        make_forwards_due(&world).await;
        assert_eq!(
            process_due_forwards(&world.control, &world.registry)
                .await
                .unwrap(),
            0
        );
        assert_eq!(participation_count(guild_b_db, copy_b.id).await, 0);

        // A fresh change from the user re-arms the entry and, the peer being healthy, lands.
        let synced = change_participation_on_alliance(&world, source.id, "discord-24", true).await;
        assert_eq!(synced.len(), 2);
        assert_eq!(participation_count(guild_b_db, copy_b.id).await, 1);
        assert!(
            participation_outbox::statuses(&world.control, "alliance", source.id)
                .await
                .unwrap()
                .is_empty()
        );
        world.close().await;
    }

    /// A guild that left the alliance no longer takes forwards; its queued entry is dropped.
    #[tokio::test]
    async fn a_queued_forward_to_a_guild_that_left_is_dropped() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Departed peer").await;
        let copy_b = world.guild_copy(2, source.id).await;
        let guild_b_db = &world.tenant_dbs[2];

        set_copy_archived(guild_b_db, copy_b.id, true).await;
        change_participation_on_alliance(&world, source.id, "discord-25", true).await;
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE event_sync_links SET sync_enabled = false WHERE mirror_tenant_id = 'guild-b'",
                [],
            ))
            .await
            .unwrap();
        set_copy_archived(guild_b_db, copy_b.id, false).await;
        make_forwards_due(&world).await;
        process_due_forwards(&world.control, &world.registry)
            .await
            .unwrap();
        assert_eq!(participation_count(guild_b_db, copy_b.id).await, 0);
        assert!(
            participation_outbox::statuses(&world.control, "alliance", source.id)
                .await
                .unwrap()
                .is_empty()
        );
        world.close().await;
    }

    /// A selected build that was never shared with the linked tenant cannot be mapped there. The
    /// caller's own signup is already saved by then, so the sync must log and skip that copy
    /// instead of failing the call (the route used to answer with an error for a signup that had
    /// in fact succeeded).
    #[tokio::test]
    async fn an_unmappable_build_does_not_fail_the_sync_of_a_saved_signup() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Unshared build event").await;
        let copy_a = world.guild_copy(1, source.id).await;

        let unshared_build = ParticipateEventRequest {
            primary_build_id: Some(987_654),
            secondary_build_id: None,
        };
        sync_participation(
            &world.control,
            &world.registry,
            "guild-a",
            copy_a.id,
            &actor("discord-9"),
            Some(unshared_build),
        )
        .await
        .expect("a copy that cannot map the build is skipped, not an error");

        assert_eq!(
            participation_count(&world.tenant_dbs[0], source.id).await,
            0,
            "the copy that could not take the build is left untouched"
        );
        let queued = participation_outbox::statuses(&world.control, "alliance", source.id)
            .await
            .unwrap();
        assert_eq!(
            queued
                .iter()
                .map(|entry| entry.peer_tenant_id.as_str())
                .collect::<Vec<_>>(),
            ["alliance", "guild-b"],
            "each copy that could not take the signup is queued for retry"
        );
        world.close().await;
    }

    #[tokio::test]
    async fn alliance_split_preflights_every_guild_and_retries_after_manual_roster_removal() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Split distribution event").await;
        let alliance_db = &world.tenant_dbs[0];
        let alice = upsert_discord_user(
            alliance_db,
            "distribution-alice",
            "Alice",
            "alice@example.invalid",
            "User",
            false,
        )
        .await
        .expect("alliance Alice");
        let bob = upsert_discord_user(
            alliance_db,
            "distribution-bob",
            "Bob",
            "bob@example.invalid",
            "User",
            false,
        )
        .await
        .expect("alliance Bob");
        for (discord_id, guild_id) in [
            ("distribution-alice", "guild-a"),
            ("distribution-bob", "guild-b"),
        ] {
            world.add_user_membership(discord_id, guild_id).await;
            world
                .control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO event_participant_attributions \
                     (id,source_tenant_id,source_event_id,discord_id,guild_tenant_id) \
                     VALUES ($1,'alliance',$2,$3,$4)",
                    [
                        uuid::Uuid::new_v4().into(),
                        source.id.into(),
                        discord_id.into(),
                        guild_id.into(),
                    ],
                ))
                .await
                .expect("event attribution");
        }
        let alice_guild_id = upsert_discord_user(
            &world.tenant_dbs[1],
            "distribution-alice",
            "Alice",
            "alice@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild Alice");
        upsert_discord_user(
            &world.tenant_dbs[2],
            "distribution-bob",
            "Bob",
            "bob@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild Bob");

        alliance_db
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE events SET status='stopped' WHERE id=$1",
                [source.id.into()],
            ))
            .await
            .expect("stop event");
        let split_row = alliance_db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO splits \
                 (created_by,status,estimated_market_value,fee,repair_value,bags_value,event_id,updated_at) \
                 VALUES ($1,'pending',100,0,0,0,$2,NOW()) RETURNING id",
                [source.created_by.into(), source.id.into()],
            ))
            .await
            .expect("insert split")
            .expect("split row");
        let split_id: i64 = split_row.try_get_by_index(0).expect("split id");
        for user_id in [alice, bob] {
            alliance_db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO split_participants (split_id,user_id,weight) VALUES ($1,$2,100)",
                    [split_id.into(), user_id.into()],
                ))
                .await
                .expect("split participant");
        }

        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE alliance_memberships SET status='left' \
                 WHERE alliance_tenant_id='alliance' AND guild_tenant_id='guild-b'",
                [],
            ))
            .await
            .expect("depart guild-b");
        let blocked = crate::modules::splits::alliance_distribution::complete(
            &world.control,
            &world.registry,
            "alliance",
            alliance_db,
            split_id,
            source.created_by,
        )
        .await;
        assert!(matches!(blocked, Err(AppError::Conflict(_))));
        assert_eq!(
            crate::modules::bank::entities::Entity::find()
                .count(&world.tenant_dbs[1])
                .await
                .expect("count guild-a transactions"),
            0,
            "preflight failure must not write a transaction to another guild"
        );
        let batch_count: i64 = world
            .control
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT COUNT(*) FROM alliance_split_distribution_batches WHERE split_id=$1",
                [split_id.into()],
            ))
            .await
            .expect("count distribution batches")
            .expect("count row")
            .try_get_by_index(0)
            .expect("batch count");
        assert_eq!(batch_count, 0, "invalid preflight creates no batch");

        // The agreed recovery is manual: remove the participants from the
        // departed guild, then retry the same completion request.
        alliance_db
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "DELETE FROM split_participants WHERE split_id=$1 AND user_id=$2",
                [split_id.into(), bob.into()],
            ))
            .await
            .expect("remove departed guild participant");

        // Simulate a transient failure after the first tenant transaction has
        // committed. Retrying the same roster must resume without paying Alice
        // twice.
        let charlie = upsert_discord_user(
            alliance_db,
            "distribution-charlie",
            "Charlie",
            "charlie@example.invalid",
            "User",
            false,
        )
        .await
        .expect("alliance Charlie");
        world
            .add_user_membership("distribution-charlie", "guild-a")
            .await;
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO event_participant_attributions \
                 (id,source_tenant_id,source_event_id,discord_id,guild_tenant_id) \
                 VALUES ($1,'alliance',$2,'distribution-charlie','guild-a')",
                [uuid::Uuid::new_v4().into(), source.id.into()],
            ))
            .await
            .expect("Charlie event attribution");
        let charlie_guild_id = upsert_discord_user(
            &world.tenant_dbs[1],
            "distribution-charlie",
            "Charlie",
            "charlie@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild-a Charlie");
        alliance_db
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO split_participants (split_id,user_id,weight) VALUES ($1,$2,100)",
                [split_id.into(), charlie.into()],
            ))
            .await
            .expect("Charlie split participant");
        world.tenant_dbs[1]
            .execute_unprepared(&format!(
                "CREATE FUNCTION fail_one_projection() RETURNS trigger LANGUAGE plpgsql AS $$ \
                 BEGIN IF NEW.to_user_id = {charlie_guild_id} AND NEW.alliance_distribution_key IS NOT NULL \
                 THEN RAISE EXCEPTION 'simulated transient projection failure'; END IF; RETURN NEW; END $$; \
                 CREATE TRIGGER fail_charlie_projection BEFORE INSERT ON transactions \
                 FOR EACH ROW EXECUTE FUNCTION fail_one_projection();"
            ))
            .await
            .expect("install simulated tenant failure");
        let partial = crate::modules::splits::alliance_distribution::complete(
            &world.control,
            &world.registry,
            "alliance",
            alliance_db,
            split_id,
            source.created_by,
        )
        .await;
        assert!(
            partial.is_err(),
            "transient destination failure is surfaced"
        );
        let failed_status = crate::modules::splits::alliance_distribution::status(
            &world.control,
            "alliance",
            split_id,
        )
        .await
        .expect("load failed batch status")
        .expect("failed batch exists");
        assert_eq!(failed_status.state, "failed");
        assert_eq!(
            failed_status
                .recipients
                .iter()
                .filter(|recipient| recipient.state == "complete")
                .count(),
            1,
            "status records the durable partial result"
        );
        assert!(
            failed_status
                .recipients
                .iter()
                .filter(|recipient| recipient.state == "pending")
                .all(|recipient| recipient.last_error.is_some()),
            "status retains the error on incomplete recipients"
        );
        assert_eq!(
            crate::modules::bank::entities::Entity::find()
                .count(&world.tenant_dbs[1])
                .await
                .expect("count partial destination rows"),
            1,
            "Alice's earlier idempotent credit is durable"
        );
        world.tenant_dbs[1]
            .execute_unprepared(
                "DROP TRIGGER fail_charlie_projection ON transactions; \
                 DROP FUNCTION fail_one_projection();",
            )
            .await
            .expect("remove simulated failure");
        let detail = crate::modules::splits::alliance_distribution::complete(
            &world.control,
            &world.registry,
            "alliance",
            alliance_db,
            split_id,
            source.created_by,
        )
        .await
        .expect("retry after roster cleanup");
        let complete_status = crate::modules::splits::alliance_distribution::status(
            &world.control,
            "alliance",
            split_id,
        )
        .await
        .expect("load complete batch status")
        .expect("completed batch exists");
        assert_eq!(complete_status.state, "complete");
        assert!(
            complete_status
                .recipients
                .iter()
                .all(|recipient| recipient.state == "complete")
        );
        assert_eq!(
            detail.summary.net_value,
            Some(sea_orm::prelude::Decimal::from(100))
        );
        let transactions = crate::modules::bank::entities::Entity::find()
            .all(&world.tenant_dbs[1])
            .await
            .expect("guild-a projected transactions");
        assert_eq!(transactions.len(), 2);
        let by_user = transactions
            .iter()
            .map(|transaction| (transaction.to_user_id, transaction))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            by_user[&alice_guild_id].amount,
            sea_orm::prelude::Decimal::from(50)
        );
        assert_eq!(
            by_user[&charlie_guild_id].amount,
            sea_orm::prelude::Decimal::from(50)
        );
        assert!(transactions.iter().all(|transaction| {
            transaction.source_alliance_tenant_id.as_deref() == Some("alliance")
                && transaction.source_alliance_split_id == Some(split_id)
        }));
        assert!(
            crate::modules::bank::entities::Entity::find()
                .all(&world.tenant_dbs[2])
                .await
                .expect("guild-b transactions")
                .is_empty()
        );

        crate::modules::splits::alliance_distribution::complete(
            &world.control,
            &world.registry,
            "alliance",
            alliance_db,
            split_id,
            source.created_by,
        )
        .await
        .expect("idempotent repeat");
        assert_eq!(
            crate::modules::bank::entities::Entity::find()
                .count(&world.tenant_dbs[1])
                .await
                .expect("count after repeated completion"),
            2,
            "retries must not duplicate transaction credits"
        );
        world.close().await;
    }

    #[tokio::test]
    async fn concurrent_alliance_split_confirmations_credit_each_guild_once() {
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let source = publish_alliance_event(&world, "Concurrent split event").await;
        let alliance_db = &world.tenant_dbs[0];
        let mut participants = Vec::new();
        for (discord_id, name, guild_id, guild_index) in [
            ("concurrent-alice", "Alice", "guild-a", 1usize),
            ("concurrent-bob", "Bob", "guild-b", 2usize),
        ] {
            let email = format!("{discord_id}@example.invalid");
            let user_id = upsert_discord_user(alliance_db, discord_id, name, &email, "User", false)
                .await
                .expect("alliance user");
            upsert_discord_user(
                &world.tenant_dbs[guild_index],
                discord_id,
                name,
                &email,
                "User",
                false,
            )
            .await
            .expect("guild user");
            world.add_user_membership(discord_id, guild_id).await;
            world
                .control
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO event_participant_attributions \
                     (id,source_tenant_id,source_event_id,discord_id,guild_tenant_id) \
                     VALUES ($1,'alliance',$2,$3,$4)",
                    [
                        uuid::Uuid::new_v4().into(),
                        source.id.into(),
                        discord_id.into(),
                        guild_id.into(),
                    ],
                ))
                .await
                .expect("event attribution");
            participants.push(user_id);
        }
        alliance_db
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE events SET status='stopped' WHERE id=$1",
                [source.id.into()],
            ))
            .await
            .expect("stop event");
        let split_id: i64 = alliance_db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO splits \
                 (created_by,status,estimated_market_value,fee,repair_value,bags_value,event_id,updated_at) \
                 VALUES ($1,'pending',100,0,0,0,$2,NOW()) RETURNING id",
                [source.created_by.into(), source.id.into()],
            ))
            .await
            .expect("insert split")
            .expect("split row")
            .try_get_by_index(0)
            .expect("split id");
        for user_id in &participants {
            alliance_db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO split_participants (split_id,user_id,weight) VALUES ($1,$2,100)",
                    [split_id.into(), (*user_id).into()],
                ))
                .await
                .expect("split participant");
        }

        let confirm = || {
            crate::modules::splits::alliance_distribution::complete(
                &world.control,
                &world.registry,
                "alliance",
                alliance_db,
                split_id,
                source.created_by,
            )
        };
        let (first, second, third) = tokio::join!(confirm(), confirm(), confirm());
        assert!(
            first.is_ok() && second.is_ok() && third.is_ok(),
            "concurrent confirmations must converge: {:?} {:?} {:?}",
            first.as_ref().err(),
            second.as_ref().err(),
            third.as_ref().err()
        );
        for guild_index in [1usize, 2usize] {
            let transactions = crate::modules::bank::entities::Entity::find()
                .all(&world.tenant_dbs[guild_index])
                .await
                .expect("guild transactions");
            assert_eq!(
                transactions.len(),
                1,
                "guild {guild_index} is credited exactly once"
            );
            assert_eq!(transactions[0].amount, sea_orm::prelude::Decimal::from(50));
        }
        let status = crate::modules::splits::alliance_distribution::status(
            &world.control,
            "alliance",
            split_id,
        )
        .await
        .expect("status")
        .expect("batch exists");
        assert_eq!(status.state, "complete");
        world.close().await;
    }

    #[tokio::test]
    async fn failed_guild_mirror_is_retried_without_duplicating_the_alliance_event() {
        use crate::modules::alliance_share::{
            AllianceShareService, ShareParams,
            models::{ArtifactType, CreateAllianceShareRequest},
        };
        use crate::modules::comps::{
            models::{
                AddCompBuildRequest, CreateBuildCategoryRequest, CreateBuildRequest,
                CreateCompCategoryRequest, CreateCompRequest,
            },
            service::CompService,
            status::BuildRole,
        };
        let Some(world) = TestWorld::new().await else {
            return;
        };
        let guild_db = &world.tenant_dbs[1];
        let creator_id = upsert_discord_user(
            guild_db,
            "mirror-creator",
            "Mirror creator",
            "mirror-creator@example.invalid",
            "User",
            false,
        )
        .await
        .expect("guild creator");
        let comps = CompService::new();
        let build_category = comps
            .create_build_category(
                guild_db,
                CreateBuildCategoryRequest {
                    name: "Mirror builds".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("build category");
        let comp_category = comps
            .create_comp_category(
                guild_db,
                CreateCompCategoryRequest {
                    name: "Mirror comps".to_owned(),
                    description: None,
                },
            )
            .await
            .expect("comp category");
        let build = comps
            .create_build(
                guild_db,
                creator_id,
                CreateBuildRequest {
                    name: "Mirror healer".to_owned(),
                    description: None,
                    role: BuildRole::Healer,
                    category_id: build_category.id,
                    items: None,
                },
            )
            .await
            .expect("build");
        let comp = comps
            .create_comp(
                guild_db,
                creator_id,
                CreateCompRequest {
                    name: "Mirror comp".to_owned(),
                    description: None,
                    category_id: comp_category.id,
                    builds: vec![AddCompBuildRequest {
                        build_id: build.summary.id,
                        quantity: 1,
                    }],
                    parent_id: None,
                },
            )
            .await
            .expect("comp");
        let mut request = flash_event("Guild event for the alliance");
        request.event_kind = Some("organized".to_owned());
        request.comp_id = Some(comp.summary.id);
        let event = EventService::new()
            .create_event(guild_db, creator_id, request)
            .await
            .expect("guild event");
        let view = EventService::new()
            .get_event_detail(guild_db, event.id)
            .await
            .expect("event view")
            .event;
        let actor = ShareActor {
            discord_id: "mirror-creator".to_owned(),
            username: "Mirror creator".to_owned(),
            email: None,
        };

        // First attempt fails because the guild's membership is not active.
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE alliance_memberships SET status='left' WHERE guild_tenant_id='guild-a'",
                [],
            ))
            .await
            .expect("suspend membership");
        let error = super::super::sync::create_mirror(
            &world.control,
            &world.registry,
            guild_db,
            "guild-a",
            &view,
            &actor,
        )
        .await
        .expect_err("inactive membership blocks the mirror");
        super::super::mirror_retry::enqueue(
            &world.control,
            "guild-a",
            event.id,
            &actor,
            &error.to_string(),
        )
        .await
        .expect("queue retry");

        let force_due = || {
            world.control.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE event_mirror_requests SET next_attempt_at=NOW()",
                [],
            ))
        };
        force_due().await.expect("make due");
        assert_eq!(
            super::super::mirror_retry::process_due(&world.control, &world.registry)
                .await
                .expect("first retry cycle"),
            1
        );
        let failed =
            super::super::mirror_retry::status_for_event(&world.control, "guild-a", event.id)
                .await
                .expect("status")
                .expect("request exists");
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.attempts, 1);
        assert!(failed.last_error.is_some());
        assert_eq!(failed.mirror_event_id, None);

        // Membership returns; the next retry creates exactly one mirror.
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE alliance_memberships SET status='active' WHERE guild_tenant_id='guild-a'",
                [],
            ))
            .await
            .expect("restore membership");

        // Simulate a crash after the alliance event commits but before its
        // control-plane link or retry acknowledgement is written.
        let shared_comp = AllianceShareService::share_comp(
            &world.control,
            &world.registry,
            guild_db,
            ShareParams {
                source_tenant_id: "guild-a",
                source_kind: "guild",
                actor: &actor,
                authorized: true,
            },
            CreateAllianceShareRequest {
                artifact_type: ArtifactType::Comp,
                id: comp.summary.id,
            },
        )
        .await
        .expect("share comp before simulated crash");
        let alliance_creator_id = upsert_discord_user(
            &world.tenant_dbs[0],
            "mirror-creator",
            "Mirror creator",
            "mirror-creator@example.invalid",
            "User",
            false,
        )
        .await
        .expect("alliance creator");
        let mut orphan_request = flash_event("Guild event for the alliance");
        orphan_request.event_kind = Some(view.event_kind.clone());
        orphan_request.comp_id = Some(shared_comp.published_id);
        orphan_request.player_cap = view.player_cap;
        orphan_request.event_date_utc = Some(view.event_date_utc.clone());
        orphan_request.mass_time_utc = Some(view.mass_time_utc.clone());
        orphan_request.start_time_utc = Some(view.start_time_utc.clone());
        orphan_request.vod_forum_post_enabled = view.vod_forum_post_enabled;
        orphan_request.discord_delivery = view.discord_delivery.clone();
        let orphan_mirror = EventService::new()
            .create_event_with_source_identity(
                &world.tenant_dbs[0],
                alliance_creator_id,
                orphan_request,
                Some(("guild-a".to_owned(), event.id)),
            )
            .await
            .expect("create mirror before simulated crash");
        let orphan_mirror_id = orphan_mirror.id;

        super::super::mirror_retry::requeue(&world.control, "guild-a", event.id)
            .await
            .expect("manually re-arm failed mirror");
        super::super::mirror_retry::process_due(&world.control, &world.registry)
            .await
            .expect("second retry cycle");
        let done =
            super::super::mirror_retry::status_for_event(&world.control, "guild-a", event.id)
                .await
                .expect("status")
                .expect("request exists");
        assert_eq!(done.state, "complete", "{:?}", done.last_error);
        assert_eq!(done.mirror_event_id, Some(orphan_mirror_id));
        assert_eq!(
            event::Entity::find()
                .count(&world.tenant_dbs[0])
                .await
                .expect("alliance events"),
            1,
            "exactly one alliance mirror exists"
        );

        // A completed request is never claimed again, so no duplicate appears.
        force_due().await.expect("make due after completion");
        assert_eq!(
            super::super::mirror_retry::process_due(&world.control, &world.registry)
                .await
                .expect("idle cycle"),
            0
        );
        assert_eq!(
            event::Entity::find()
                .count(&world.tenant_dbs[0])
                .await
                .expect("alliance events"),
            1
        );

        // A source cancelled before its retry is due must not create a stale
        // alliance announcement.
        let mut cancelled_request = flash_event("Cancelled guild event");
        cancelled_request.event_kind = Some("organized".to_owned());
        cancelled_request.comp_id = Some(comp.summary.id);
        let cancelled = EventService::new()
            .create_event(guild_db, creator_id, cancelled_request)
            .await
            .expect("create event to cancel");
        guild_db
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE events SET status='cancelled' WHERE id=$1",
                [cancelled.id.into()],
            ))
            .await
            .expect("cancel source event");
        super::super::mirror_retry::enqueue(
            &world.control,
            "guild-a",
            cancelled.id,
            &actor,
            "initial mirror attempt failed",
        )
        .await
        .expect("queue cancelled event request");
        force_due().await.expect("make cancelled request due");
        assert_eq!(
            super::super::mirror_retry::process_due(&world.control, &world.registry)
                .await
                .expect("ignore cancelled source"),
            1
        );
        let inactive =
            super::super::mirror_retry::status_for_event(&world.control, "guild-a", cancelled.id)
                .await
                .expect("cancelled mirror status")
                .expect("cancelled request exists");
        assert_eq!(inactive.state, "inactive");
        assert_eq!(
            event::Entity::find()
                .count(&world.tenant_dbs[0])
                .await
                .expect("alliance events after cancelled request"),
            1
        );
        world.close().await;
    }

    #[tokio::test]
    async fn auto_stop_goes_through_the_transition_core_and_skips_xp_for_mirrors() {
        use super::transition_tests::{fixture, seed_event};
        use crate::event_sessions::auto_stop::auto_stop_expired_sessions;
        use crate::modules::events::entities::event_completion_xp;

        let Some(world) = TestWorld::new().await else {
            return;
        };
        let db = &world.tenant_dbs[1];
        let fx = fixture(db).await;
        // `seed_event` gives a live event whose auto-stop deadline is already due.
        let (own, own_split) = seed_event(db, &fx, "live", false).await;
        let (mirror, _) = seed_event(db, &fx, "live", false).await;
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO event_sync_links \
                 (id, source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id) \
                 VALUES ($1,'guild-b',1,'guild-a',$2)",
                [uuid::Uuid::new_v4().into(), mirror.into()],
            ))
            .await
            .expect("link mirror");
        // A copy whose link was disabled (membership departure) is local now: it must
        // still stop, and still award nothing.
        let (detached, _) = seed_event(db, &fx, "live", false).await;
        world
            .control
            .execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "INSERT INTO event_sync_links \
                 (id, source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id, \
                  sync_enabled) \
                 VALUES ($1,'guild-b',2,'guild-a',$2,false)",
                [uuid::Uuid::new_v4().into(), detached.into()],
            ))
            .await
            .expect("link detached copy");

        auto_stop_expired_sessions(db, &EventService::new(), &world.control, "guild-a")
            .await
            .expect("auto-stop pass");

        for id in [own, mirror, detached] {
            let row = event::Entity::find_by_id(id)
                .one(db)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(row.status, "auto_stopped");
        }
        let xp = |id| {
            event_completion_xp::Entity::find()
                .filter(event_completion_xp::Column::EventId.eq(id))
                .count(db)
        };
        assert_eq!(
            xp(own).await.unwrap(),
            3,
            "own event snapshots creator + participants"
        );
        assert_eq!(xp(mirror).await.unwrap(), 0, "a mirror never awards XP");
        assert_eq!(
            xp(detached).await.unwrap(),
            0,
            "a detached copy awards no XP"
        );
        let split_row = crate::modules::splits::entities::split::Entity::find_by_id(own_split)
            .one(db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            split_row.status, "pending",
            "the stop synced the linked split"
        );
        world.close().await;
    }
}

/// Auto-stop must treat every copy role the same way on SQLite: all roles stop, none but
/// origins and unsynced events award XP, and a detached copy is not special-cased.
#[cfg(test)]
mod copy_role_auto_stop_tests {
    use super::transition_tests::{fixture, seed_event, sqlite_db as bare_sqlite_db};
    use super::*;
    use crate::event_sessions::auto_stop::auto_stop_expired_sessions;
    use crate::modules::events::entities::event_completion_xp;
    use crate::modules::sync::test_support::{link_event, sqlite_db};
    use sea_orm::PaginatorTrait;

    const TENANT: &str = "guild-a";

    #[tokio::test]
    async fn every_copy_role_auto_stops_and_only_origins_award_xp() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (unsynced, _) = seed_event(&db, &fx, "live", false).await;
        let (origin, _) = seed_event(&db, &fx, "live", false).await;
        let (active_copy, _) = seed_event(&db, &fx, "live", false).await;
        let (detached_copy, _) = seed_event(&db, &fx, "live", false).await;
        link_event(&db, (TENANT, origin), ("guild-b", 900), true).await;
        link_event(&db, ("guild-b", 1), (TENANT, active_copy), true).await;
        link_event(&db, ("guild-b", 2), (TENANT, detached_copy), false).await;

        auto_stop_expired_sessions(&db, &EventService::new(), &db, TENANT)
            .await
            .expect("auto-stop pass");

        let xp_rows = |id| {
            let db = &db;
            async move {
                event_completion_xp::Entity::find()
                    .filter(event_completion_xp::Column::EventId.eq(id))
                    .count(db)
                    .await
                    .unwrap()
            }
        };
        for (id, expected_xp) in [
            (unsynced, 3),
            (origin, 3),
            (active_copy, 0),
            // The regression this guards: a disabled link must neither keep the event live
            // forever nor start awarding XP the origin tenant owns.
            (detached_copy, 0),
        ] {
            let row = event::Entity::find_by_id(id)
                .one(&db)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(row.status, "auto_stopped", "event {id} must stop");
            assert_eq!(xp_rows(id).await, expected_xp, "xp rows of event {id}");
        }
    }

    #[tokio::test]
    async fn a_failing_control_lookup_leaves_the_session_live() {
        // Without the link table the copy role cannot be resolved; stopping blindly could
        // award XP to a copy, so the session is left for the next pass.
        let db = bare_sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, _) = seed_event(&db, &fx, "live", false).await;
        auto_stop_expired_sessions(&db, &EventService::new(), &db, TENANT)
            .await
            .expect("pass");
        let row = event::Entity::find_by_id(id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "live");
    }
}

/// Contract tests of the transition core. They run on in-memory SQLite and, when
/// `TEST_DATABASE_URL` is set, on Postgres through the same scenario functions.
#[cfg(test)]
mod transition_tests {
    use super::*;
    use crate::discord_delivery::kinds::EffectKind;
    use crate::modules::events::entities::{event_completion_xp, event_participation};
    use crate::modules::splits::entities::{split, split_participant};
    use crate::modules::users::entities as users;
    use sea_orm::{Database, TransactionTrait};
    use sea_orm_migration::MigratorTrait;

    const FAIL_TRIGGER: &str = "fail_split_participants";

    pub(super) async fn sqlite_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect sqlite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("tenant migrations");
        db
    }

    async fn insert_user(db: &DatabaseConnection, name: &str) -> i64 {
        users::ActiveModel {
            username: Set(name.to_owned()),
            email: Set(format!("{name}@example.com")),
            role: Set("User".to_owned()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id
    }

    async fn insert_comp(db: &DatabaseConnection, creator: i64) -> i64 {
        use crate::modules::comps::entities::{comp, comp_category};
        let category = comp_category::ActiveModel {
            name: Set("transition".to_owned()),
            slug: Set("transition".to_owned()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert comp category");
        comp::ActiveModel {
            name: Set("transition comp".to_owned()),
            category_id: Set(category.id),
            created_by: Set(creator),
            version: Set(1),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert comp")
        .id
    }

    /// Fixture shared by every scenario: a creator, two participants and one comp.
    pub(super) struct Fixture {
        pub(super) creator: i64,
        pub(super) first: i64,
        pub(super) second: i64,
        comp_id: i64,
    }

    pub(super) async fn fixture(db: &DatabaseConnection) -> Fixture {
        let creator = insert_user(db, "creator").await;
        let first = insert_user(db, "first").await;
        let second = insert_user(db, "second").await;
        let comp_id = insert_comp(db, creator).await;
        Fixture {
            creator,
            first,
            second,
            comp_id,
        }
    }

    /// Inserts an event in `status` with both participants signed up and one linked split.
    pub(super) async fn seed_event(
        db: &DatabaseConnection,
        fx: &Fixture,
        status: &str,
        archived: bool,
    ) -> (i64, i64) {
        let live_like = status == "live";
        let now: chrono::DateTime<chrono::FixedOffset> = Utc::now().into();
        let event = event::ActiveModel {
            title: Set(format!("{status} event")),
            comp_id: Set(Some(fx.comp_id)),
            created_by: Set(fx.creator),
            event_date_utc: Set(now),
            status: Set(status.to_owned()),
            started_at: Set((live_like || status == "cancelled").then_some(now)),
            auto_stop_deadline: Set(live_like.then_some(now)),
            archived_at: Set(archived.then_some(now)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert event");
        for user_id in [fx.first, fx.second] {
            event_participation::ActiveModel {
                event_id: Set(event.id),
                user_id: Set(user_id),
                ..Default::default()
            }
            .insert(db)
            .await
            .expect("insert participation");
        }
        let linked = split::ActiveModel {
            created_by: Set(fx.creator),
            status: Set("awaiting_event".to_owned()),
            estimated_market_value: Set("100".parse().unwrap()),
            fee: Set("10".parse().unwrap()),
            repair_value: Set("0".parse().unwrap()),
            bags_value: Set("0".parse().unwrap()),
            event_id: Set(Some(event.id)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert split");
        (event.id, linked.id)
    }

    /// Everything a transition may change, minus ids and wall-clock values.
    #[derive(Debug, PartialEq, Eq)]
    struct RowEffects {
        status: String,
        started: bool,
        stopped: bool,
        deadline: bool,
        archived: bool,
        link_status: String,
        link_attempts: i64,
        link_battles_completed: bool,
        split_status: String,
        split_archived: bool,
        split_needs_resync: bool,
        split_participants: usize,
        xp_rows: Vec<(String, String)>,
    }

    async fn row_effects(db: &DatabaseConnection, event_id: i64, split_id: i64) -> RowEffects {
        let model = event::Entity::find_by_id(event_id)
            .one(db)
            .await
            .unwrap()
            .unwrap();
        let linked = split::Entity::find_by_id(split_id)
            .one(db)
            .await
            .unwrap()
            .unwrap();
        let mut xp_rows = event_completion_xp::Entity::find()
            .filter(event_completion_xp::Column::EventId.eq(event_id))
            .all(db)
            .await
            .unwrap()
            .into_iter()
            .map(|row| (row.source, row.status))
            .collect::<Vec<_>>();
        xp_rows.sort();
        RowEffects {
            status: model.status,
            started: model.started_at.is_some(),
            stopped: model.stopped_at.is_some(),
            deadline: model.auto_stop_deadline.is_some(),
            archived: model.archived_at.is_some(),
            link_status: model.link_status,
            link_attempts: model.link_attempts,
            link_battles_completed: model.link_battles_completed_at.is_some(),
            split_status: linked.status,
            split_archived: linked.archived_at.is_some(),
            split_needs_resync: linked.needs_resync,
            split_participants: split_participant::Entity::find()
                .filter(split_participant::Column::SplitId.eq(split_id))
                .all(db)
                .await
                .unwrap()
                .len(),
            xp_rows,
        }
    }

    async fn run(
        db: &DatabaseConnection,
        event_id: i64,
        transition: Transition,
        cause: Cause,
    ) -> Result<TransitionOutcome, AppError> {
        let txn = db.begin().await?;
        let outcome = transition_in_txn(&txn, event_id, transition, cause, Some("actor")).await?;
        txn.commit().await?;
        Ok(outcome)
    }

    fn every_cause() -> Vec<Cause> {
        vec![
            Cause::Web,
            Cause::Discord,
            Cause::Scheduler,
            Cause::Sync { backfill: false },
            Cause::Sync { backfill: true },
            Cause::Settings,
            Cause::Reconcile,
            Cause::Import,
            Cause::Manual,
        ]
    }

    /// Each transition with the pre-state it needs and the row effects it must produce.
    fn transition_cases() -> Vec<(Transition, &'static str, bool, &'static str)> {
        let stop = |auto| Transition::Stop {
            auto,
            xp: XpFilter::Everyone,
        };
        vec![
            (Transition::Start, "scheduled", false, "live"),
            (stop(false), "live", false, "stopped"),
            (stop(true), "live", false, "auto_stopped"),
            (Transition::Cancel, "live", false, "cancelled"),
            (Transition::Cancel, "scheduled", false, "cancelled"),
            (Transition::Uncancel, "cancelled", false, "scheduled"),
            (Transition::Archive, "stopped", false, "stopped"),
            (Transition::Unarchive, "stopped", true, "stopped"),
        ]
    }

    #[tokio::test]
    async fn every_transition_yields_identical_row_changes_for_every_cause() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        for (transition, from, archived, expected_status) in transition_cases() {
            let mut baseline: Option<RowEffects> = None;
            for cause in every_cause() {
                let (event_id, split_id) = seed_event(&db, &fx, from, archived).await;
                let outcome = run(&db, event_id, transition, cause)
                    .await
                    .unwrap_or_else(|error| {
                        panic!("{transition:?} from {from} with {cause:?} failed: {error}")
                    });
                assert!(
                    outcome.changed,
                    "{transition:?} from {from} must change the row"
                );
                assert_eq!(outcome.cause, cause);
                assert_eq!(outcome.model.status, expected_status);
                assert!(!outcome.effects.is_empty());
                assert!(!outcome.wake.is_empty());
                assert_eq!(outcome.sync_outbox_id, None);

                let effects = row_effects(&db, event_id, split_id).await;
                assert_eq!(effects.status, expected_status);
                match &baseline {
                    None => baseline = Some(effects),
                    Some(first) => assert_eq!(
                        &effects, first,
                        "{transition:?} from {from}: {cause:?} differs from the first cause"
                    ),
                }
            }
        }
    }

    #[tokio::test]
    async fn transitions_write_the_documented_row_changes() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;

        let (id, split_id) = seed_event(&db, &fx, "scheduled", false).await;
        run(&db, id, Transition::Start, Cause::Web).await.unwrap();
        let live = row_effects(&db, id, split_id).await;
        assert!(live.started && live.deadline && !live.stopped);
        assert_eq!(live.link_status, "in_progress");

        let stop = Transition::Stop {
            auto: false,
            xp: XpFilter::Everyone,
        };
        run(&db, id, stop, Cause::Web).await.unwrap();
        let stopped = row_effects(&db, id, split_id).await;
        assert_eq!(stopped.status, "stopped");
        assert!(stopped.stopped);
        // creator + two participants, snapshotted in the stop transaction
        assert_eq!(stopped.xp_rows.len(), 3);
        // the awaiting split followed the event and imported the roster
        assert_eq!(stopped.split_status, "pending");
        assert_eq!(stopped.split_participants, 2);

        let (id, _) = seed_event(&db, &fx, "live", false).await;
        run(&db, id, Transition::Cancel, Cause::Web).await.unwrap();
        let cancelled = event::Entity::find_by_id(id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert!(cancelled.stopped_at.is_some() && cancelled.auto_stop_deadline.is_none());
        run(&db, id, Transition::Uncancel, Cause::Web)
            .await
            .unwrap();
        let restored = event::Entity::find_by_id(id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.status, "scheduled");
        assert!(restored.started_at.is_none() && restored.stopped_at.is_none());
        assert_eq!(restored.link_status, "pending");

        let (id, split_id) = seed_event(&db, &fx, "stopped", false).await;
        run(&db, id, Transition::Archive, Cause::Web).await.unwrap();
        let archived = row_effects(&db, id, split_id).await;
        assert!(archived.archived && archived.split_archived);
        run(&db, id, Transition::Unarchive, Cause::Web)
            .await
            .unwrap();
        let unarchived = row_effects(&db, id, split_id).await;
        assert!(!unarchived.archived && !unarchived.split_archived);
    }

    #[tokio::test]
    async fn invalid_transitions_conflict_and_write_nothing() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let stop = Transition::Stop {
            auto: false,
            xp: XpFilter::Everyone,
        };
        let cases = [
            (Transition::Start, "live", false),
            (Transition::Start, "stopped", false),
            (Transition::Start, "scheduled", true),
            (stop, "scheduled", false),
            (stop, "cancelled", false),
            (stop, "live", true),
            (Transition::Cancel, "stopped", false),
            (Transition::Cancel, "scheduled", true),
            (Transition::Uncancel, "scheduled", false),
            (Transition::Uncancel, "cancelled", true),
        ];
        for (transition, from, archived) in cases {
            let (id, split_id) = seed_event(&db, &fx, from, archived).await;
            let before = row_effects(&db, id, split_id).await;
            let error = run(&db, id, transition, Cause::Web).await.unwrap_err();
            assert!(
                matches!(error, AppError::Conflict(_)),
                "{transition:?} from {from} (archived={archived}) gave {error:?}"
            );
            assert_eq!(row_effects(&db, id, split_id).await, before);
        }
        let missing = run(&db, 9_999, Transition::Start, Cause::Web).await;
        assert!(matches!(missing, Err(AppError::NotFound(_))));
    }

    #[tokio::test]
    async fn cancel_of_a_cancelled_event_is_a_noop() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, _) = seed_event(&db, &fx, "cancelled", false).await;
        let before = event::Entity::find_by_id(id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        let outcome = run(&db, id, Transition::Cancel, Cause::Web).await.unwrap();
        assert!(!outcome.changed);
        let after = event::Entity::find_by_id(id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(before, after);
    }

    /// Scenario shared by SQLite and Postgres: a second stop writes nothing.
    pub(super) async fn assert_stop_is_idempotent(db: &DatabaseConnection) {
        let fx = fixture(db).await;
        let (id, split_id) = seed_event(db, &fx, "live", false).await;
        let stop = Transition::Stop {
            auto: false,
            xp: XpFilter::Everyone,
        };
        let first = run(db, id, stop, Cause::Web).await.unwrap();
        assert!(first.changed);
        let row_after_first = event::Entity::find_by_id(id)
            .one(db)
            .await
            .unwrap()
            .unwrap();
        let effects_after_first = row_effects(db, id, split_id).await;
        let split_after_first = split::Entity::find_by_id(split_id)
            .one(db)
            .await
            .unwrap()
            .unwrap();

        // Same transition and the opposite flavor (auto) both leave the stopped event alone.
        for again in [
            stop,
            Transition::Stop {
                auto: true,
                xp: XpFilter::Everyone,
            },
        ] {
            let second = run(db, id, again, Cause::Scheduler).await.unwrap();
            assert!(!second.changed);
            assert_eq!(second.splits, None);
            assert_eq!(
                event::Entity::find_by_id(id)
                    .one(db)
                    .await
                    .unwrap()
                    .unwrap(),
                row_after_first,
                "a repeated stop must not touch the event row"
            );
            assert_eq!(row_effects(db, id, split_id).await, effects_after_first);
            assert_eq!(
                split::Entity::find_by_id(split_id)
                    .one(db)
                    .await
                    .unwrap()
                    .unwrap(),
                split_after_first,
                "a repeated stop must not touch the split row"
            );
        }
    }

    #[tokio::test]
    async fn stop_is_idempotent_on_sqlite() {
        assert_stop_is_idempotent(&sqlite_db().await).await;
    }

    #[tokio::test]
    async fn xp_filter_maps_the_legacy_flag_and_controls_the_snapshot() {
        assert_eq!(XpFilter::from_award_xp(true), XpFilter::Everyone);
        assert_eq!(XpFilter::from_award_xp(false), XpFilter::OwnMembersOnly);

        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (everyone, _) = seed_event(&db, &fx, "live", false).await;
        let (own_only, _) = seed_event(&db, &fx, "live", false).await;
        for (id, xp) in [
            (everyone, XpFilter::Everyone),
            (own_only, XpFilter::OwnMembersOnly),
        ] {
            run(
                &db,
                id,
                Transition::Stop { auto: true, xp },
                Cause::Scheduler,
            )
            .await
            .unwrap();
        }
        let count = |id| {
            let db = &db;
            async move {
                event_completion_xp::Entity::find()
                    .filter(event_completion_xp::Column::EventId.eq(id))
                    .all(db)
                    .await
                    .unwrap()
                    .len()
            }
        };
        assert_eq!(count(everyone).await, 3);
        assert_eq!(count(own_only).await, 0);
    }

    // --- split sync isolation ---------------------------------------------

    async fn install_split_sync_failure(db: &DatabaseConnection) {
        match db.get_database_backend() {
            DbBackend::Sqlite => {
                db.execute_unprepared(&format!(
                    "CREATE TRIGGER {FAIL_TRIGGER} BEFORE INSERT ON split_participants \
                     BEGIN SELECT RAISE(ABORT, 'injected split sync failure'); END"
                ))
                .await
                .unwrap();
            }
            _ => {
                db.execute_unprepared(&format!(
                    "CREATE OR REPLACE FUNCTION {FAIL_TRIGGER}() RETURNS trigger \
                     LANGUAGE plpgsql AS $$ BEGIN \
                     RAISE EXCEPTION 'injected split sync failure'; END $$"
                ))
                .await
                .unwrap();
                db.execute_unprepared(&format!(
                    "CREATE TRIGGER {FAIL_TRIGGER} BEFORE INSERT ON split_participants \
                     FOR EACH ROW EXECUTE FUNCTION {FAIL_TRIGGER}()"
                ))
                .await
                .unwrap();
            }
        }
    }

    async fn remove_split_sync_failure(db: &DatabaseConnection) {
        let sql = match db.get_database_backend() {
            DbBackend::Sqlite => format!("DROP TRIGGER {FAIL_TRIGGER}"),
            _ => format!("DROP TRIGGER {FAIL_TRIGGER} ON split_participants"),
        };
        db.execute_unprepared(&sql).await.unwrap();
    }

    async fn split_roster(db: &DatabaseConnection, split_id: i64) -> Vec<i64> {
        let mut ids = split_participant::Entity::find()
            .filter(split_participant::Column::SplitId.eq(split_id))
            .all(db)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.user_id)
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids
    }

    /// Scenario shared by SQLite and Postgres: a failing split sync does not fail or undo the
    /// stop, leaves the split untouched but flagged, and a repeated stop repairs it.
    pub(super) async fn assert_split_sync_failure_keeps_the_stop(db: &DatabaseConnection) {
        let fx = fixture(db).await;
        let (id, split_id) = seed_event(db, &fx, "live", false).await;
        // The split roster holds `first` and a stale member; the event has `first` and
        // `second`. Reconciling deletes the stale member and then inserts `second`, so a
        // failure on the insert proves the delete is rolled back with the savepoint.
        let stale = insert_user(db, "stale").await;
        for user_id in [fx.first, stale] {
            split_participant::ActiveModel {
                split_id: Set(split_id),
                user_id: Set(user_id),
                weight: Set(sea_orm::prelude::Decimal::ONE),
                ..Default::default()
            }
            .insert(db)
            .await
            .unwrap();
        }
        let mut expected_before = vec![fx.first, stale];
        expected_before.sort_unstable();

        install_split_sync_failure(db).await;
        let stop = Transition::Stop {
            auto: false,
            xp: XpFilter::Everyone,
        };
        let outcome = run(db, id, stop, Cause::Web)
            .await
            .expect("a split sync failure must not fail the stop");
        assert!(outcome.changed);
        assert_eq!(outcome.splits, Some(SplitSyncState::NeedsResync));

        let model = event::Entity::find_by_id(id)
            .one(db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(model.status, "stopped");
        assert!(model.stopped_at.is_some());
        let effects = row_effects(db, id, split_id).await;
        assert!(effects.split_needs_resync, "the split must be flagged");
        assert_eq!(
            effects.split_status, "awaiting_event",
            "split status untouched"
        );
        assert_eq!(
            effects.xp_rows.len(),
            3,
            "the XP snapshot is part of the stop"
        );
        assert_eq!(
            split_roster(db, split_id).await,
            expected_before,
            "the partial roster sync is rolled back to the savepoint"
        );

        // The failure persists: a repeated stop retries, stays successful, stays flagged.
        let retry = run(db, id, stop, Cause::Web).await.unwrap();
        assert!(!retry.changed);
        assert_eq!(retry.splits, Some(SplitSyncState::NeedsResync));
        assert!(row_effects(db, id, split_id).await.split_needs_resync);

        // Once the cause is gone, the next stop repairs the split without touching the event.
        remove_split_sync_failure(db).await;
        let stopped_row = event::Entity::find_by_id(id)
            .one(db)
            .await
            .unwrap()
            .unwrap();
        let repair = run(db, id, stop, Cause::Web).await.unwrap();
        assert!(!repair.changed);
        assert_eq!(repair.splits, Some(SplitSyncState::Synced));
        let mut expected_after = vec![fx.first, fx.second];
        expected_after.sort_unstable();
        assert_eq!(split_roster(db, split_id).await, expected_after);
        let fixed = row_effects(db, id, split_id).await;
        assert!(!fixed.split_needs_resync);
        assert_eq!(fixed.split_status, "pending");
        assert_eq!(
            event::Entity::find_by_id(id)
                .one(db)
                .await
                .unwrap()
                .unwrap(),
            stopped_row
        );
    }

    #[tokio::test]
    async fn split_sync_failure_keeps_the_stop_on_sqlite() {
        assert_split_sync_failure_keeps_the_stop(&sqlite_db().await).await;
    }

    #[tokio::test]
    async fn event_service_stop_succeeds_when_the_split_sync_fails() {
        // The legacy wrapper used to run the sync after commit with `?`, failing the request
        // of an event that was already stopped.
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, split_id) = seed_event(&db, &fx, "live", false).await;
        install_split_sync_failure(&db).await;
        let service = EventService::new();
        let view = service.stop_event(&db, id, false).await.unwrap();
        assert_eq!(view.status, "stopped");
        assert!(row_effects(&db, id, split_id).await.split_needs_resync);
    }

    #[tokio::test]
    async fn a_failing_xp_snapshot_rolls_the_whole_stop_back() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, split_id) = seed_event(&db, &fx, "live", false).await;
        db.execute_unprepared(
            "CREATE TRIGGER fail_xp BEFORE INSERT ON event_completion_xp \
             BEGIN SELECT RAISE(ABORT, 'injected xp failure'); END",
        )
        .await
        .unwrap();
        let before = row_effects(&db, id, split_id).await;
        let stop = Transition::Stop {
            auto: false,
            xp: XpFilter::Everyone,
        };
        assert!(run(&db, id, stop, Cause::Web).await.is_err());
        assert_eq!(row_effects(&db, id, split_id).await, before);
        assert_eq!(before.status, "live");
    }

    #[tokio::test]
    async fn finish_copy_session_runs_the_stop_body_for_an_already_stopped_event() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, split_id) = seed_event(&db, &fx, "stopped", false).await;
        let service = EventService::new();

        let txn = db.begin().await.unwrap();
        let state = service
            .finish_copy_session(&txn, id, XpFilter::Everyone)
            .await
            .unwrap();
        txn.commit().await.unwrap();
        assert_eq!(state, SplitSyncState::Synced);
        let effects = row_effects(&db, id, split_id).await;
        assert_eq!(effects.xp_rows.len(), 3);
        assert_eq!(effects.split_status, "pending");

        let (live, _) = seed_event(&db, &fx, "live", false).await;
        let txn = db.begin().await.unwrap();
        let error = service
            .finish_copy_session(&txn, live, XpFilter::Everyone)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::Conflict(_)));
    }

    #[tokio::test]
    async fn wrappers_and_after_commit_without_propagation_are_inert() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, _) = seed_event(&db, &fx, "scheduled", false).await;
        let done = EventService::new()
            .transition(&db, id, Transition::Start, Cause::Web, None)
            .await
            .unwrap();
        assert_eq!(done.view.status, "live");
        done.outcome
            .after_commit(&AfterCommit::default())
            .await
            .unwrap();
    }

    // --- Discord effects (DO-3a) -------------------------------------------

    /// `(id, kind, entity_id, payload, state, cause)` of every outbox row, in id order.
    async fn outbox(db: &DatabaseConnection) -> Vec<(i64, String, i64, String, String, String)> {
        use sea_orm::{DbBackend, Statement};
        db.query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT id, kind, entity_id, payload, state, cause FROM discord_outbox ORDER BY id"
                .to_owned(),
        ))
        .await
        .expect("read outbox")
        .iter()
        .map(|row| {
            (
                row.try_get::<i64>("", "id").expect("id"),
                row.try_get::<String>("", "kind").expect("kind"),
                row.try_get::<i64>("", "entity_id").expect("entity_id"),
                row.try_get::<String>("", "payload").expect("payload"),
                row.try_get::<String>("", "state").expect("state"),
                row.try_get::<String>("", "cause").expect("cause"),
            )
        })
        .collect()
    }

    /// `(kind, payload)` of the rows an outcome wrote, in the order it wrote them.
    async fn written(
        db: &DatabaseConnection,
        outcome: &TransitionOutcome,
    ) -> Vec<(String, String)> {
        let rows = outbox(db).await;
        outcome
            .effects
            .iter()
            .map(|effect| {
                let row = rows
                    .iter()
                    .find(|row| row.0 == effect.id)
                    .expect("effect row exists");
                assert_eq!(row.1, effect.kind);
                (row.1.clone(), row.3.clone())
            })
            .collect()
    }

    /// The effect kinds each transition writes, in DO §5.2 order.
    fn expected_kinds(transition: Transition) -> Vec<&'static str> {
        match transition {
            Transition::Start => vec![
                EffectKind::EventStart.as_str(),
                EffectKind::EventUpsert.as_str(),
                EffectKind::CalendarSync.as_str(),
            ],
            Transition::Stop { .. } | Transition::Cancel => vec![
                EffectKind::EventClose.as_str(),
                EffectKind::VoiceRelease.as_str(),
                EffectKind::CalendarSync.as_str(),
            ],
            Transition::Uncancel | Transition::Unarchive => vec![
                EffectKind::EventUpsert.as_str(),
                EffectKind::CalendarSync.as_str(),
            ],
            Transition::Archive => vec![
                EffectKind::EventRemove.as_str(),
                EffectKind::CalendarSync.as_str(),
            ],
        }
    }

    #[tokio::test]
    async fn every_cause_writes_the_same_effects_for_every_transition() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        for (transition, from, archived, _) in transition_cases() {
            let mut baseline: Option<Vec<(String, String)>> = None;
            for cause in every_cause() {
                let (event_id, _) = seed_event(&db, &fx, from, archived).await;
                let outcome = run(&db, event_id, transition, cause).await.unwrap();
                let effects = written(&db, &outcome).await;
                let kinds: Vec<&str> = effects.iter().map(|(kind, _)| kind.as_str()).collect();
                assert_eq!(
                    kinds,
                    expected_kinds(transition),
                    "{transition:?} from {from}"
                );
                match &baseline {
                    None => baseline = Some(effects),
                    Some(first) => assert_eq!(
                        &effects, first,
                        "{transition:?} from {from}: {cause:?} differs from the first cause"
                    ),
                }
            }
        }
    }

    #[tokio::test]
    async fn repeated_stop_and_cancel_write_no_new_effects() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let stop = Transition::Stop {
            auto: false,
            xp: XpFilter::Everyone,
        };

        let (id, _) = seed_event(&db, &fx, "live", false).await;
        let first = run(&db, id, stop, Cause::Web).await.unwrap();
        assert!(!first.effects.is_empty());
        let before = outbox(&db).await;
        let again = run(&db, id, stop, Cause::Discord).await.unwrap();
        assert!(!again.changed);
        assert!(again.effects.is_empty() && again.wake.is_empty());
        assert_eq!(outbox(&db).await, before);

        let (id, _) = seed_event(&db, &fx, "scheduled", false).await;
        run(&db, id, Transition::Cancel, Cause::Web).await.unwrap();
        let before = outbox(&db).await;
        let again = run(&db, id, Transition::Cancel, Cause::Web).await.unwrap();
        assert!(!again.changed && again.effects.is_empty());
        assert_eq!(outbox(&db).await, before);
    }

    #[tokio::test]
    async fn start_on_a_live_event_conflicts_and_writes_no_effect() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, _) = seed_event(&db, &fx, "live", false).await;
        let before = outbox(&db).await;
        let error = run(&db, id, Transition::Start, Cause::Web)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::Conflict(_)), "{error:?}");
        assert_eq!(outbox(&db).await, before);
    }

    #[tokio::test]
    async fn start_stamps_the_reminders_and_keeps_an_earlier_mass_stamp() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, _) = seed_event(&db, &fx, "scheduled", false).await;
        let earlier: chrono::DateTime<chrono::FixedOffset> =
            (Utc::now() - chrono::Duration::days(1)).into();
        event::ActiveModel {
            id: Set(id),
            mass_notified_at: Set(Some(earlier)),
            ..Default::default()
        }
        .update(&db)
        .await
        .unwrap();

        let outcome = run(&db, id, Transition::Start, Cause::Web).await.unwrap();
        let model = event::Entity::find_by_id(id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(model.mass_notified_at, Some(earlier));
        assert!(model.reminder_notified_at.is_some());

        let kinds: Vec<String> = written(&db, &outcome)
            .await
            .into_iter()
            .map(|(kind, _)| kind)
            .collect();
        assert_eq!(kinds[0], "event.start");
        let start_row = outbox(&db)
            .await
            .into_iter()
            .find(|row| row.0 == outcome.effects[0].id)
            .unwrap();
        assert_eq!(start_row.4, "pending", "a new start is due");
    }

    #[tokio::test]
    async fn close_payload_names_how_the_session_ended() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, _) = seed_event(&db, &fx, "live", false).await;
        let manual = run(
            &db,
            id,
            Transition::Stop {
                auto: false,
                xp: XpFilter::Everyone,
            },
            Cause::Web,
        )
        .await
        .unwrap();
        assert_eq!(
            written(&db, &manual).await[0],
            (
                "event.close".to_owned(),
                r#"{"reason":"stopped"}"#.to_owned()
            )
        );

        let (id, _) = seed_event(&db, &fx, "live", false).await;
        let auto = run(
            &db,
            id,
            Transition::Stop {
                auto: true,
                xp: XpFilter::Everyone,
            },
            Cause::Scheduler,
        )
        .await
        .unwrap();
        assert_eq!(
            written(&db, &auto).await[0].1,
            r#"{"reason":"auto_stopped"}"#
        );

        let (id, _) = seed_event(&db, &fx, "scheduled", false).await;
        let cancelled = run(&db, id, Transition::Cancel, Cause::Web).await.unwrap();
        assert_eq!(
            written(&db, &cancelled).await[0].1,
            r#"{"reason":"cancelled"}"#
        );
    }

    #[tokio::test]
    async fn archive_tears_down_the_vod_post_and_voice_only_when_bound() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, _) = seed_event(&db, &fx, "stopped", false).await;
        event::ActiveModel {
            id: Set(id),
            vod_forum_thread_id: Set(Some("777".to_owned())),
            discord_voice_channel_id: Set(Some("888".to_owned())),
            ..Default::default()
        }
        .update(&db)
        .await
        .unwrap();
        let bound = run(&db, id, Transition::Archive, Cause::Web).await.unwrap();
        let kinds: Vec<String> = written(&db, &bound)
            .await
            .into_iter()
            .map(|(kind, _)| kind)
            .collect();
        assert_eq!(
            kinds,
            [
                "event.remove",
                "vod.delete",
                "voice.release",
                "calendar.sync"
            ]
        );

        let (plain, _) = seed_event(&db, &fx, "stopped", false).await;
        let unbound = run(&db, plain, Transition::Archive, Cause::Web)
            .await
            .unwrap();
        let kinds: Vec<String> = written(&db, &unbound)
            .await
            .into_iter()
            .map(|(kind, _)| kind)
            .collect();
        assert_eq!(kinds, ["event.remove", "calendar.sync"]);
    }

    #[tokio::test]
    async fn uncancel_rearms_the_stamps_only_when_the_event_is_still_ahead() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        for ahead in [true, false] {
            let (id, _) = seed_event(&db, &fx, "cancelled", false).await;
            let when: chrono::DateTime<chrono::FixedOffset> = if ahead {
                Utc::now() + chrono::Duration::days(2)
            } else {
                Utc::now() - chrono::Duration::days(2)
            }
            .into();
            let stamp: chrono::DateTime<chrono::FixedOffset> = Utc::now().into();
            event::ActiveModel {
                id: Set(id),
                start_time_utc: Set(Some(when)),
                mass_notified_at: Set(Some(stamp)),
                reminder_notified_at: Set(Some(stamp)),
                ..Default::default()
            }
            .update(&db)
            .await
            .unwrap();

            run(&db, id, Transition::Uncancel, Cause::Web)
                .await
                .unwrap();
            let model = event::Entity::find_by_id(id)
                .one(&db)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(model.mass_notified_at.is_none(), ahead, "ahead={ahead}");
            assert_eq!(model.reminder_notified_at.is_none(), ahead, "ahead={ahead}");
        }
    }

    #[tokio::test]
    async fn calendar_sync_is_debounced_by_five_seconds() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, _) = seed_event(&db, &fx, "scheduled", false).await;
        let before = Utc::now();
        let outcome = run(&db, id, Transition::Cancel, Cause::Web).await.unwrap();
        let calendar = outcome
            .effects
            .iter()
            .find(|effect| effect.kind == "calendar.sync")
            .expect("cancel rebuilds the calendar");
        let row = crate::discord_delivery::outbox::get(&db, calendar.id)
            .await
            .unwrap()
            .unwrap();
        let delay = row.available_at - before;
        assert!(
            delay >= chrono::Duration::seconds(CALENDAR_DEBOUNCE_SECS)
                && delay < chrono::Duration::seconds(CALENDAR_DEBOUNCE_SECS + 5),
            "available {delay:?} after the transition"
        );
    }

    #[tokio::test]
    async fn manual_reminder_is_one_effect_per_minute() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, _) = seed_event(&db, &fx, "scheduled", false).await;
        let first = emit_manual_reminder(&db, id).await.unwrap();
        let second = emit_manual_reminder(&db, id).await.unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].kind, "event.reminder");
        assert_eq!(second, first, "the same minute coalesces into one row");
        let rows = outbox(&db).await;
        let reminder = rows.iter().find(|row| row.0 == first[0].id).unwrap();
        assert_eq!(reminder.5, "manual");
    }

    #[tokio::test]
    async fn moving_a_schedule_into_the_future_rearms_the_stamps() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (id, _) = seed_event(&db, &fx, "scheduled", false).await;
        let stamp: chrono::DateTime<chrono::FixedOffset> = Utc::now().into();
        event::ActiveModel {
            id: Set(id),
            mass_notified_at: Set(Some(stamp)),
            reminder_notified_at: Set(Some(stamp)),
            ..Default::default()
        }
        .update(&db)
        .await
        .unwrap();

        let rename: crate::modules::events::models::UpdateEventRequest =
            serde_json::from_value(serde_json::json!({ "title": "renamed" })).unwrap();
        EventService::new()
            .update_event(&db, id, rename)
            .await
            .unwrap();
        let model = event::Entity::find_by_id(id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert!(
            model.mass_notified_at.is_some(),
            "unchanged times keep stamps"
        );

        let moved = (Utc::now() + chrono::Duration::days(3)).to_rfc3339();
        let postpone: crate::modules::events::models::UpdateEventRequest =
            serde_json::from_value(serde_json::json!({ "start_time_utc": moved })).unwrap();
        EventService::new()
            .update_event(&db, id, postpone)
            .await
            .unwrap();
        let model = event::Entity::find_by_id(id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert!(model.mass_notified_at.is_none());
        assert!(model.reminder_notified_at.is_none());
    }

    // --- Postgres ---------------------------------------------------------

    /// Runs `scenario` on a fresh Postgres tenant schema; skipped without `TEST_DATABASE_URL`.
    async fn on_postgres<F, Fut>(prefix: &str, scenario: F)
    where
        F: FnOnce(DatabaseConnection) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        use crate::postgres::{
            connect_with_search_path, drop_schema, ensure_schema,
            test_support::{try_admin_db, unique_schema},
        };
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema(prefix);
        ensure_schema(&admin, &schema).await.expect("create schema");
        let db = connect_with_search_path(&url, &schema)
            .await
            .expect("connect schema");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("tenant migrations");
        scenario(db.clone()).await;
        db.close().await.expect("close tenant DB");
        drop_schema(&admin, &schema).await.expect("drop schema");
    }

    #[tokio::test]
    async fn stop_is_idempotent_on_postgres() {
        on_postgres("tx_idem", |db| async move {
            assert_stop_is_idempotent(&db).await;
        })
        .await;
    }

    #[tokio::test]
    async fn split_sync_failure_keeps_the_stop_on_postgres() {
        // On Postgres a failed statement aborts the whole transaction unless it ran in a
        // savepoint, so this is the test that proves the savepoint is doing its job.
        on_postgres("tx_split", |db| async move {
            assert_split_sync_failure_keeps_the_stop(&db).await;
        })
        .await;
    }

    #[tokio::test]
    async fn transition_table_holds_on_postgres() {
        on_postgres("tx_table", |db| async move {
            let fx = fixture(&db).await;
            for (transition, from, archived, expected_status) in transition_cases() {
                let (id, split_id) = seed_event(&db, &fx, from, archived).await;
                let outcome = run(&db, id, transition, Cause::Scheduler).await.unwrap();
                assert!(outcome.changed);
                assert_eq!(row_effects(&db, id, split_id).await.status, expected_status);
            }
        })
        .await;
    }

    #[tokio::test]
    async fn cancelling_an_event_releases_its_awaiting_splits_and_uncancel_re_awaits_them() {
        let db = sqlite_db().await;
        let fx = fixture(&db).await;
        let (event_id, split_id) = seed_event(&db, &fx, "scheduled", false).await;
        let split_status = |db: DatabaseConnection| async move {
            split::Entity::find_by_id(split_id)
                .one(&db)
                .await
                .unwrap()
                .unwrap()
                .status
        };

        run(&db, event_id, Transition::Cancel, Cause::Web)
            .await
            .unwrap();
        assert_eq!(split_status(db.clone()).await, "pending");

        run(&db, event_id, Transition::Uncancel, Cause::Web)
            .await
            .unwrap();
        assert_eq!(split_status(db.clone()).await, "awaiting_event");
    }
}
