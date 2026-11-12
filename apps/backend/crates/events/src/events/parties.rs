//! Parties of an organized event: one comp per party, and the single seat derivation every
//! roster read and write goes through.
//!
//! An event has an ordered list of parties (`event_parties`). Its seats are the parties' seats in
//! order: each party contributes its comp's seats followed by its own extra roster roles, keyed
//! `party:{party_id}:build:{build_id}:{n}` where `n` counts that build's seats inside the party.
//! Keys therefore survive reordering parties, renaming them, and changing a party's comp whenever
//! the seat's build and ordinal still exist.
//!
//! Board party numbers (the "Party 3" shown on the roster board) are derived, not stored: every
//! event party starts on a fresh board number and spans `ceil(seats / 20)` of them.
//!
//! An event with exactly one party keeps the 75% comp-variant auto-resolution; with two or more
//! parties every party uses its stored comp.

use std::collections::{BTreeMap, HashMap, HashSet};

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DatabaseTransaction,
    EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, Set, TransactionTrait,
};

use backend_combat::seats::{EventSeatKey, canonical_comp_seats, main_weapon_keys};
use backend_core::errors::AppError;
use backend_entities::comps::comp;
use backend_entities::events::{
    event, event_participation, event_party, event_roster_assignment, event_roster_role,
};

use super::models::{
    CreateEventPartyRequest, EventPartyRoleCount, EventPartyView, EventRosterSeatView,
    ReorderEventPartiesRequest, UpdateEventPartyRequest,
};
use super::service::{EventService, load_builds_by_id, load_extra_roster_roles};

/// Seats on one board party.
const BOARD_PARTY_SIZE: usize = 20;

/// Longest party label, matching the `event_parties.name` column.
const PARTY_NAME_MAX_CHARS: usize = 64;

/// Roles in the order party summaries list them.
const ROLE_ORDER: [&str; 6] = [
    "tank",
    "healer",
    "support",
    "dps",
    "brawler",
    "battle_mount",
];

/// One party with the seats it currently has.
pub(super) struct PartyLayout {
    /// The stored party row.
    pub party: event_party::Model,
    /// The comp whose seats the party has: the stored comp, or for a single-party event the
    /// variant the 75% rule picked.
    pub active_comp: comp::Model,
    /// Seats the comp itself provides, extra roles excluded.
    pub comp_seat_count: usize,
    /// `(build_id, quantity)` of the comp's own seats, by build id.
    pub comp_builds: Vec<(i64, i32)>,
    /// The party's seats in board order, extra roles last.
    pub seats: Vec<EventRosterSeatView>,
    /// Board party numbers the party spans.
    pub board_party_numbers: Vec<i32>,
}

/// Every seat of an event, grouped by party.
pub(super) struct EventSeatPlan {
    /// Parties in `position` order. Never empty for an organized event.
    pub parties: Vec<PartyLayout>,
}

impl EventSeatPlan {
    /// All seats in roster order.
    pub(super) fn seats(&self) -> impl Iterator<Item = &EventRosterSeatView> {
        self.parties.iter().flat_map(|layout| layout.seats.iter())
    }

    /// The keys of all seats.
    pub(super) fn seat_keys(&self) -> HashSet<String> {
        self.seats().map(|seat| seat.key.clone()).collect()
    }

    /// The effective comp of the first party, which stands in wherever a single comp is shown.
    pub(super) fn first_comp(&self) -> &comp::Model {
        &self.parties[0].active_comp
    }

    /// Seats the parties' comps provide, extra roles excluded.
    pub(super) fn comp_capacity(&self) -> i64 {
        self.parties
            .iter()
            .map(|layout| layout.comp_seat_count as i64)
            .sum()
    }

    /// How many seats, across all parties, are for `build_id`. This is the signup limit of that
    /// build: comp seats plus extra roles.
    pub(super) fn seats_for_build(&self, build_id: i64) -> usize {
        self.seats()
            .filter(|seat| seat.build_id == build_id)
            .count()
    }

    /// Summed `(build_id, quantity)` of every party's comp, by build id.
    pub(super) fn comp_build_totals(&self) -> BTreeMap<i64, i32> {
        let mut totals = BTreeMap::new();
        for layout in &self.parties {
            for (build_id, quantity) in &layout.comp_builds {
                *totals.entry(*build_id).or_insert(0) += *quantity;
            }
        }
        totals
    }

