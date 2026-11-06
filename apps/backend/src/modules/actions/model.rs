//! Static action definitions and the wire types of the action API (shared-actions §3.1-3.3).
//!
//! An [`ActionDef`] is one row of the registry: what an action is called, who may run it, which
//! states it starts from and what it leaves behind. [`ActionDescriptor`] is that row evaluated
//! against one entity for one actor. Clients render descriptors and never re-derive the rules.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::modules::auth::Permission;

/// Visual weight of an action button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    /// The main action of the view.
    Primary,
    /// A regular action.
    Neutral,
    /// Destructive or hard-to-undo action.
    Danger,
}

/// Who may run an action, before origin and state are looked at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authority {
    /// Any member who can see the entity.
    Anyone,
    /// The creator of the entity, or a holder of the permission.
    CreatorOr(Permission),
}

/// Whether the action may run on a read-only synchronized copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginRule {
    /// Only the owning tenant may change the entity.
    OwnerOnly,
    /// Tenant-local effect (for example joining a session from a copy).
    CopyAllowed,
}

/// When a request for an action is a no-op success rather than a state change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Noop {
    /// Never a no-op: the state check decides.
    Never,
    /// A no-op when the entity is already in one of these states.
    InStates(&'static [&'static str]),
    /// A no-op when the archived flag already has this value.
    Archived(bool),
}

/// Confirmation copy shown before the action runs (i18n keys).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfirmSpec {
    /// Key of the dialog title.
    pub title_key: &'static str,
    /// Key of the dialog body.
    pub body_key: &'static str,
}

/// How clients invoke the action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    /// `POST /api/{entity}/{id}/actions/{action}`.
    Action,
    /// A plain REST route kept for high-cardinality operations; listed, not executed here.
    Direct {
        /// HTTP method of the existing route.
        method: &'static str,
        /// Path of the existing route, with its placeholders.
        path_template: &'static str,
    },
}

/// One row of the action registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionDef {
    /// Entity kind the action belongs to (`event`).
    pub entity: &'static str,
    /// Action id (`start`).
    pub id: &'static str,
    /// i18n key of the button label.
    pub label_key: &'static str,
    /// Button style.
    pub style: Style,
    /// Grouping for the action bar (`lifecycle`, `roster`, ...).
    pub group: &'static str,
    /// Catalogue module that must be available to the tenant.
    pub module: &'static str,
    /// Who may run it.
    pub authority: Authority,
    /// Origin rule for synchronized copies.
    pub origin: OriginRule,
    /// Allowed source states; empty means any.
    pub from: &'static [&'static str],
    /// Target state; `None` when the action changes no status.
    pub to: Option<&'static str>,
    /// When the request is a no-op success.
    pub noop: Noop,
    /// Whether the action may run on an archived entity.
    pub archived_ok: bool,
    /// Confirmation the client must show first.
    pub confirm: Option<ConfirmSpec>,
    /// False while the action is listed but not yet executable (hidden by clients).
    pub implemented: bool,
    /// How clients invoke it.
    pub transport: Transport,
}

/// Confirmation keys inside a descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ConfirmBody {
    /// Key of the dialog title.
    pub title_key: String,
    /// Key of the dialog body.
    pub body_key: String,
}

/// One action evaluated for one entity and one actor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ActionDescriptor {
    /// Action id.
    pub id: String,
    /// i18n key of the label.
    pub label_key: String,
    /// Button style.
    pub style: Style,
    /// Action bar group.
    pub group: String,
    /// True when the action can run now.
    pub allowed: bool,
    /// False when clients should hide the action instead of showing it disabled.
    pub visible: bool,
    /// Machine reason when not allowed (`copy_read_only`, `wrong_state`, ...).
    pub reason_code: Option<String>,
    /// English default text of the reason.
    pub reason: Option<String>,
    /// Values for the reason text.
    #[schema(value_type = Option<Object>)]
    pub reason_params: Option<Value>,
    /// True when the client must confirm first.
    pub requires_confirm: bool,
    /// Confirmation keys when `requires_confirm`.
    pub confirm: Option<ConfirmBody>,
    /// JSON Schema of the parameters; `null` for actions without parameters.
    #[schema(value_type = Option<Object>)]
    pub params_schema: Option<Value>,
    /// `action` or `direct`.
    pub transport: String,
}

