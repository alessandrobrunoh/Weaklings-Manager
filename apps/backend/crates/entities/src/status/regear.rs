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

/// Where a regear death row came from.
///
/// Stored in the database as its lowercase string form, same convention as [`RegearStatus`].
/// Officers and members can tell the two apart in the UI, but the accept/reject workflow never
/// branches on it — both origins are just `regear_deaths` rows once inserted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RegearSource {
    /// Discovered by the kill-feed extractor from a battle linked to the event.
    Extracted,
    /// Opened by the member themselves, without an extracted death to claim.
    SelfReported,
}

impl RegearSource {
    /// Lowercase stable string persisted in the DB.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Extracted => "extracted",
            Self::SelfReported => "self_reported",
        }
    }
}

impl fmt::Display for RegearSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for RegearSource {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "extracted" => Ok(Self::Extracted),
            "self_reported" => Ok(Self::SelfReported),
            other => Err(format!("unknown regear source: {other}")),
        }
    }
}
