//! Event action registry (shared-actions §3.6) and the adapter onto the lifecycle core.
//!
//! The lifecycle actions run through `transition_in_txn`. The rest are listed so clients can
//! render the full action bar, but they stay `implemented: false` (hidden) until their slice
//! (SA-4b and later) gives them an executor.

use sea_orm::{ConnectionTrait, DatabaseConnection};

use crate::errors::AppError;
use crate::modules::actions::model::{
    ActionDef, Authority, ConfirmSpec, Noop, OriginRule, Style, Transport,
};
use crate::modules::auth::Permission;
use crate::modules::events::lifecycle::{Transition, XpFilter};
use crate::modules::sync::copy_role::CopyRole;
use crate::modules::sync::guard::copy_info;
use crate::modules::sync::{LegacyLinks, OriginRef, SyncKind, copy_role};

// Only the creator, or an administrator holding `events.manage`, may run any of these.
const EDIT: Authority = Authority::CreatorOr(Permission::EventsManage);
const DELETE: Authority = Authority::CreatorOr(Permission::EventsManage);
const CANCEL_CONFIRM: ConfirmSpec = ConfirmSpec {
    title_key: "action.event.cancel.confirm.title",
    body_key: "action.event.cancel.confirm.body",
};
const ARCHIVE_CONFIRM: ConfirmSpec = ConfirmSpec {
    title_key: "action.event.archive.confirm.title",
    body_key: "action.event.archive.confirm.body",
};

