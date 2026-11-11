//! Evaluation, descriptors and execution of actions (shared-actions §3.2-3.4).
//!
//! [`evaluate`] is pure: it answers "may this actor run this action on this entity now" with
//! the first failing check, in the documented order. [`execute`] is the only place that locks
//! the entity, applies the transition, writes the `action_log` row and runs the post-commit
//! work. Effects and sync outbox rows are not written here yet (SA-4b and the outbox slices).

use std::collections::HashSet;

use sea_orm::{DatabaseConnection, EntityTrait, QuerySelect, TransactionTrait};
use serde_json::{Value, json};

use super::action_log::{self, MAX_PARAMS_BYTES, NewRow};
use super::entities::event as event_def;
use super::model::{
    ActionDef, ActionDescriptor, ActionList, ActionResult, Authority, ConfirmBody, EntityRef, Noop,
    OriginRule, StateChange, Transport,
};
use crate::errors::AppError;
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::modules::capabilities::catalogue;
use crate::modules::events::entities::event as event_entity;
use crate::modules::events::{
    lifecycle::{
        AfterCommit, Cause, Transition, TransitionOutcome, WakeSet, XpFilter, transition_in_txn,
    },
    service::EventService,
};
use crate::modules::sync::copy_role::CopyRole;
use crate::sync_origin::OriginRef;

/// What the engine knows about one entity at one moment.
#[derive(Debug, Clone, PartialEq)]
pub struct Facts {
    /// Entity id.
    pub id: i64,
    /// Current status (`events.status`).
    pub state: String,
    /// Whether the entity is archived.
    pub archived: bool,
    /// Creator, for the creator-or-permission authority.
    pub creator_id: i64,
    /// Role in synchronization.
    pub copy: CopyRole,
    /// Origin of an active or detached copy.
    pub origin: Option<OriginRef>,
    /// Revision token (`e-{id}-{micros}`).
    pub etag: String,
}

impl Facts {
    /// Builds the facts of a loaded row.
    #[must_use]
    pub fn from_model(
        model: &event_entity::Model,
        copy: CopyRole,
        origin: Option<OriginRef>,
    ) -> Self {
        Self {
            id: model.id,
            state: model.status.clone(),
            archived: model.archived_at.is_some(),
            creator_id: model.created_by,
            copy,
            origin,
            etag: format!("e-{}-{}", model.id, model.updated_at.timestamp_micros()),
        }
    }
}

/// Who is asking.
#[derive(Debug, Clone, PartialEq)]
pub struct Actor {
    /// Local user id.
    pub user_id: i64,
    /// Discord id, recorded as the actor of the lifecycle transition.
    pub discord_id: Option<String>,
    /// Permissions the actor holds in this tenant (implications already applied).
    pub granted: HashSet<Permission>,
    /// Whether the entity's module is offered to this tenant kind.
    pub module_available: bool,
}

/// Permissions the event actions consult. `events.manage` is the administrator override on events
/// the actor did not create; `events.edit` / `events.delete` only ever cover the actor's own.
const EVENT_PERMISSIONS: [Permission; 2] = [Permission::EventsView, Permission::EventsManage];

/// Builds the actor for a request in the current tenant.
pub async fn actor_for(user: &UserContext, perms: &Permissions, tenant_kind: &str) -> Actor {
    let mut granted = HashSet::new();
    for permission in EVENT_PERMISSIONS {
        if user.has_permission(perms, permission).await {
            granted.insert(permission);
        }
    }
    Actor {
        user_id: user.user_id,
        discord_id: Some(user.id.clone()),
        granted,
        module_available: catalogue::module("events")
            .is_none_or(|module| module.supports_kind(tenant_kind)),
    }
}

/// A refused check: why, and whether the client should show the action disabled.
#[derive(Debug, Clone, PartialEq)]
pub struct Denial {
    /// Machine reason.
    pub reason_code: &'static str,
    /// HTTP status of the refusal.
    pub status: u16,
    /// Show the action disabled (true) or hide it (false).
    pub visible: bool,
    /// English default text.
    pub reason: String,
    /// Values for the text.
    pub params: Value,
}

/// Outcome of [`evaluate`].
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// The action may run.
    Allowed,
    /// The first failing check.
    Denied(Denial),
}

fn denied(
    reason_code: &'static str,
    status: u16,
    visible: bool,
    reason: String,
    params: Value,
) -> Verdict {
    Verdict::Denied(Denial {
        reason_code,
        status,
        visible,
        reason,
        params,
    })
}