    /// The API summary of each party. `filled` holds the keys of the seats that have someone.
    pub(super) fn party_views(&self, filled: &HashSet<&str>) -> Vec<EventPartyView> {
        self.parties
            .iter()
            .map(|layout| {
                let role_counts = ROLE_ORDER
                    .iter()
                    .filter_map(|role| {
                        let count = layout.seats.iter().filter(|seat| seat.role == *role).count();
                        (count > 0).then(|| EventPartyRoleCount {
                            role: (*role).to_string(),
                            count: count as i32,
                        })
                    })
                    .collect();
                EventPartyView {
                    id: layout.party.id,
                    position: layout.party.position,
                    name: layout.party.name.clone(),
                    comp_id: layout.party.comp_id,
                    active_comp_id: layout.active_comp.id,
                    comp_name: layout.active_comp.name.clone(),
                    seat_count: layout.seats.len() as i32,
                    filled_count: layout
                        .seats
                        .iter()
                        .filter(|seat| filled.contains(seat.key.as_str()))
                        .count() as i32,
                    board_party_numbers: layout.board_party_numbers.clone(),
                    role_counts,
                }
            })
            .collect()
    }
}

/// An event's parties in `position` order.
pub(super) async fn load_event_parties<C: ConnectionTrait>(
    db: &C,
    event_id: i64,
) -> Result<Vec<event_party::Model>, AppError> {
    event_party::Entity::find()
        .filter(event_party::Column::EventId.eq(event_id))
        .order_by_asc(event_party::Column::Position)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Inserts an event's first party, holding the event's comp.
pub(super) async fn insert_first_party<C: ConnectionTrait>(
    db: &C,
    event_id: i64,
    comp_id: i64,
) -> Result<event_party::Model, AppError> {
    event_party::ActiveModel {
        event_id: Set(event_id),
        position: Set(1),
        name: Set(None),
        comp_id: Set(comp_id),
        ..Default::default()
    }
    .insert(db)
    .await
    .map_err(AppError::Database)
}

/// Deletes the assignments whose seat was in `before` but is not in `after`, returning how many
/// members that put back on the waiting list.
pub(super) async fn unseat_missing_seats<C: ConnectionTrait>(
    db: &C,
    event_id: i64,
    before: &HashSet<String>,
    after: &HashSet<String>,
) -> Result<i32, AppError> {
    let missing: Vec<String> = before.difference(after).cloned().collect();
    if missing.is_empty() {
        return Ok(0);
    }
    let deleted = event_roster_assignment::Entity::delete_many()
        .filter(event_roster_assignment::Column::EventId.eq(event_id))
        .filter(event_roster_assignment::Column::SeatKey.is_in(missing))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(i32::try_from(deleted.rows_affected).unwrap_or(i32::MAX))
}

/// Trims a party label; blank clears it. Rejects labels longer than the column.
fn normalize_party_name(name: Option<String>) -> Result<Option<String>, AppError> {
    let Some(name) = name else {
        return Ok(None);
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > PARTY_NAME_MAX_CHARS {
        return Err(AppError::Validation(format!(
            "party name must be at most {PARTY_NAME_MAX_CHARS} characters"
        )));
    }
    Ok(Some(trimmed.to_string()))
}

async fn load_event<C: ConnectionTrait>(db: &C, event_id: i64) -> Result<event::Model, AppError> {
    event::Entity::find_by_id(event_id)
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or_else(|| AppError::NotFound(format!("Event {event_id} not found")))
}

async fn ensure_comp_exists<C: ConnectionTrait>(db: &C, comp_id: i64) -> Result<(), AppError> {
    let exists = comp::Entity::find_by_id(comp_id)
        .count(db)
        .await
        .map_err(AppError::Database)?
        > 0;
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound(format!(
            "Composition {comp_id} not found"
        )))
    }
}

