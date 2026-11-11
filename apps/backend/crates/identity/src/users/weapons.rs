//! Persistence and DTOs for the weapons a member says they can play.
//!
//! A member declares each weapon with a [`WeaponProficiency`]; an officer can additionally *lock*
//! a weapon for a member, who then cannot declare it or sign up with builds of it. Both facts
//! live in one row per `(user, weapon)`: a row with `proficiency = NULL` exists only to carry a
//! lock, and a row that is neither declared nor locked is never stored.
//!
//! The catalog-aware parts (validating a key against the bundled item catalog, resolving display
//! names) live with the routes in `backend_combat::user_weapons`, because the catalog crate
//! depends on this one.

use std::collections::{HashMap, HashSet};

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use backend_core::errors::AppError;

/// A persisted weapon declaration and/or officer lock for one member.
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "user_weapons")]
pub struct Model {
    /// Database row identifier.
    #[sea_orm(primary_key)]
    pub id: i64,
    /// Internal user owning this row.
    pub user_id: i64,
    /// Canonical weapon key, for example `weapon:2H_POLEHAMMER`.
    pub weapon_key: String,
    /// `main`, `good` or `basic`; `NULL` means the member has not declared the weapon and the row
    /// only carries a lock.
    pub proficiency: Option<String>,
    /// Whether an officer locked this weapon for the member.
    pub locked: bool,
    /// Officer that set the lock, when locked.
    pub locked_by_user_id: Option<i64>,
    /// Last update timestamp.
    pub updated_at: DateTimeWithTimeZone,
    /// User that last edited the row.
    pub updated_by_user_id: Option<i64>,
}

/// `user_weapons` has no modelled relations.
#[derive(Copy, Clone, Debug, DeriveRelation, EnumIter)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// How well a member says they play a weapon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WeaponProficiency {
    /// The weapon the member is best on.
    Main,
    /// Comfortable on the weapon.
    Good,
    /// Can play it when needed.
    Basic,
}

impl WeaponProficiency {
    /// The value stored in `user_weapons.proficiency`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Good => "good",
            Self::Basic => "basic",
        }
    }

    /// Parses a stored `user_weapons.proficiency` value.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "main" => Some(Self::Main),
            "good" => Some(Self::Good),
            "basic" => Some(Self::Basic),
            _ => None,
        }
    }

    /// Ordering weight: higher is better (`main` 3, `good` 2, `basic` 1).
    #[must_use]
    pub const fn rank(self) -> u8 {
        match self {
            Self::Main => 3,
            Self::Good => 2,
            Self::Basic => 1,
        }
    }
}

/// One weapon of a member, as returned to clients.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct UserWeaponView {
    /// Canonical weapon key, for example `weapon:2H_POLEHAMMER`.
    pub weapon_key: String,
    /// Tier-less display name resolved from the bundled catalog.
    pub weapon_name: String,
    /// The member's declared level, or `None` when the row only carries an officer lock.
    pub proficiency: Option<WeaponProficiency>,
    /// Whether an officer locked this weapon for the member.
    pub locked: bool,
    /// Last update timestamp.
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: DateTimeWithTimeZone,
}

/// One weapon a member declares.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct DeclareWeaponInput {
    /// Canonical weapon key, for example `weapon:2H_POLEHAMMER`.
    pub weapon_key: String,
    /// How well the member plays it.
    pub proficiency: WeaponProficiency,
}

/// Replaces the caller's declared weapons.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateMyWeaponsRequest {
    /// The complete list of declared weapons. Weapons locked by an officer are left untouched.
    pub weapons: Vec<DeclareWeaponInput>,
}

/// One weapon row an officer sets for a member.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ManageWeaponInput {
    /// Canonical weapon key, for example `weapon:2H_POLEHAMMER`.
    pub weapon_key: String,
    /// The member's declared level, or `None` for "not declared".
    pub proficiency: Option<WeaponProficiency>,
    /// Whether the weapon is locked for the member.
    pub locked: bool,
}