/// True when the request is a no-op success for this entity.
#[must_use]
pub fn is_noop(def: &ActionDef, facts: &Facts) -> bool {
    match def.noop {
        Noop::Never => false,
        Noop::InStates(states) => states.contains(&facts.state.as_str()),
        Noop::Archived(value) => facts.archived == value,
    }
}

/// Checks the action against the entity, in the order of shared-actions §3.2:
/// module, origin, authority, archived, state.
#[must_use]
pub fn evaluate(def: &ActionDef, facts: &Facts, actor: &Actor) -> Verdict {
    if !actor.module_available {
        return denied(
            "module_unavailable",
            403,
            false,
            format!(
                "The {} module is not available for this tenant kind.",
                def.module
            ),
            json!({ "module": def.module }),
        );
    }
    if !actor.granted.contains(&Permission::EventsView) {
        return denied(
            "permission_missing",
            403,
            false,
            format!(
                "You need {} to use this event.",
                Permission::EventsView.as_str()
            ),
            json!({ "permission": Permission::EventsView.as_str() }),
        );
    }
    if def.origin == OriginRule::OwnerOnly && facts.copy.is_read_only() {
        let reason = facts.origin.as_ref().map_or_else(
            || "This event is a synchronized copy; manage it from its owner tenant.".to_owned(),
            OriginRef::summary,
        );
        return denied(
            "copy_read_only",
            403,
            true,
            reason,
            json!({ "origin": facts.origin }),
        );
    }
    if let Authority::CreatorOr(permission) = def.authority {
        let allowed = facts.creator_id == actor.user_id || actor.granted.contains(&permission);
        if !allowed {
            return denied(
                "not_creator_or_manager",
                403,
                false,
                format!(
                    "Only the creator or a user with {} can do this.",
                    permission.as_str()
                ),
                json!({ "permission": permission.as_str() }),
            );
        }
    }
    if facts.archived && !def.archived_ok {
        return denied(
            "archived",
            409,
            true,
            "This event is archived; restore it first.".to_owned(),
            json!({}),
        );
    }
    if !is_noop(def, facts) && !def.from.is_empty() && !def.from.contains(&facts.state.as_str()) {
        return denied(
            "wrong_state",
            409,
            true,
            format!(
                "This event is {}, so {} is not available.",
                facts.state, def.id
            ),
            json!({ "state": facts.state, "allowed": def.from }),
        );
    }
    Verdict::Allowed
}

/// One action evaluated for the entity: the descriptor clients render.
#[must_use]
pub fn describe_one(def: &ActionDef, facts: &Facts, actor: &Actor) -> ActionDescriptor {
    let (allowed, visible, reason_code, reason, reason_params) = match evaluate(def, facts, actor) {
        Verdict::Allowed => (true, true, None, None, None),
        Verdict::Denied(denial) => (
            false,
            denial.visible,
            Some(denial.reason_code.to_owned()),
            Some(denial.reason),
            Some(denial.params),
        ),
    };
    ActionDescriptor {
        id: def.id.to_owned(),
        label_key: def.label_key.to_owned(),
        style: def.style,
        group: def.group.to_owned(),
        allowed,
        visible: visible && def.implemented,
        reason_code,
        reason,
        reason_params,
        requires_confirm: def.confirm.is_some(),
        confirm: def.confirm.map(|spec| ConfirmBody {
            title_key: spec.title_key.to_owned(),
            body_key: spec.body_key.to_owned(),
        }),
        params_schema: None,
        transport: match def.transport {
            Transport::Action => "action",
            Transport::Direct { .. } => "direct",
        }
        .to_owned(),
    }
}

/// [`describe_one`] for every action in `defs`.
#[must_use]
pub fn describe(defs: &[ActionDef], facts: &Facts, actor: &Actor) -> Vec<ActionDescriptor> {
    defs.iter()
        .map(|def| describe_one(def, facts, actor))
        .collect()
}

/// The action list of one event.
#[must_use]
pub fn event_action_list(facts: &Facts, actor: &Actor) -> ActionList {
    ActionList {
        entity: EntityRef {
            kind: "event".to_owned(),
            id: Some(facts.id),
            state: Some(facts.state.clone()),
            archived: Some(facts.archived),
        },
        etag: Some(facts.etag.clone()),
        actions: describe(event_def::DEFS, facts, actor),
    }
}

/// The action list of the events collection (no collection actions are registered yet).
#[must_use]
pub fn event_collection_list() -> ActionList {
    ActionList {
        entity: EntityRef {
            kind: "event".to_owned(),
            id: None,
            state: None,
            archived: None,
        },
        etag: None,
        actions: Vec::new(),
    }
}

