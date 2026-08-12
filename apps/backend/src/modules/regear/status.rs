//! Lifecycle status of a regear death row.
//!
//! Stored in the database as its lowercase string form (see [`FromStr`] / [`fmt::Display`]),
//! since the `regear_deaths.status` column is a plain string rather than a native DB enum.
//! `Approved` and `Rejected` are terminal — once reached, no further transition is permitted.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The lifecycle status of a regear death row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum RegearStatus {
    /// Extraction complete; the victim may request regear.
    Available,
    /// The victim has requested regear; awaiting officer decision.
    Pending,
    /// Officer accepted; a bank transaction has been credited. Terminal.
    Approved,
    /// Officer rejected; the death can never be re-requested. Terminal.
    Rejected,
}

impl RegearStatus {
    /// Lowercase stable string persisted in the DB.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }

    /// `true` for `Approved` and `Rejected` (no further transition allowed).
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Approved | Self::Rejected)
    }
}

impl fmt::Display for RegearStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for RegearStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "available" => Ok(Self::Available),
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "rejected" => Ok(Self::Rejected),
            other => Err(format!("unknown regear status: {other}")),
        }
    }
}
