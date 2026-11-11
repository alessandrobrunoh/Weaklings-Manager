//! Officer and creator roster actions, forwarded to every linked copy of an event.
//!
//! The roster is one roster across an event and its copies. Self-service join and leave are
//! forwarded by [`super::sync::sync_participation`]; this module carries the actions only an
//! officer can take: adding or removing a participant on someone's behalf, seat assignment, clear,
//! swap and auto-fill, and the event's extra roster roles.
//!
//! Every function follows the same contract as `sync_participation`: it runs after the caller's own
//! change is committed, a copy that cannot take the change is logged and skipped instead of failing
//! the call, and the copies that did take it are returned so the caller can notify their viewers.
//!
//! Seat commands are forwarded as *state*, not as commands: after the origin commits, each touched
//! seat is made to hold the same participant on the copy. That is what makes a swap or an
//! auto-fill safe to repeat (replaying a swap command would swap back), and it keeps a copy that
//! had already diverged from compounding the error.

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};

use crate::alliance_share::{
    AllianceShareService, ShareActor, ShareParams,
    models::{ArtifactType, CreateAllianceShareRequest},
};
use crate::events::{
    models::{
        AssignRosterSeatRequest, CreateEventRosterRoleRequest, ParticipateEventRequest,
        RosterVersionRequest,
    },
    parties::party_id_at_position,
    service::EventService,
    sync::{linked_event_peers, map_build, sync_participation},
};
use backend_core::errors::AppError;
use backend_combat::seats::EventSeatKey;
use backend_entities::events::{event, event_party, event_roster_assignment, event_roster_role};
use backend_entities::users as user_entities;
use backend_identity::tenant::TenantRegistry;
use backend_identity::users::identity::{upsert_discord_user, user_id_for_discord_id};
use backend_runtime::sync::event_links::canonical_event_origin;

/// How a roster role changed on the event the officer edited.
pub enum RosterRoleChange {
    /// An extra role for this build was added to the party at `party_position`.
    Added { build_id: i64, party_position: i32 },
    /// The extra role for this build was removed from the party at `party_position`.
    Removed { build_id: i64, party_position: i32 },
}

/// Forwards an officer adding, changing or removing a participant.
///
/// `request` is the new signup, or `None` when the participant was removed. The participant is
/// identified on the copies by Discord id, exactly as a self-service signup would be, so this is
/// the participation sync run on behalf of the target member.
///
/// A member without a Discord id cannot be matched on another tenant and is left alone.
pub async fn sync_officer_participation(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    db: &DatabaseConnection,
    tenant_id: &str,
    event_id: i64,
    target_user_id: i64,
    request: Option<ParticipateEventRequest>,
) -> Result<Vec<(String, i64)>, AppError> {
    let target = user_entities::Entity::find_by_id(target_user_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("User {target_user_id} not found")))?;
    let Some(discord_id) = target.discord_id.filter(|id| !id.trim().is_empty()) else {
        tracing::warn!(
            tenant_id,
            event_id,
            target_user_id,
            "participant has no Discord id and cannot be matched on the linked events"
        );
        return Ok(Vec::new());
    };
    let actor = ShareActor {
        discord_id,
        username: target.username,
        email: Some(target.email).filter(|email| !email.trim().is_empty()),
    };
    sync_participation(control, registry, tenant_id, event_id, &actor, request).await
}

/// Seat key `party:{party_id}:build:{build_id}:{ordinal}` with the party and build ids passed
/// through `map`.
///
/// Seat keys name a party and a build by tenant-local ids, so a key cannot be copied to another
/// tenant as is. `map` receives `(party_id, build_id)` and returns the copy's pair, or `None` when
/// the copy has no counterpart. Returns `None` for a key that does not have that shape.
fn translate_seat_key(
    seat_key: &str,
    map: impl FnOnce(i64, i64) -> Option<(i64, i64)>,
) -> Option<String> {
    let parsed = EventSeatKey::parse(seat_key)?;
    let (party_id, build_id) = map(parsed.party_id, parsed.build_id)?;
    Some(
        EventSeatKey {
            party_id,
            build_id,
            ordinal: parsed.ordinal,
        }
        .render(),
    )
}