/// Loads the facts of one event (the copy role comes from the control plane).
///
/// # Errors
///
/// [`AppError::NotFound`] for an unknown event, [`AppError::Database`] otherwise.
pub async fn load_event_facts(
    db: &DatabaseConnection,
    control: &DatabaseConnection,
    tenant_id: &str,
    id: i64,
) -> Result<Facts, AppError> {
    let model = event_entity::Entity::find_by_id(id)
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Event {id} not found")))?;
    let (copy, origin) = event_def::copy_of(db, control, tenant_id, id).await?;
    Ok(Facts::from_model(&model, copy, origin))
}

/// Where an action runs: the tenant database, the control plane and the tenant id.
pub struct Target<'a> {
    /// Tenant database.
    pub db: &'a DatabaseConnection,
    /// Control-plane database (copy links).
    pub control: &'a DatabaseConnection,
    /// Tenant id.
    pub tenant_id: &'a str,
}

/// One execution request.
pub struct Request<'a> {
    /// Action id.
    pub action: &'a str,
    /// Revision the caller saw, if any.
    pub expected_etag: Option<&'a str>,
    /// Idempotency key, if any.
    pub idempotency_key: Option<&'a str>,
    /// Parameters, if any (stored truncated in the log).
    pub params: Option<&'a Value>,
}

/// Why an execution did not return a result.
#[derive(Debug)]
pub enum Failure {
    /// Refused; `entry` is the descriptor the caller must see (the response body).
    Denied {
        /// HTTP status (403 or 409).
        status: u16,
        /// The denied descriptor.
        entry: Box<ActionDescriptor>,
    },
    /// The caller's revision is stale; the fresh list goes back.
    Stale(Box<ActionList>),
    /// Anything else.
    Error(AppError),
}

impl From<AppError> for Failure {
    fn from(error: AppError) -> Self {
        Self::Error(error)
    }
}

fn channel_of(cause: Cause) -> &'static str {
    match cause {
        Cause::Web => "web",
        Cause::Discord => "discord",
        _ => "system",
    }
}

fn truncated_params(params: Option<&Value>) -> Option<String> {
    params.map(|value| {
        let text = value.to_string();
        if text.len() <= MAX_PARAMS_BYTES {
            text
        } else {
            let mut end = MAX_PARAMS_BYTES;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text[..end].to_owned()
        }
    })
}

