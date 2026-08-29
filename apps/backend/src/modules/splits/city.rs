//! Albion cities where a guild island can live.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Royal / island cities that can host a guild island used for loot storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SplitIslandCity {
    /// Lymhurst.
    Lymhurst,
    /// Bridgewatch.
    Bridgewatch,
    /// Martlock.
    Martlock,
    /// Fort Sterling.
    FortSterling,
    /// Thetford.
    Thetford,
    /// Caerleon.
    Caerleon,
    /// Brecilien.
    Brecilien,
}

impl SplitIslandCity {
    /// Stable lowercase key stored in `split_islands.city`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lymhurst => "lymhurst",
            Self::Bridgewatch => "bridgewatch",
            Self::Martlock => "martlock",
            Self::FortSterling => "fort_sterling",
            Self::Thetford => "thetford",
            Self::Caerleon => "caerleon",
            Self::Brecilien => "brecilien",
        }
    }
}

impl fmt::Display for SplitIslandCity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for SplitIslandCity {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "lymhurst" => Ok(Self::Lymhurst),
            "bridgewatch" => Ok(Self::Bridgewatch),
            "martlock" => Ok(Self::Martlock),
            "fort_sterling" => Ok(Self::FortSterling),
            "thetford" => Ok(Self::Thetford),
            "caerleon" => Ok(Self::Caerleon),
            "brecilien" => Ok(Self::Brecilien),
            other => Err(format!("unknown island city: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_every_city() {
        for city in [
            SplitIslandCity::Lymhurst,
            SplitIslandCity::Bridgewatch,
            SplitIslandCity::Martlock,
            SplitIslandCity::FortSterling,
            SplitIslandCity::Thetford,
            SplitIslandCity::Caerleon,
            SplitIslandCity::Brecilien,
        ] {
            assert_eq!(SplitIslandCity::from_str(city.as_str()).unwrap(), city);
        }
    }

    #[test]
    fn rejects_unknown_city() {
        assert!(SplitIslandCity::from_str("narnia").is_err());
    }
}