/// The party of `peer_event_id` standing where `source_party_id` stands on the edited event.
///
/// Copies keep a single party, so only the first party's seats have a counterpart. Parties are
/// matched by position because their ids are tenant-local.
async fn peer_party_id(
    source: &DatabaseConnection,
    peer: &DatabaseConnection,
    peer_event_id: i64,
    source_party_id: i64,
) -> Result<Option<i64>, AppError> {
    let Some(position) = event_party::Entity::find_by_id(source_party_id)
        .one(source)
        .await?
        .map(|party| party.position)
    else {
        return Ok(None);
    };
    Ok(event_party::Entity::find()
        .filter(event_party::Column::EventId.eq(peer_event_id))
        .filter(event_party::Column::Position.eq(position))
        .one(peer)
        .await?
        .map(|party| party.id))
}

/// Who holds one touched seat on the edited event, by Discord id.
struct SeatState {
    seat_key: String,
    occupant: Option<String>,
}

async fn read_seat_states(
    db: &DatabaseConnection,
    event_id: i64,
    seat_keys: &[String],
) -> Result<Vec<SeatState>, AppError> {
    let mut states: Vec<SeatState> = Vec::with_capacity(seat_keys.len());
    for seat_key in seat_keys {
        if states.iter().any(|state| &state.seat_key == seat_key) {
            continue;
        }
        let assignment = event_roster_assignment::Entity::find()
            .filter(event_roster_assignment::Column::EventId.eq(event_id))
            .filter(event_roster_assignment::Column::SeatKey.eq(seat_key.as_str()))
            .one(db)
            .await?;
        let occupant = match assignment {
            None => None,
            Some(assignment) => {
                let discord_id = user_entities::Entity::find_by_id(assignment.user_id)
                    .one(db)
                    .await?
                    .and_then(|user| user.discord_id)
                    .filter(|id| !id.trim().is_empty());
                if discord_id.is_none() {
                    // Not matchable on another tenant; leave that seat alone rather than empty it.
                    tracing::warn!(
                        event_id,
                        %seat_key,
                        user_id = assignment.user_id,
                        "seated participant has no Discord id; seat not copied"
                    );
                    continue;
                }
                discord_id
            }
        };
        states.push(SeatState {
            seat_key: seat_key.clone(),
            occupant,
        });
    }
    Ok(states)
}

async fn roster_version(db: &DatabaseConnection, event_id: i64) -> Result<i64, AppError> {
    Ok(event::Entity::find_by_id(event_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))?
        .roster_version)
}

async fn held(
    db: &DatabaseConnection,
    event_id: i64,
    seat_key: &str,
) -> Result<Option<event_roster_assignment::Model>, AppError> {
    Ok(event_roster_assignment::Entity::find()
        .filter(event_roster_assignment::Column::EventId.eq(event_id))
        .filter(event_roster_assignment::Column::SeatKey.eq(seat_key))
        .one(db)
        .await?)
}

/// Makes `seat_keys` on one copy hold the same participants as on the edited event.
#[allow(clippy::too_many_arguments)]
async fn sync_seats_to_peer(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    tenant_id: &str,
    peer_tenant: &str,
    peer_id: i64,
    actor: &ShareActor,
    states: &[SeatState],
    (origin_tenant, origin_event): (&str, i64),
) -> Result<(), AppError> {
    let peer = registry.get_or_load(peer_tenant).await?;
    let current = registry.get_or_load(tenant_id).await?;
    let assigned_by = upsert_discord_user(
        &peer.db,
        &actor.discord_id,
        &actor.username,
        actor.email.as_deref().unwrap_or(""),
        "User",
        false,
    )
    .await?;
    // Translate every key up front so a seat the copy cannot represent fails before any write.
    let mut wanted: Vec<(String, Option<i64>)> = Vec::with_capacity(states.len());
    for state in states {
        let parsed = EventSeatKey::parse(&state.seat_key).ok_or_else(|| {
            AppError::Validation(format!("seat {} has no counterpart", state.seat_key))
        })?;
        let peer_party = peer_party_id(&current.db, &peer.db, peer_id, parsed.party_id)
            .await?
            .ok_or_else(|| {
                AppError::Validation(format!("seat {} has no counterpart", state.seat_key))
            })?;
        let build_id = Some(parsed.build_id);
        let mapped = map_build(
            control,
            tenant_id,
            peer_tenant,
            build_id,
            origin_tenant,
            origin_event,
        )
        .await?;
        let peer_key = translate_seat_key(&state.seat_key, |_, _| {
            mapped.map(|build| (peer_party, build))
        })
        .ok_or_else(|| {
            AppError::Validation(format!("seat {} has no counterpart", state.seat_key))
        })?;
        let occupant = match &state.occupant {
            None => None,
            Some(discord_id) => Some(
                user_id_for_discord_id(&peer.db, discord_id)
                    .await?
                    .ok_or_else(|| {
                        AppError::NotFound(format!(
                            "participant {discord_id} is not on the linked event"
                        ))
                    })?,
            ),
        };
        wanted.push((peer_key, occupant));
    }

    let service = EventService::new();
    // Empty seats first: a participant moving between seats is then never held in two places.
    for (seat_key, _) in wanted.iter().filter(|(_, occupant)| occupant.is_none()) {
        if held(&peer.db, peer_id, seat_key).await?.is_none() {
            continue;
        }
        service
            .clear_roster_seat(
                &peer.db,
                peer_id,
                seat_key,
                RosterVersionRequest {
                    expected_roster_version: roster_version(&peer.db, peer_id).await?,
                    strategy: None,
                },
            )
            .await?;
    }
    for (seat_key, occupant) in &wanted {
        let Some(user_id) = occupant else { continue };
        if held(&peer.db, peer_id, seat_key)
            .await?
            .is_some_and(|assignment| assignment.user_id == *user_id)
        {
            continue;
        }
        service
            .assign_roster_seat(
                &peer.db,
                peer_id,
                seat_key,
                AssignRosterSeatRequest {
                    user_id: *user_id,
                    expected_roster_version: roster_version(&peer.db, peer_id).await?,
                },
                assigned_by,
            )
            .await?;
    }
    Ok(())
}

