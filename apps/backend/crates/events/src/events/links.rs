//! Creating the link rows other tenants hold for an event they share (see [`super::link_proxy`]).
//!
//! A link carries what a tenant's own Discord delivery needs to announce and list the event:
//! title, description, kind, times and status (kept current by
//! [`super::lifecycle::converge_copy_to_source`]). It has no comp, roster, split or VOD of its
//! own: those live on the origin event, which every request on the link is re-addressed to.

use sea_orm::{ActiveModelTrait, ActiveValue::Set, DatabaseConnection};

use backend_core::errors::AppError;
use backend_entities::events::event;

/// Inserts the link row a tenant holds for `source`, owned by `creator_id` in that tenant.
///
/// `discord_delivery` is the destination tenant's own delivery mode: how a link is announced is
/// that server's choice. A link never requests a VOD post or pings an alliance: both belong to
/// the origin.
///
/// # Errors
///
/// Returns `AppError::Database` when the insert fails.
pub async fn insert_link_row(
    db: &DatabaseConnection,
    creator_id: i64,
    source_tenant_id: &str,
    source: &event::Model,
    discord_delivery: &str,
) -> Result<event::Model, AppError> {
    let delivery = backend_identity::admin::models::normalize_discord_delivery(discord_delivery)
        .map_err(AppError::Validation)?
        .to_string();
    let link = event::ActiveModel {
        title: Set(source.title.clone()),
        description: Set(source.description.clone()),
        call_to_arms: Set(source.call_to_arms),
        regear: Set(source.regear),
        event_kind: Set(source.event_kind.clone()),
        comp_id: Set(None),
        player_cap: Set(source.player_cap),
        created_by: Set(creator_id),
        event_date_utc: Set(source.event_date_utc),
        mass_time_utc: Set(source.mass_time_utc),
        start_time_utc: Set(source.start_time_utc),
        ping_alliance: Set(false),
        discord_delivery: Set(delivery),
        vod_forum_post_enabled: Set(false),
        vod_forum_post_status: Set("not_requested".to_owned()),
        source_tenant_id: Set(Some(source_tenant_id.to_owned())),
        source_event_id: Set(Some(source.id)),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(link)
}
