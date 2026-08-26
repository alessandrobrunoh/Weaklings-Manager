//! Fixed-in-code enums for the intel module.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Upper bound on enemy headcount for the `Gank` bracket.
pub const GANK_MAX_PLAYERS: i64 = 3;
/// Upper bound on enemy headcount for the `SmallScale` bracket.
pub const SMALL_SCALE_MAX_PLAYERS: i64 = 8;

/// The engagement bracket a scouted composition belongs to.
///
/// Derived purely from enemy headcount, which is crude but stable: it is the
/// one property of a comp that is always observable, even when the kill feed
/// covers only a fraction of the players. Stored as its snake_case string,
/// matching how `builds.role` is persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum IntelScoutCategory {
    /// Three players or fewer.
    Gank,
    /// Four to eight players.
    SmallScale,
    /// More than eight players.
    Zvz,
}

impl IntelScoutCategory {
    /// Stable string form persisted in `scouted_comps.category`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gank => "gank",
            Self::SmallScale => "small_scale",
            Self::Zvz => "zvz",
        }
    }

    /// Human-readable form used when naming a scout.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Gank => "Gank",
            Self::SmallScale => "Small scale",
            Self::Zvz => "ZvZ",
        }
    }

    /// Classifies a composition by how many enemy players it fielded.
    #[must_use]
    pub fn from_player_count(players: i64) -> Self {
        if players <= GANK_MAX_PLAYERS {
            Self::Gank
        } else if players <= SMALL_SCALE_MAX_PLAYERS {
            Self::SmallScale
        } else {
            Self::Zvz
        }
    }
}

impl fmt::Display for IntelScoutCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for IntelScoutCategory {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "gank" => Ok(Self::Gank),
            "small_scale" => Ok(Self::SmallScale),
            "zvz" => Ok(Self::Zvz),
            other => Err(format!("unknown intel scout category: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brackets_split_on_the_documented_boundaries() {
        assert_eq!(
            IntelScoutCategory::from_player_count(1),
            IntelScoutCategory::Gank
        );
        assert_eq!(
            IntelScoutCategory::from_player_count(3),
            IntelScoutCategory::Gank
        );
        assert_eq!(
            IntelScoutCategory::from_player_count(4),
            IntelScoutCategory::SmallScale
        );
        assert_eq!(
            IntelScoutCategory::from_player_count(8),
            IntelScoutCategory::SmallScale
        );
        assert_eq!(
            IntelScoutCategory::from_player_count(9),
            IntelScoutCategory::Zvz
        );
        assert_eq!(
            IntelScoutCategory::from_player_count(40),
            IntelScoutCategory::Zvz
        );
    }

    #[test]
    fn string_form_roundtrips() {
        for category in [
            IntelScoutCategory::Gank,
            IntelScoutCategory::SmallScale,
            IntelScoutCategory::Zvz,
        ] {
            assert_eq!(category.as_str().parse(), Ok(category));
        }
    }

    #[test]
    fn unknown_category_is_rejected() {
        assert!("siege".parse::<IntelScoutCategory>().is_err());
    }
}