/// Replaces every weapon row of a member, locks included.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ManageUserWeaponsRequest {
    /// The complete list of rows. Entries with no proficiency and no lock are dropped.
    pub weapons: Vec<ManageWeaponInput>,
}

/// What one member's rows say about one weapon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WeaponStanding {
    /// The member's declared level, if any.
    pub proficiency: Option<WeaponProficiency>,
    /// Whether an officer locked the weapon for the member.
    pub locked: bool,
}

/// Every weapon row of one member, indexed by weapon key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserWeaponSet {
    by_key: HashMap<String, WeaponStanding>,
}

impl UserWeaponSet {
    /// Builds a set from stored rows. A row with an unrecognised proficiency counts as undeclared.
    #[must_use]
    pub fn from_rows<'a>(rows: impl IntoIterator<Item = &'a Model>) -> Self {
        let by_key = rows
            .into_iter()
            .map(|row| {
                (
                    row.weapon_key.clone(),
                    WeaponStanding {
                        proficiency: row.proficiency.as_deref().and_then(WeaponProficiency::parse),
                        locked: row.locked,
                    },
                )
            })
            .collect();
        Self { by_key }
    }

    /// Whether the member declared at least one weapon.
    ///
    /// Until they do, self-service signup is not limited to declared weapons.
    #[must_use]
    pub fn has_declarations(&self) -> bool {
        self.by_key
            .values()
            .any(|standing| standing.proficiency.is_some())
    }

    /// Whether an officer locked this weapon for the member.
    #[must_use]
    pub fn is_locked(&self, weapon_key: &str) -> bool {
        self.by_key
            .get(weapon_key)
            .is_some_and(|standing| standing.locked)
    }

    /// The level the member declared for this weapon, if any.
    #[must_use]
    pub fn proficiency(&self, weapon_key: &str) -> Option<WeaponProficiency> {
        self.by_key
            .get(weapon_key)
            .and_then(|standing| standing.proficiency)
    }

    /// Every weapon key the member has a row for, with its standing.
    pub fn iter(&self) -> impl Iterator<Item = (&str, WeaponStanding)> {
        self.by_key
            .iter()
            .map(|(key, standing)| (key.as_str(), *standing))
    }

    /// The weapon keys an officer locked for the member.
    #[must_use]
    pub fn locked_keys(&self) -> HashSet<&str> {
        self.by_key
            .iter()
            .filter(|(_, standing)| standing.locked)
            .map(|(key, _)| key.as_str())
            .collect()
    }
}

/// Loads the weapon rows of several users with one query, grouped by user.
///
/// Users with no rows are absent from the map.
///
/// # Errors
///
/// Returns [`AppError::Database`] when the query fails.
pub async fn load_rows_for_users<C: ConnectionTrait>(
    db: &C,
    user_ids: &[i64],
) -> Result<HashMap<i64, Vec<Model>>, AppError> {
    if user_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = Entity::find()
        .filter(Column::UserId.is_in(user_ids.to_vec()))
        .all(db)
        .await
        .map_err(AppError::Database)?;
    let mut by_user: HashMap<i64, Vec<Model>> = HashMap::new();
    for row in rows {
        by_user.entry(row.user_id).or_default().push(row);
    }
    Ok(by_user)
}

/// Loads the [`UserWeaponSet`] of several users with one query.
///
/// Users with no rows are absent from the map; treat that as an empty set.
///
/// # Errors
///
/// Returns [`AppError::Database`] when the query fails.
pub async fn load_sets_for_users<C: ConnectionTrait>(
    db: &C,
    user_ids: &[i64],
) -> Result<HashMap<i64, UserWeaponSet>, AppError> {
    Ok(load_rows_for_users(db, user_ids)
        .await?
        .into_iter()
        .map(|(user_id, rows)| (user_id, UserWeaponSet::from_rows(&rows)))
        .collect())
}