/// Forwards seat assign, clear, swap and auto-fill to every linked copy.
///
/// `seat_keys` are the seats the officer's command touched on the edited event; each is read back
/// from that event and reproduced on the copies, with the build in the key mapped to the copy's
/// own build. Returns the copies that now match.
pub async fn sync_roster_seats(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    tenant_id: &str,
    event_id: i64,
    actor: &ShareActor,
    seat_keys: &[String],
) -> Result<Vec<(String, i64)>, AppError> {
    let peers = linked_event_peers(control, tenant_id, event_id).await?;
    if peers.is_empty() || seat_keys.is_empty() {
        return Ok(Vec::new());
    }
    let origin = canonical_event_origin(control, tenant_id, event_id).await?;
    let current = registry.get_or_load(tenant_id).await?;
    let states = read_seat_states(&current.db, event_id, seat_keys).await?;
    let mut synced = Vec::with_capacity(peers.len());
    for (peer_tenant, peer_id) in peers {
        match sync_seats_to_peer(
            control,
            registry,
            tenant_id,
            &peer_tenant,
            peer_id,
            actor,
            &states,
            (&origin.0, origin.1),
        )
        .await
        {
            Ok(()) => synced.push((peer_tenant, peer_id)),
            Err(error) => tracing::error!(
                tenant_id = %tenant_id,
                event_id,
                peer_tenant = %peer_tenant,
                peer_event_id = peer_id,
                %error,
                "roster seats were saved but could not be copied to the linked event"
            ),
        }
    }
    Ok(synced)
}

/// Maps a build for a copy, publishing it to the alliance first when a guild event's new role
/// build was never shared (the same publish `create_mirror` does for the roles it starts with).
async fn map_role_build(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    tenant_id: &str,
    peer_tenant: &str,
    build_id: i64,
    actor: &ShareActor,
    (origin_tenant, origin_event): (&str, i64),
) -> Result<i64, AppError> {
    let first = map_build(
        control,
        tenant_id,
        peer_tenant,
        Some(build_id),
        origin_tenant,
        origin_event,
    )
    .await;
    let error = match first {
        Ok(mapped) => return mapped.ok_or_else(missing_build),
        Err(error) => error,
    };
    let current = registry.get_or_load(tenant_id).await?;
    if !matches!(error, AppError::Validation(_))
        || tenant_id != origin_tenant
        || current.kind != "guild"
    {
        return Err(error);
    }
    AllianceShareService::share_build(
        control,
        registry,
        &current.db,
        ShareParams {
            source_tenant_id: tenant_id,
            source_kind: "guild",
            actor,
            authorized: true,
        },
        CreateAllianceShareRequest {
            artifact_type: ArtifactType::Build,
            id: build_id,
        },
    )
    .await?;
    map_build(
        control,
        tenant_id,
        peer_tenant,
        Some(build_id),
        origin_tenant,
        origin_event,
    )
    .await?
    .ok_or_else(missing_build)
}

