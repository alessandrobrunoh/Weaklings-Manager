//! XP source tags persisted on `progression_xp_ledger.source`.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Why a ledger row was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum XpSource {
    /// One Discord guild message (after cooldown / min-length).
    Message,
    /// The user created a guild event.
    EventCreate,
    /// The user joined a guild event roster.
    EventJoin,
    /// The user was still on the roster when the event stopped.
    EventComplete,
    /// A VOD review URL claimed via `/vod`.
    Vod,
    /// An officer added, subtracted, or set XP/level by hand.
    AdminAdjust,
}

impl XpSource {
    /// Stable lowercase key stored in the ledger.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::EventCreate => "event_create",
            Self::EventJoin => "event_join",
            Self::EventComplete => "event_complete",
            Self::Vod => "vod",
            Self::AdminAdjust => "admin_adjust",
        }
    }
}

impl fmt::Display for XpSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for XpSource {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "message" => Ok(Self::Message),
            "event_create" => Ok(Self::EventCreate),
            "event_join" => Ok(Self::EventJoin),
            "event_complete" => Ok(Self::EventComplete),
            "vod" => Ok(Self::Vod),
            "admin_adjust" => Ok(Self::AdminAdjust),
            other => Err(format!("unknown xp source: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_roundtrips() {
        for source in [
            XpSource::Message,
            XpSource::EventCreate,
            XpSource::EventJoin,
            XpSource::EventComplete,
            XpSource::Vod,
            XpSource::AdminAdjust,
        ] {
            assert_eq!(XpSource::from_str(source.as_str()).unwrap(), source);
        }
    }
}