/// Identity of the entity an action list describes. Collection lists carry no id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct EntityRef {
    /// Entity kind (`event`).
    #[serde(rename = "type")]
    pub kind: String,
    /// Entity id; absent for collection lists.
    pub id: Option<i64>,
    /// Current status; absent for collection lists.
    pub state: Option<String>,
    /// Archived flag; absent for collection lists.
    pub archived: Option<bool>,
}

/// The actions available on one entity (or on a collection) for the caller.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ActionList {
    /// The entity the list is about.
    pub entity: EntityRef,
    /// Revision of the entity; send it back as `expected_etag`. Absent for collections.
    pub etag: Option<String>,
    /// One descriptor per registered action.
    pub actions: Vec<ActionDescriptor>,
}

/// Status change of an executed action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct StateChange {
    /// Status before the action.
    pub from: String,
    /// Status after the action.
    pub to: String,
}

/// Outbox row written for delivery; absent until the outbox slices land.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SyncInfo {
    /// True when a row was queued.
    pub queued: bool,
    /// Queue row id.
    pub outbox_id: Option<i64>,
}

/// Result of an executed (or replayed, or no-op) action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ActionResult {
    /// Action id.
    pub action: String,
    /// `applied` or `noop`.
    pub outcome: String,
    /// Status before and after.
    pub state: StateChange,
    /// The entity as `GET /api/events/{id}` renders it.
    #[schema(value_type = Object)]
    pub entity: Value,
    /// Fresh descriptors, so the caller re-renders without another request.
    pub actions: Vec<ActionDescriptor>,
    /// Effects queued by the action (empty until the Discord outbox lands).
    #[schema(value_type = Vec<Object>)]
    pub effects: Vec<Value>,
    /// Sync outbox information (absent until the sync outbox lands).
    pub sync: Option<SyncInfo>,
}

/// Body of `POST .../actions/{action}`. Every field is optional.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
pub struct ActionRequest {
    /// Action parameters, validated against the action's schema.
    #[serde(default)]
    #[schema(value_type = Option<Object>)]
    pub params: Option<Value>,
    /// Revision the caller saw; a different revision is refused with `stale_entity`.
    #[serde(default)]
    pub expected_etag: Option<String>,
    /// Makes a retried request apply once (also accepted as the `Idempotency-Key` header).
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

/// One entry of `GET /api/actions/catalog`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct CatalogEntry {
    /// Entity kind.
    pub entity: String,
    /// Action id.
    pub id: String,
    /// i18n key of the label.
    pub label_key: String,
    /// Button style.
    pub style: Style,
    /// Action bar group.
    pub group: String,
    /// Catalogue module the action needs.
    pub module: String,
    /// Allowed source states; empty means any.
    pub from: Vec<String>,
    /// Target state, when the action changes status.
    pub to: Option<String>,
    /// `action` or `direct`.
    pub transport: String,
    /// False while listed but not executable.
    pub implemented: bool,
    /// True when the client must confirm first.
    pub requires_confirm: bool,
}

/// `ApiResponse` wrapper for an action list.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseActionList {
    /// Always `success`.
    #[schema(example = "success")]
    pub status: String,
    /// The list.
    pub data: ActionList,
}

/// `ApiResponse` wrapper for an executed action.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseActionResult {
    /// Always `success`.
    #[schema(example = "success")]
    pub status: String,
    /// The result.
    pub data: ActionResult,
}

/// `ApiResponse` wrapper for the catalogue.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseActionCatalog {
    /// Always `success`.
    #[schema(example = "success")]
    pub status: String,
    /// Every registered action.
    pub data: Vec<CatalogEntry>,
}
