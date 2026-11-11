//! A comp's seat list: its `comp_builds` rows expanded into one ordered seat per build copy.
//!
//! Readiness scores these seats with no event context at all — readiness is a property of the
//! composition, not of any one night's roster — and every event roster view lays its sign-ups
//! over the same list, so both read it from here.

use std::collections::HashMap;

use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter};

use backend_albion_data::openalbion::service::weapon_key_for_stored_item;
use backend_core::errors::AppError;
use backend_entities::comps::{build, build_item, comp_build};
use backend_entities::status::comps::{BuildLoadout, BuildSlot};

/// A parsed event seat key, `party:<party_id>:build:<build_id>:<ordinal>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventSeatKey {
    /// Party that owns the seat.
    pub party_id: i64,
    /// Build the seat is for.
    pub build_id: i64,
    /// 1-based count of that build's seats inside the party.
    pub ordinal: i32,
}

impl EventSeatKey {
    /// Renders the stable key stored in `event_roster_assignments.seat_key`.
    #[must_use]
    pub fn render(&self) -> String {
        format!(
            "party:{}:build:{}:{}",
            self.party_id, self.build_id, self.ordinal
        )
    }

    /// Parses a key written by [`Self::render`]; `None` for anything else, including the
    /// comp-level `build:<id>:<n>` keys readiness uses.
    #[must_use]
    pub fn parse(key: &str) -> Option<Self> {
        let mut parts = key.split(':');
        let (Some("party"), Some(party_id), Some("build"), Some(build_id), Some(ordinal), None) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            return None;
        };
        Some(Self {
            party_id: party_id.parse().ok()?,
            build_id: build_id.parse().ok()?,
            ordinal: ordinal.parse().ok()?,
        })
    }
}

/// One seat of a comp, before anyone is assigned to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompSeat {
    /// Comp-level seat key: `build:<build_id>:<ordinal>`. Event rosters re-key the seat per party
    /// with [`EventSeatKey`]; readiness, which has no event, keeps this form.
    pub key: String,
    /// 1-based party the seat falls in (20 seats per party).
    pub party_number: i32,
    /// 1-based position of the seat inside its party.
    pub position: i32,
    /// Build that fills the seat.
    pub build_id: i64,
    /// Name of that build.
    pub build_name: String,
    /// Version of that build.
    pub build_version: i32,
    /// Role of that build.
    pub role: String,
    /// `weapon:{BASE}` of the main-hand weapon in that build's main loadout, when it has one.
    pub weapon_key: Option<String>,
}

/// Expands a comp's `comp_builds` rows into the flat, ordered seat list every roster view
/// is built from.
///
/// # Errors
///
/// Returns [`AppError::NotFound`] when a `comp_builds` row names a build that does not exist, and
/// [`AppError::Database`] when a query fails.
pub async fn canonical_comp_seats<C: ConnectionTrait>(
    db: &C,
    comp_id: i64,
) -> Result<Vec<CompSeat>, AppError> {
    let mut rows = comp_build::Entity::find()
        .filter(comp_build::Column::CompId.eq(comp_id))
        .all(db)
        .await
        .map_err(AppError::Database)?;
    rows.sort_by_key(|row| row.build_id);
    let build_ids: Vec<i64> = rows.iter().map(|row| row.build_id).collect();
    let builds_by_id = load_builds_by_id(db, build_ids.clone()).await?;
    let weapon_keys = main_weapon_keys(db, &build_ids).await?;
    let mut seats = Vec::new();
    for row in rows {
        let build = builds_by_id
            .get(&row.build_id)
            .ok_or_else(|| AppError::NotFound(format!("Build {} not found", row.build_id)))?;
        for ordinal in 1..=row.quantity {
            let sequential = seats.len() as i32;
            seats.push(CompSeat {
                key: format!("build:{}:{ordinal}", row.build_id),
                party_number: sequential / 20 + 1,
                position: sequential % 20 + 1,
                build_id: row.build_id,
                build_name: build.name.clone(),
                build_version: build.version,
                role: build.role.clone(),
                weapon_key: weapon_keys.get(&row.build_id).cloned(),
            });
        }
    }
    Ok(seats)
}

/// The weapon key (`weapon:2H_POLEHAMMER`) of the weapon slot in each build's main loadout, for
/// the builds that have one, loaded with one query.
///
/// A build's weapon is derived, never stored: it is whatever the main loadout's weapon slot holds,
/// reduced to its tier-less base. Builds without a main-hand weapon (battle mounts) are absent
/// from the map, and are never gated by a member's declared weapons.
///
/// # Errors
///
/// Returns [`AppError::Database`] when the query fails.
pub async fn main_weapon_keys<C: ConnectionTrait>(
    db: &C,
    build_ids: &[i64],
) -> Result<HashMap<i64, String>, AppError> {
    if build_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = build_item::Entity::find()
        .filter(build_item::Column::BuildId.is_in(build_ids.to_vec()))
        .filter(build_item::Column::Loadout.eq(BuildLoadout::Main.as_str()))
        .filter(build_item::Column::Slot.eq(BuildSlot::Weapon.as_str()))
        .all(db)
        .await
        .map_err(AppError::Database)?;
    let mut keys = HashMap::new();
    for row in rows {
        if let Some(key) = weapon_key_for_stored_item(
            row.openalbion_item_id,
            row.openalbion_item_icon.as_deref(),
        ) {
            keys.entry(row.build_id).or_insert(key);
        }
    }
    Ok(keys)
}

/// Loads the builds with the given ids in one query. Missing ids are simply absent from the
/// map; callers decide whether that is an error.
async fn load_builds_by_id<C: ConnectionTrait>(
    db: &C,
    mut build_ids: Vec<i64>,
) -> Result<HashMap<i64, build::Model>, AppError> {
    build_ids.sort_unstable();
    build_ids.dedup();
    if build_ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(build::Entity::find()
        .filter(build::Column::Id.is_in(build_ids))
        .all(db)
        .await
        .map_err(AppError::Database)?
        .into_iter()
        .map(|build| (build.id, build))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::EventSeatKey;

    #[test]
    fn event_seat_keys_round_trip() {
        let key = EventSeatKey {
            party_id: 12,
            build_id: 7,
            ordinal: 3,
        };
        assert_eq!(key.render(), "party:12:build:7:3");
        assert_eq!(EventSeatKey::parse("party:12:build:7:3"), Some(key));
    }

    #[test]
    fn malformed_and_comp_level_keys_do_not_parse() {
        for key in [
            "",
            "build:7:3",
            "party:1:build:7",
            "party:x:build:7:1",
            "party:1:role:7:1",
            "party:1:build:7:1:9",
        ] {
            assert_eq!(EventSeatKey::parse(key), None, "{key}");
        }
    }
}