fn missing_build() -> AppError {
    AppError::Validation("The selected build is not shared with the linked event".to_owned())
}

async fn sync_role_change_to_peer(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    tenant_id: &str,
    (peer_tenant, peer_id): (&str, i64),
    actor: &ShareActor,
    change: &RosterRoleChange,
    origin: (&str, i64),
) -> Result<(), AppError> {
    let peer = registry.get_or_load(peer_tenant).await?;
    let service = EventService::new();
    match *change {
        RosterRoleChange::Added {
            build_id,
            party_position,
        } => {
            // Copies keep a single party: a role on any other party has no counterpart.
            let Some(peer_party) = party_id_at_position(&peer.db, peer_id, party_position).await?
            else {
                return Ok(());
            };
            let mapped = map_role_build(
                control,
                registry,
                tenant_id,
                peer_tenant,
                build_id,
                actor,
                origin,
            )
            .await?;
            match service
                .create_event_roster_role(
                    &peer.db,
                    peer_id,
                    CreateEventRosterRoleRequest {
                        build_id: mapped,
                        party_id: Some(peer_party),
                    },
                )
                .await
            {
                // Already there: a repeat of the same change.
                Ok(_) | Err(AppError::Conflict(_)) => Ok(()),
                Err(error) => Err(error),
            }
        }
        RosterRoleChange::Removed {
            build_id,
            party_position,
        } => {
            if party_id_at_position(&peer.db, peer_id, party_position)
                .await?
                .is_none()
            {
                return Ok(());
            }
            let Some(mapped) = map_build(
                control,
                tenant_id,
                peer_tenant,
                Some(build_id),
                origin.0,
                origin.1,
            )
            .await?
            else {
                return Ok(());
            };
            let role = event_roster_role::Entity::find()
                .filter(event_roster_role::Column::EventId.eq(peer_id))
                .filter(event_roster_role::Column::BuildId.eq(mapped))
                .one(&peer.db)
                .await?;
            match role {
                // Never added, or already removed.
                None => Ok(()),
                Some(role) => service
                    .delete_event_roster_role(&peer.db, peer_id, role.id)
                    .await
                    .or_else(|error| match error {
                        AppError::NotFound(_) => Ok(()),
                        other => Err(other),
                    }),
            }
        }
    }
}

/// Forwards an extra roster role being added or removed to every linked copy.
///
/// Roles are per-event rows holding a tenant-local build id, so the copy gets its own row for its
/// own copy of the build. Returns the copies that now match.
pub async fn sync_roster_role(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    tenant_id: &str,
    event_id: i64,
    actor: &ShareActor,
    change: RosterRoleChange,
) -> Result<Vec<(String, i64)>, AppError> {
    let peers = linked_event_peers(control, tenant_id, event_id).await?;
    if peers.is_empty() {
        return Ok(Vec::new());
    }
    let origin = canonical_event_origin(control, tenant_id, event_id).await?;
    let mut synced = Vec::with_capacity(peers.len());
    for (peer_tenant, peer_id) in peers {
        match sync_role_change_to_peer(
            control,
            registry,
            tenant_id,
            (&peer_tenant, peer_id),
            actor,
            &change,
            (&origin.0, origin.1),
        )
        .await
        {
            Ok(()) => synced.push((peer_tenant, peer_id)),
            Err(error) => tracing::error!(
                tenant_id = %tenant_id,
                event_id,
                peer_tenant = %peer_tenant,
                peer_event_id = peer_id,
                %error,
                "roster role was saved but could not be copied to the linked event"
            ),
        }
    }
    Ok(synced)
}

#[cfg(test)]
mod tests {
    use super::translate_seat_key;

    #[test]
    fn seat_keys_are_rewritten_to_the_copys_party_and_build() {
        assert_eq!(
            translate_seat_key("party:2:build:7:3", |party, build| Some((
                party + 10,
                build + 100
            ))),
            Some("party:12:build:107:3".to_owned())
        );
        assert_eq!(translate_seat_key("party:2:build:7:3", |_, _| None), None);
        for malformed in [
            "",
            "build:7:3",
            "party:2",
            "party:x:build:7:1",
            "party:2:role:7:1",
            "party:2:build:7:1:9",
        ] {
            assert_eq!(
                translate_seat_key(malformed, |party, build| Some((party, build))),
                None,
                "{malformed}"
            );
        }
    }
}
