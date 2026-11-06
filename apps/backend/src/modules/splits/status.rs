//! The loot-split lifecycle status.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The lifecycle status of a loot split.
///
/// Stored in the database as its `lowercase/snake_case` string form (see [`FromStr`]/
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

impl SplitStatus {
    /// Still open: the split can still change its participants and its outcome.
    #[must_use]
    pub const fn is_waiting(self) -> bool {
        matches!(self, Self::Pending | Self::AwaitingEvent)
    }

    /// Final outcome reached (`completed`, `not_completed` or `lost`). Never re-synced.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        !self.is_waiting()
    }
}

/// One status-changing split action and the statuses it may start from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitTransition {
    /// Action name (the service and the descriptors use the same names).
    pub action: &'static str,
    /// Statuses the action is allowed from.
    pub from: &'static [SplitStatus],
}

/// The split lifecycle table. Archive and unarchive are flags allowed in every status, so they
/// are not listed.
///
/// `complete` lists `awaiting_event` too, but the service still refuses it until the linked
/// event has ended.
pub const SPLIT_TRANSITIONS: &[SplitTransition] = &[
    SplitTransition {
        action: "update",
        from: &[
            SplitStatus::Pending,
            SplitStatus::AwaitingEvent,
            SplitStatus::Completed,
        ],
    },
    SplitTransition {
        action: "complete",
        from: &[SplitStatus::Pending, SplitStatus::AwaitingEvent],
    },
    SplitTransition {
        action: "not_completed",
        from: &[SplitStatus::Pending, SplitStatus::AwaitingEvent],
    },
    SplitTransition {
        action: "lost",
        from: &[SplitStatus::Pending, SplitStatus::AwaitingEvent],
    },
    SplitTransition {
        action: "recompute",
        from: &[SplitStatus::AwaitingEvent],
    },
];

/// Whether `action` may run on a split in `status`. Unknown actions are never allowed.
#[must_use]
pub fn allows(action: &str, status: SplitStatus) -> bool {
    SPLIT_TRANSITIONS
        .iter()
        .find(|transition| transition.action == action)
        .is_some_and(|transition| transition.from.contains(&status))
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

#[cfg(test)]
mod tests {
    use super::{SplitStatus, allows};

    const ALL: [SplitStatus; 5] = [
        SplitStatus::Pending,
        SplitStatus::AwaitingEvent,
        SplitStatus::Completed,
        SplitStatus::NotCompleted,
        SplitStatus::Lost,
    ];

    #[test]
    fn terminal_statuses_cannot_be_closed_again() {
        for status in ALL {
            assert_ne!(status.is_waiting(), status.is_terminal());
        }
        for action in ["complete", "not_completed", "lost"] {
            assert!(allows(action, SplitStatus::Pending));
            assert!(allows(action, SplitStatus::AwaitingEvent));
            assert!(!allows(action, SplitStatus::Completed));
            assert!(!allows(action, SplitStatus::NotCompleted));
            assert!(!allows(action, SplitStatus::Lost));
        }
    }

    #[test]
    fn only_completed_splits_are_amended_in_place() {
        assert!(allows("update", SplitStatus::Completed));
        assert!(allows("update", SplitStatus::AwaitingEvent));
        assert!(!allows("update", SplitStatus::Lost));
        assert!(!allows("update", SplitStatus::NotCompleted));
    }

    #[test]
    fn recompute_only_moves_awaiting_splits() {
        assert!(allows("recompute", SplitStatus::AwaitingEvent));
        assert!(!allows("recompute", SplitStatus::Pending));
        assert!(!allows("unknown", SplitStatus::Pending));
    }
}