/// Participants who picked a concrete build, which is what grows the comp variant.
pub(super) async fn concrete_signup_count<C: ConnectionTrait>(
    db: &C,
    event_id: i64,
) -> Result<usize, AppError> {
    let count = event_participation::Entity::find()
        .filter(event_participation::Column::EventId.eq(event_id))
        .filter(event_participation::Column::PrimaryBuildId.is_not_null())
        .count(db)
        .await
        .map_err(AppError::Database)?;
    Ok(usize::try_from(count).unwrap_or(usize::MAX))
}

impl EventService {
    /// Derives every seat of an organized event: the single place the seat list is computed.
    ///
    /// `target_size` is the signup count that drives the comp variant of a single-party event;
    /// with two or more parties it is ignored. The cost is a fixed number of statements per
    /// party, never per participant.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Conflict`] for a flash mass, [`AppError::Internal`] when an organized
    /// event has no party, [`AppError::NotFound`] when a comp or build is missing, and
    /// [`AppError::Database`] when a query fails.
    pub(super) async fn seat_plan<C: ConnectionTrait>(
        &self,
        db: &C,
        event_model: &event::Model,
        target_size: usize,
    ) -> Result<EventSeatPlan, AppError> {
        let event_id = event_model.id;
        event_model.organized_comp_id()?;
        let parties = load_event_parties(db, event_id).await?;
        let Some(first_party_id) = parties.first().map(|party| party.id) else {
            return Err(AppError::Internal(format!(
                "Event {event_id} has no parties"
            )));
        };
        let extra_roles = load_extra_roster_roles(db, event_id).await?;

        let effective_comps: Vec<comp::Model> = if parties.len() == 1 {
            let (active, _) = self
                .resolve_active_comp_with_extra_slots(
                    db,
                    parties[0].comp_id,
                    target_size,
                    extra_roles.len(),
                    event_model.player_cap,
                )
                .await?;
            vec![active]
        } else {
            let comps_by_id: HashMap<i64, comp::Model> = comp::Entity::find()
                .filter(comp::Column::Id.is_in(parties.iter().map(|party| party.comp_id)))
                .all(db)
                .await
                .map_err(AppError::Database)?
                .into_iter()
                .map(|comp| (comp.id, comp))
                .collect();
            parties
                .iter()
                .map(|party| {
                    comps_by_id.get(&party.comp_id).cloned().ok_or_else(|| {
                        AppError::NotFound(format!("Composition {} not found", party.comp_id))
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
        };

        // Two statements for every extra role together, none when there are no extra roles.
        let extra_build_ids: Vec<i64> = extra_roles.iter().map(|role| role.build_id).collect();
        let extra_builds = load_builds_by_id(db, extra_build_ids.clone()).await?;
        let extra_weapons = main_weapon_keys(db, &extra_build_ids).await?;

        let mut layouts = Vec::with_capacity(parties.len());
        let mut next_board_number = 1_i32;
        for (party, active_comp) in parties.into_iter().zip(effective_comps) {
            let comp_seats = canonical_comp_seats(db, active_comp.id).await?;
            let comp_seat_count = comp_seats.len();
            let mut ordinals: HashMap<i64, i32> = HashMap::new();
            let mut comp_quantities: BTreeMap<i64, i32> = BTreeMap::new();
            let mut seats = Vec::with_capacity(comp_seat_count);
            for seat in comp_seats {
                let ordinal = ordinals.entry(seat.build_id).or_insert(0);
                *ordinal += 1;
                *comp_quantities.entry(seat.build_id).or_insert(0) += 1;
                seats.push(EventRosterSeatView {
                    key: EventSeatKey {
                        party_id: party.id,
                        build_id: seat.build_id,
                        ordinal: *ordinal,
                    }
                    .render(),
                    party_id: party.id,
                    party_name: party.name.clone(),
                    party_position: party.position,
                    party_number: 0,
                    position: 0,
                    build_id: seat.build_id,
                    build_name: seat.build_name,
                    build_version: seat.build_version,
                    role: seat.role,
                    weapon_key: seat.weapon_key,
                    participant: None,
                });
            }
            for role in extra_roles
                .iter()
                .filter(|role| role.party_id.unwrap_or(first_party_id) == party.id)
            {
                let build = extra_builds.get(&role.build_id).ok_or_else(|| {
                    AppError::NotFound(format!("Build {} not found", role.build_id))
                })?;
                let ordinal = ordinals.entry(role.build_id).or_insert(0);
                *ordinal += 1;
                seats.push(EventRosterSeatView {
                    key: EventSeatKey {
                        party_id: party.id,
                        build_id: role.build_id,
                        ordinal: *ordinal,
                    }
                    .render(),
                    party_id: party.id,
                    party_name: party.name.clone(),
                    party_position: party.position,
                    party_number: 0,
                    position: 0,
                    build_id: role.build_id,
                    build_name: build.name.clone(),
                    build_version: build.version,
                    role: build.role.clone(),
                    weapon_key: extra_weapons.get(&role.build_id).cloned(),
                    participant: None,
                });
            }

            let board_count = seats.len().div_ceil(BOARD_PARTY_SIZE) as i32;
            for (index, seat) in seats.iter_mut().enumerate() {
                seat.party_number = next_board_number + (index / BOARD_PARTY_SIZE) as i32;
                seat.position = (index % BOARD_PARTY_SIZE) as i32 + 1;
            }
            let board_party_numbers = (next_board_number..next_board_number + board_count).collect();
            next_board_number += board_count;

            layouts.push(PartyLayout {
                party,
                active_comp,
                comp_seat_count,
                comp_builds: comp_quantities.into_iter().collect(),
                seats,
                board_party_numbers,
            });
        }
        Ok(EventSeatPlan { parties: layouts })
    }

    /// Adds a party, last in order, built from `comp_id`. Returns the new roster version.
    ///
    /// Going from one party to two ends the single-party variant resolution, so members seated
    /// on a variant-only seat go back to the waiting list.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Conflict`] for a stale roster version or a flash mass,
    /// [`AppError::NotFound`] for a missing event or comp, and [`AppError::Validation`] for an
    /// over-long name.
    pub async fn create_event_party(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        request: CreateEventPartyRequest,
    ) -> Result<i64, AppError> {
        let name = normalize_party_name(request.name)?;
        let txn = db.begin().await.map_err(AppError::Database)?;
        let event_model = load_event(&txn, event_id).await?;
        event_model.organized_comp_id()?;
        ensure_comp_exists(&txn, request.comp_id).await?;
        let version = self
            .advance_roster_version(&txn, event_id, request.expected_roster_version)
            .await?;
        let concrete = concrete_signup_count(&txn, event_id).await?;
        let before = self.seat_plan(&txn, &event_model, concrete).await?;
        let position = before
            .parties
            .last()
            .map_or(1, |layout| layout.party.position + 1);
        let before_keys = before.seat_keys();
        event_party::ActiveModel {
            event_id: Set(event_id),
            position: Set(position),
            name: Set(name),
            comp_id: Set(request.comp_id),
            ..Default::default()
        }
        .insert(&txn)
        .await
        .map_err(AppError::Database)?;
        let after_keys = self
            .seat_plan(&txn, &event_model, concrete)
            .await?
            .seat_keys();
        unseat_missing_seats(&txn, event_id, &before_keys, &after_keys).await?;
        txn.commit().await.map_err(AppError::Database)?;
        Ok(version)
    }

    /// Changes a party's comp and/or label. Returns the new roster version and how many members
    /// lost their seat.
    ///
    /// A member keeps their seat when its build and ordinal still exist in the new comp; the
    /// others go back to the waiting list. Changing the first party's comp also updates the
    /// event's own `comp_id`, which the rest of the product reads.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Validation`] when the request changes nothing,
    /// [`AppError::Conflict`] for a stale roster version, and [`AppError::NotFound`] for a
    /// missing event, party or comp.
    pub async fn update_event_party(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        party_id: i64,
        request: UpdateEventPartyRequest,
    ) -> Result<(i64, i32), AppError> {
        if request.comp_id.is_none() && request.name.is_none() {
            return Err(AppError::Validation(
                "comp_id or name is required".to_string(),
            ));
        }
        let name = request
            .name
            .map(|raw| normalize_party_name(Some(raw)))
            .transpose()?;
        let txn = db.begin().await.map_err(AppError::Database)?;
        let event_model = load_event(&txn, event_id).await?;
        event_model.organized_comp_id()?;
        let party = event_party::Entity::find_by_id(party_id)
            .one(&txn)
            .await
            .map_err(AppError::Database)?
            .filter(|party| party.event_id == event_id)
            .ok_or_else(|| {
                AppError::NotFound(format!("Party {party_id} was not found for event {event_id}"))
            })?;
        if let Some(comp_id) = request.comp_id {
            ensure_comp_exists(&txn, comp_id).await?;
        }
        let version = self
            .advance_roster_version(&txn, event_id, request.expected_roster_version)
            .await?;
        let concrete = concrete_signup_count(&txn, event_id).await?;
        let before_keys = self
            .seat_plan(&txn, &event_model, concrete)
            .await?
            .seat_keys();

        let is_first = party.position == 1;
        let mut active: event_party::ActiveModel = party.into();
        if let Some(comp_id) = request.comp_id {
            active.comp_id = Set(comp_id);
        }
        if let Some(name) = name {
            active.name = Set(name);
        }
        active.update(&txn).await.map_err(AppError::Database)?;
        if let (true, Some(comp_id)) = (is_first, request.comp_id) {
            event::Entity::update_many()
                .col_expr(event::Column::CompId, Expr::value(comp_id))
                .filter(event::Column::Id.eq(event_id))
                .exec(&txn)
                .await
                .map_err(AppError::Database)?;
        }

        let after_keys = self
            .seat_plan(&txn, &event_model, concrete)
            .await?
            .seat_keys();
        let unseated = unseat_missing_seats(&txn, event_id, &before_keys, &after_keys).await?;
        txn.commit().await.map_err(AppError::Database)?;
        Ok((version, unseated))
    }

    /// Removes a party together with its extra roles and seat assignments. Returns the new
    /// roster version and how many members went back to the waiting list.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Conflict`] for the last remaining party or a stale roster version,
    /// and [`AppError::NotFound`] for a missing event or party.
    pub async fn delete_event_party(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        party_id: i64,
        expected_roster_version: i64,
    ) -> Result<(i64, i32), AppError> {
        let txn = db.begin().await.map_err(AppError::Database)?;
        let event_model = load_event(&txn, event_id).await?;
        event_model.organized_comp_id()?;
        let parties = load_event_parties(&txn, event_id).await?;
        let removed = parties
            .iter()
            .find(|party| party.id == party_id)
            .cloned()
            .ok_or_else(|| {
                AppError::NotFound(format!("Party {party_id} was not found for event {event_id}"))
            })?;
        if parties.len() == 1 {
            return Err(AppError::Conflict(
                "an event needs at least one party".to_string(),
            ));
        }
        let version = self
            .advance_roster_version(&txn, event_id, expected_roster_version)
            .await?;
        let concrete = concrete_signup_count(&txn, event_id).await?;
        let before_keys = self
            .seat_plan(&txn, &event_model, concrete)
            .await?
            .seat_keys();

        event_roster_role::Entity::delete_many()
            .filter(event_roster_role::Column::EventId.eq(event_id))
            .filter(event_roster_role::Column::PartyId.eq(party_id))
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
        event_party::Entity::delete_by_id(party_id)
            .exec(&txn)
            .await
            .map_err(AppError::Database)?;
        // Close the gap one row at a time, ascending: the (event, position) index is unique and
        // checked per row.
        for party in parties
            .iter()
            .filter(|party| party.position > removed.position)
        {
            event_party::Entity::update_many()
                .col_expr(event_party::Column::Position, Expr::value(party.position - 1))
                .filter(event_party::Column::Id.eq(party.id))
                .exec(&txn)
                .await
                .map_err(AppError::Database)?;
        }
        // With a single party left its comp is back under the variant rule, so the surviving
        // seat keys can differ from before as well.
        let after_keys = self
            .seat_plan(&txn, &event_model, concrete)
            .await?
            .seat_keys();
        let unseated = unseat_missing_seats(&txn, event_id, &before_keys, &after_keys).await?;
        // The first party's comp is the event's comp.
        let first = load_event_parties(&txn, event_id).await?;
        if let Some(first) = first.first() {
            event::Entity::update_many()
                .col_expr(event::Column::CompId, Expr::value(first.comp_id))
                .filter(event::Column::Id.eq(event_id))
                .exec(&txn)
                .await
                .map_err(AppError::Database)?;
        }
        txn.commit().await.map_err(AppError::Database)?;
        Ok((version, unseated))
    }

    /// Reorders an event's parties. Seat keys embed party ids, so every assignment survives.
    /// Returns the new roster version.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Validation`] when `party_ids` is not exactly the event's party ids,
    /// [`AppError::Conflict`] for a stale roster version, and [`AppError::NotFound`] for a
    /// missing event.
    pub async fn reorder_event_parties(
        &self,
        db: &DatabaseConnection,
        event_id: i64,
        request: ReorderEventPartiesRequest,
    ) -> Result<i64, AppError> {
        let txn = db.begin().await.map_err(AppError::Database)?;
        let event_model = load_event(&txn, event_id).await?;
        event_model.organized_comp_id()?;
        let parties = load_event_parties(&txn, event_id).await?;
        let existing: HashSet<i64> = parties.iter().map(|party| party.id).collect();
        let requested: HashSet<i64> = request.party_ids.iter().copied().collect();
        if requested.len() != request.party_ids.len() || requested != existing {
            return Err(AppError::Validation(
                "party_ids must list every party of the event exactly once".to_string(),
            ));
        }
        let version = self
            .advance_roster_version(&txn, event_id, request.expected_roster_version)
            .await?;
        // Park every row on a negative position first so no intermediate state collides on the
        // unique (event, position) index.
        for (index, party_id) in request.party_ids.iter().enumerate() {
            event_party::Entity::update_many()
                .col_expr(
                    event_party::Column::Position,
                    Expr::value(-(index as i32) - 1),
                )
                .filter(event_party::Column::Id.eq(*party_id))
                .exec(&txn)
                .await
                .map_err(AppError::Database)?;
        }
        for (index, party_id) in request.party_ids.iter().enumerate() {
            event_party::Entity::update_many()
                .col_expr(event_party::Column::Position, Expr::value(index as i32 + 1))
                .filter(event_party::Column::Id.eq(*party_id))
                .exec(&txn)
                .await
                .map_err(AppError::Database)?;
        }
        let first_comp = event_party::Entity::find()
            .filter(event_party::Column::EventId.eq(event_id))
            .filter(event_party::Column::Position.eq(1))
            .one(&txn)
            .await
            .map_err(AppError::Database)?
            .map(|party| party.comp_id);
        if let Some(comp_id) = first_comp {
            event::Entity::update_many()
                .col_expr(event::Column::CompId, Expr::value(comp_id))
                .filter(event::Column::Id.eq(event_id))
                .exec(&txn)
                .await
                .map_err(AppError::Database)?;
        }
        txn.commit().await.map_err(AppError::Database)?;
        Ok(version)
    }

    /// Points the first party at `comp_id` for an event edit that changed `comp_id`: the same
    /// keep-or-unseat rule as [`Self::update_event_party`]. The roster version moves so open
    /// clients refetch. Returns how many members lost their seat.
    pub(super) async fn set_first_party_comp(
        &self,
        txn: &DatabaseTransaction,
        event_model: &event::Model,
        comp_id: i64,
    ) -> Result<i32, AppError> {
        let event_id = event_model.id;
        let concrete = concrete_signup_count(txn, event_id).await?;
        let before_keys = self
            .seat_plan(txn, event_model, concrete)
            .await?
            .seat_keys();
        event_party::Entity::update_many()
            .col_expr(event_party::Column::CompId, Expr::value(comp_id))
            .filter(event_party::Column::EventId.eq(event_id))
            .filter(event_party::Column::Position.eq(1))
            .exec(txn)
            .await
            .map_err(AppError::Database)?;
        let after_keys = self
            .seat_plan(txn, event_model, concrete)
            .await?
            .seat_keys();
        let unseated = unseat_missing_seats(txn, event_id, &before_keys, &after_keys).await?;
        event::Entity::update_many()
            .col_expr(
                event::Column::RosterVersion,
                Expr::col(event::Column::RosterVersion).add(1),
            )
            .filter(event::Column::Id.eq(event_id))
            .exec(txn)
            .await
            .map_err(AppError::Database)?;
        Ok(unseated)
    }
}
