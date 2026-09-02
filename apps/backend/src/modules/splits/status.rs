//! The loot-split lifecycle status.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The lifecycle status of a loot split.
///
/// Stored in the database as its lowercase/snake_case string form (see [`FromStr`]/
/// [`fmt::Display`]), since the `splits.status` column is a plain string rather than a native
/// DB enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SplitStatus {
    /// Requested with its participants; awaiting an officer to close it out.
    Pending,
    /// Linked to an event that has not finished yet; payout is blocked until it ends.
    AwaitingEvent,
    /// An officer distributed the loot; Guild Bank transactions have been generated.
    Completed,
    /// An officer marked the split as not completed (no transactions generated). Terminal.
    NotCompleted,
    /// The loot was lost/never recovered (no transactions generated). Terminal.
    Lost,
}

impl SplitStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::AwaitingEvent => "awaiting_event",
            Self::Completed => "completed",
            Self::NotCompleted => "not_completed",
            Self::Lost => "lost",
        }
    }
}

impl fmt::Display for SplitStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for SplitStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pending" => Ok(Self::Pending),
            "awaiting_event" => Ok(Self::AwaitingEvent),
            "completed" => Ok(Self::Completed),
            "not_completed" => Ok(Self::NotCompleted),
            "lost" => Ok(Self::Lost),
            other => Err(format!("unknown split status: {other}")),
        }
    }
}