/// Every event action, in display order.
pub const DEFS: &[ActionDef] = &[
    ActionDef {
        entity: "event",
        id: "start",
        label_key: "action.event.start",
        style: Style::Primary,
        group: "lifecycle",
        module: "events",
        authority: EDIT,
        origin: OriginRule::OwnerOnly,
        from: &["scheduled"],
        to: Some("live"),
        noop: Noop::InStates(&["live"]),
        archived_ok: false,
        confirm: None,
        implemented: true,
        transport: Transport::Action,
    },
    ActionDef {
        entity: "event",
        id: "stop",
        label_key: "action.event.stop",
        style: Style::Neutral,
        group: "lifecycle",
        module: "events",
        authority: EDIT,
        origin: OriginRule::OwnerOnly,
        from: &["live"],
        to: Some("stopped"),
        noop: Noop::InStates(&["stopped", "auto_stopped"]),
        archived_ok: false,
        confirm: None,
        implemented: true,
        transport: Transport::Action,
    },
    ActionDef {
        entity: "event",
        id: "cancel",
        label_key: "action.event.cancel",
        style: Style::Danger,
        group: "lifecycle",
        module: "events",
        authority: EDIT,
        origin: OriginRule::OwnerOnly,
        from: &["scheduled", "live"],
        to: Some("cancelled"),
        noop: Noop::InStates(&["cancelled"]),
        archived_ok: false,
        confirm: Some(CANCEL_CONFIRM),
        implemented: true,
        transport: Transport::Action,
    },
    ActionDef {
        entity: "event",
        id: "uncancel",
        label_key: "action.event.uncancel",
        style: Style::Neutral,
        group: "lifecycle",
        module: "events",
        authority: EDIT,
        origin: OriginRule::OwnerOnly,
        from: &["cancelled"],
        to: Some("scheduled"),
        noop: Noop::Never,
        archived_ok: false,
        confirm: None,
        implemented: true,
        transport: Transport::Action,
    },
    ActionDef {
        entity: "event",
        id: "archive",
        label_key: "action.event.archive",
        style: Style::Danger,
        group: "lifecycle",
        module: "events",
        authority: DELETE,
        origin: OriginRule::OwnerOnly,
        from: &[],
        to: None,
        noop: Noop::Archived(true),
        archived_ok: true,
        confirm: Some(ARCHIVE_CONFIRM),
        implemented: true,
        transport: Transport::Action,
    },
    ActionDef {
        entity: "event",
        id: "unarchive",
        label_key: "action.event.unarchive",
        style: Style::Neutral,
        group: "lifecycle",
        module: "events",
        authority: DELETE,
        origin: OriginRule::OwnerOnly,
        from: &[],
        to: None,
        noop: Noop::Archived(false),
        archived_ok: true,
        confirm: None,
        implemented: true,
        transport: Transport::Action,
    },
    ActionDef {
        entity: "event",
        id: "remind",
        label_key: "action.event.remind",
        style: Style::Neutral,
        group: "notify",
        module: "events",
        authority: EDIT,
        origin: OriginRule::CopyAllowed,
        from: &["scheduled"],
        to: None,
        noop: Noop::Never,
        archived_ok: false,
        confirm: None,
        implemented: false,
        transport: Transport::Action,
    },
    ActionDef {
        entity: "event",
        id: "edit",
        label_key: "action.event.edit",
        style: Style::Neutral,
        group: "content",
        module: "events",
        authority: EDIT,
        origin: OriginRule::OwnerOnly,
        from: &[],
        to: None,
        noop: Noop::Never,
        archived_ok: false,
        confirm: None,
        implemented: false,
        transport: Transport::Action,
    },
    ActionDef {
        entity: "event",
        id: "join",
        label_key: "action.event.join",
        style: Style::Primary,
        group: "roster",
        module: "events",
        authority: Authority::Anyone,
        origin: OriginRule::CopyAllowed,
        from: &["scheduled", "live"],
        to: None,
        noop: Noop::Never,
        archived_ok: false,
        confirm: None,
        implemented: false,
        transport: Transport::Action,
    },
    ActionDef {
        entity: "event",
        id: "leave",
        label_key: "action.event.leave",
        style: Style::Neutral,
        group: "roster",
        module: "events",
        authority: Authority::Anyone,
        origin: OriginRule::CopyAllowed,
        from: &["scheduled", "live"],
        to: None,
        noop: Noop::Never,
        archived_ok: false,
        confirm: None,
        implemented: false,
        transport: Transport::Action,
    },
    ActionDef {
        entity: "event",
        id: "roster_edit",
        label_key: "action.event.roster_edit",
        style: Style::Neutral,
        group: "roster",
        module: "events",
        authority: EDIT,
        origin: OriginRule::OwnerOnly,
        from: &["scheduled", "live"],
        to: None,
        noop: Noop::Never,
        archived_ok: false,
        confirm: None,
        implemented: false,
        transport: Transport::Direct {
            method: "PUT",
            path_template: "/api/events/{id}/roster/seats/{seat}",
        },
    },
    ActionDef {
        entity: "event",
        id: "retry_sync",
        label_key: "action.event.retry_sync",
        style: Style::Neutral,
        group: "sync",
        module: "events",
        authority: EDIT,
        origin: OriginRule::OwnerOnly,
        from: &[],
        to: None,
        noop: Noop::Never,
        archived_ok: false,
        confirm: None,
        implemented: false,
        transport: Transport::Action,
    },
];

/// The registry row for `action`.
#[must_use]
pub fn find_def(action: &str) -> Option<&'static ActionDef> {
    DEFS.iter().find(|def| def.id == action)
}

/// The lifecycle transition an executable action performs; `None` for the rest.
#[must_use]
pub fn transition_for(action: &str, xp: XpFilter) -> Option<Transition> {
    Some(match action {
        "start" => Transition::Start,
        "stop" => Transition::Stop { auto: false, xp },
        "cancel" => Transition::Cancel,
        "uncancel" => Transition::Uncancel,
        "archive" => Transition::Archive,
        "unarchive" => Transition::Unarchive,
        _ => return None,
    })
}

/// Role in synchronization of one event, and the origin when it is a copy.
///
/// # Errors
///
/// [`AppError::Database`] when a lookup fails.
pub async fn copy_of<C: ConnectionTrait>(
    db: &C,
    control: &DatabaseConnection,
    tenant_id: &str,
    id: i64,
) -> Result<(CopyRole, Option<OriginRef>), AppError> {
    let legacy = LegacyLinks { control, tenant_id };
    let role = copy_role(db, legacy, SyncKind::Event, id).await?;
    if !role.is_copy() {
        return Ok((role, None));
    }
    let origin = copy_info(db, legacy, SyncKind::Event, &[id])
        .await?
        .remove(&id)
        .map(|info| info.origin);
    Ok((role, origin))
}
