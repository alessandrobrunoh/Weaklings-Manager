//! Lifecycle of a guild giveaway.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Status persisted on `giveaways.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum GiveawayStatus {
    /// Accepting Discord entries.
    Open,
    /// A winner has been drawn.
    Drawn,
    /// An officer cancelled before the draw.
    Cancelled,
    /// The deadline elapsed with nobody entered.
    ExpiredEmpty,
}

impl GiveawayStatus {
    /// Stable lowercase key stored in the database.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Drawn => "drawn",
            Self::Cancelled => "cancelled",
            Self::ExpiredEmpty => "expired_empty",
        }
    }

    /// True when entries and a later draw are no longer allowed.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Open)
    }
}

impl fmt::Display for GiveawayStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for GiveawayStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "open" => Ok(Self::Open),
            "drawn" => Ok(Self::Drawn),
            "cancelled" => Ok(Self::Cancelled),
            "expired_empty" => Ok(Self::ExpiredEmpty),
            other => Err(format!("unknown giveaway status: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::GiveawayStatus;

    #[test]
    fn round_trips() {
        for status in [
            GiveawayStatus::Open,
            GiveawayStatus::Drawn,
            GiveawayStatus::Cancelled,
            GiveawayStatus::ExpiredEmpty,
        ] {
            assert_eq!(status.as_str().parse::<GiveawayStatus>().unwrap(), status);
        }
    }
}
