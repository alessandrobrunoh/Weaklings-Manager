//! Warn severity tags persisted on `user_warns.severity`.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// How serious a warn row is. All non-revoked rows count toward the escalation threshold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WarnSeverity {
    /// Informal note. Still counts toward the threshold.
    Note,
    /// Standard warning.
    #[default]
    Warn,
    /// Highest severity short of a kick.
    Strike,
}

impl WarnSeverity {
    /// Stable lowercase key stored in the database.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Warn => "warn",
            Self::Strike => "strike",
        }
    }
}

impl fmt::Display for WarnSeverity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for WarnSeverity {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "note" => Ok(Self::Note),
            "warn" => Ok(Self::Warn),
            "strike" => Ok(Self::Strike),
            other => Err(format!("unknown warn severity: {other}")),
        }
    }
}