/// Builds the response of an executed or replayed action from the committed rows.
async fn finish(
    target: &Target<'_>,
    actor: &Actor,
    def: &ActionDef,
    event_id: i64,
    outcome: &str,
    from: &str,
    to: &str,
) -> Result<ActionResult, AppError> {
    let model = event_entity::Entity::find_by_id(event_id)
        .one(target.db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
    let view = EventService::new().to_event_view(target.db, model).await?;
    let facts = load_event_facts(target.db, target.control, target.tenant_id, event_id).await?;
    Ok(ActionResult {
        action: def.id.to_owned(),
        outcome: outcome.to_owned(),
        state: StateChange {
            from: from.to_owned(),
            to: to.to_owned(),
        },
        entity: serde_json::to_value(view)
            .map_err(|error| AppError::Internal(error.to_string()))?,
        actions: describe(event_def::DEFS, &facts, actor),
        effects: Vec::new(),
        sync: None,
    })
}

/// Runs one action on one event.
///
/// Order: idempotent replay (no re-check, the first answer stands), pre-check without locks,
/// then one transaction that locks the row, re-checks the revision and the verdict under the
/// lock, and either writes a no-op log row or applies the transition and its log row. The
/// action log row and the transition commit together; a failure rolls both back. After commit,
/// completion-XP retry and legacy copy propagation run as the old routes did.
///
/// # Errors
///
/// [`Failure::Denied`] for a refused check, [`Failure::Stale`] for an outdated revision,
/// [`Failure::Error`] for unknown actions, not-yet-executable actions and database failures.
#[allow(
    clippy::too_many_lines,
    reason = "one linear transaction: replay, pre-check, lock, log and commit read best in order"
)]
pub async fn execute(
    target: &Target<'_>,
    actor: &Actor,
    event_id: i64,
    request: &Request<'_>,
    cause: Cause,
    after: &AfterCommit<'_>,
) -> Result<ActionResult, Failure> {
    let def = event_def::find_def(request.action)
        .ok_or_else(|| AppError::NotFound(format!("Unknown event action {}", request.action)))?;
    if !def.implemented || def.transport != Transport::Action {
        return Err(AppError::Validation(format!(
            "{} is not available through this endpoint yet",
            def.id
        ))
        .into());
    }

    let replay = match request.idempotency_key {
        Some(key) => action_log::find_replay(target.db, actor.user_id, def.id, key).await?,
        None => None,
    };
    if let Some(previous) = replay {
        return Ok(finish(
            target,
            actor,
            def,
            event_id,
            "applied",
            &previous.from_state.unwrap_or_default(),
            &previous.to_state.unwrap_or_default(),
        )
        .await?);
    }

    let pre = load_event_facts(target.db, target.control, target.tenant_id, event_id).await?;
    if request.expected_etag.is_some_and(|etag| etag != pre.etag) {
        return Err(Failure::Stale(Box::new(event_action_list(&pre, actor))));
    }
    if let Verdict::Denied(denial) = evaluate(def, &pre, actor) {
        return Err(Failure::Denied {
            status: denial.status,
            entry: Box::new(describe_one(def, &pre, actor)),
        });
    }

    let txn = target.db.begin().await.map_err(AppError::Database)?;
    let model = event_entity::Entity::find_by_id(event_id)
        .lock_exclusive()
        .one(&txn)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?;
    // A concurrent identical request may have applied while this one waited for the lock; its
    // row is visible now, so the first answer stands and nothing else runs.
    if let Some(key) = request.idempotency_key {
        match action_log::find_replay(&txn, actor.user_id, def.id, key).await {
            Ok(Some(previous)) => {
                let _ = txn.rollback().await;
                return Ok(finish(
                    target,
                    actor,
                    def,
                    event_id,
                    "applied",
                    &previous.from_state.unwrap_or_default(),
                    &previous.to_state.unwrap_or_default(),
                )
                .await?);
            }
            Ok(None) => {}
            Err(error) => {
                let _ = txn.rollback().await;
                return Err(error.into());
            }
        }
    }
    let facts = Facts::from_model(&model, pre.copy, pre.origin.clone());
    if request.expected_etag.is_some_and(|etag| etag != facts.etag) {
        let _ = txn.rollback().await;
        return Err(Failure::Stale(Box::new(event_action_list(&facts, actor))));
    }
    if let Verdict::Denied(denial) = evaluate(def, &facts, actor) {
        let _ = txn.rollback().await;
        return Err(Failure::Denied {
            status: denial.status,
            entry: Box::new(describe_one(def, &facts, actor)),
        });
    }

    let xp = XpFilter::from_award_xp(!facts.copy.is_copy());
    let Some(transition) = event_def::transition_for(def.id, xp) else {
        let _ = txn.rollback().await;
        return Err(AppError::Internal(format!("no transition for {}", def.id)).into());
    };
    // A no-op writes no status. A stop still goes through the transition core, which resyncs a
    // stale split roster on a repeated stop; other no-ops take an unchanged outcome so the
    // post-commit work below runs for them too, as the legacy routes did.
    let applied = if is_noop(def, &facts) && !matches!(transition, Transition::Stop { .. }) {
        Ok(TransitionOutcome {
            model: model.clone(),
            transition,
            cause,
            changed: false,
            splits: None,
            effects: Vec::new(),
            sync_outbox_id: None,
            wake: WakeSet::default(),
        })
    } else {
        transition_in_txn(
            &txn,
            event_id,
            transition,
            cause,
            actor.discord_id.as_deref(),
        )
        .await
    };
    let outcome = match applied {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = txn.rollback().await;
            return Err(error.into());
        }
    };
    let to = outcome.model.status.clone();
    let label = if outcome.changed { "applied" } else { "noop" };
    let logged = action_log::insert(
        &txn,
        NewRow {
            entity_type: "event",
            entity_id: event_id,
            action: def.id,
            actor_user_id: actor.user_id,
            channel: channel_of(cause),
            idempotency_key: request.idempotency_key,
            from_state: &facts.state,
            to_state: &to,
            outcome: label,
            params: truncated_params(request.params),
        },
    )
    .await;
    if let Err(error) = logged {
        let _ = txn.rollback().await;
        return Err(error.into());
    }
    txn.commit().await.map_err(AppError::Database)?;

    if matches!(outcome.transition, Transition::Stop { .. }) {
        EventService::new()
            .retry_event_completion_xp(target.db, event_id)
            .await?;
    }
    outcome.after_commit(after).await?;
    Ok(finish(target, actor, def, event_id, label, &facts.state, &to).await?)
}
