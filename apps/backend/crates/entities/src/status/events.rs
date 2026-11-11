//! Event session status and its transition table (shared-actions §4.1).
//!
//! The strings are the values of `events.status`. `archived_at` is a flag that sits
//! beside this table, not a state in it. The action descriptors in
//! `modules::actions::entities::event` must agree with [`EVENT_TRANSITIONS`]; a test
//! pins that.

#![cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "executors read the table in SA-4b; the descriptor matrix test pins it now"
    )
)]

/// Session status of an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventStatus {
    /// Announced, not started.
    Scheduled,
    /// Session running.
    Live,
    /// Session ended by an officer.
    Stopped,
    /// Session ended by the scheduler at its deadline.
    AutoStopped,
    /// Cancelled before or during the session.
    Cancelled,
}

impl EventStatus {
    /// Every status, in declaration order.
    pub const ALL: [Self; 5] = [
        Self::Scheduled,
        Self::Live,
        Self::Stopped,
        Self::AutoStopped,
        Self::Cancelled,
    ];

    /// The value stored in `events.status`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Live => "live",
            Self::Stopped => "stopped",
            Self::AutoStopped => "auto_stopped",
            Self::Cancelled => "cancelled",
        }
    }

    /// Parses a stored status; `None` for anything unknown.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|status| status.as_str() == raw)
    }
}

/// One allowed status change: `action` moves an event from any of `from` to `to`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Edge {
    /// Action id, as in the descriptor registry (`start`, `stop`, ...).
    pub action: &'static str,
    /// States the action may start from.
    pub from: &'static [EventStatus],
    /// State the action leaves the event in.
    pub to: EventStatus,
}

/// Every status change an event can make. Anything not listed is refused.
pub const EVENT_TRANSITIONS: &[Edge] = &[
    Edge {
        action: "start",
        from: &[EventStatus::Scheduled],
        to: EventStatus::Live,
    },
    Edge {
        action: "stop",
        from: &[EventStatus::Live],
        to: EventStatus::Stopped,
    },
    Edge {
        action: "auto_stop",
        from: &[EventStatus::Live],
        to: EventStatus::AutoStopped,
    },
    Edge {
        action: "cancel",
        from: &[EventStatus::Scheduled, EventStatus::Live],
        to: EventStatus::Cancelled,
    },
    Edge {
        action: "uncancel",
        from: &[EventStatus::Cancelled],
        to: EventStatus::Scheduled,
    },
];

/// The table row for `action`, when the action changes status.
#[must_use]
pub fn edge(action: &str) -> Option<&'static Edge> {
    EVENT_TRANSITIONS.iter().find(|edge| edge.action == action)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_status_round_trips_through_its_stored_value() {
        for status in EventStatus::ALL {
            assert_eq!(EventStatus::parse(status.as_str()), Some(status));
        }
        assert_eq!(EventStatus::parse("archived"), None);
    }

    #[test]
    fn stored_values_match_the_lifecycle_writes() {
        let values: Vec<&str> = EventStatus::ALL.iter().map(|s| s.as_str()).collect();
        assert_eq!(
            values,
            ["scheduled", "live", "stopped", "auto_stopped", "cancelled"]
        );
    }

    #[test]
    fn terminal_states_only_leave_through_uncancel() {
        for status in [EventStatus::Stopped, EventStatus::AutoStopped] {
            assert!(
                EVENT_TRANSITIONS.iter().all(|e| !e.from.contains(&status)),
                "{status:?} is terminal for money and sessions"
            );
        }
        for edge in EVENT_TRANSITIONS {
            if edge.from.contains(&EventStatus::Cancelled) {
                assert_eq!(edge.action, "uncancel", "only uncancel leaves cancelled");
            }
            assert!(!edge.from.is_empty(), "{} has no source state", edge.action);
        }
    }

    #[test]
    fn edge_targets_are_the_statuses_the_lifecycle_writes() {
        assert_eq!(edge("start").map(|e| e.to), Some(EventStatus::Live));
        assert_eq!(edge("stop").map(|e| e.to), Some(EventStatus::Stopped));
        assert_eq!(
            edge("auto_stop").map(|e| e.to),
            Some(EventStatus::AutoStopped)
        );
        assert_eq!(edge("cancel").map(|e| e.to), Some(EventStatus::Cancelled));
        assert_eq!(edge("uncancel").map(|e| e.to), Some(EventStatus::Scheduled));
        assert!(edge("archive").is_none(), "archive is a flag, not an edge");
    }
}
