//! In-process roster change notifications for the single backend replica.

use serde::Serialize;
use tokio::sync::broadcast;

/// Small notification sent after a roster transaction commits.
#[derive(Debug, Clone, Serialize)]
pub struct RosterNotification {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub event_id: i64,
    pub roster_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_seat_keys: Option<Vec<String>>,
}

/// Broadcast hub. Consumers filter by event id before writing to their socket.
#[derive(Clone, Debug)]
pub struct RosterHub {
    sender: broadcast::Sender<RosterNotification>,
}

impl RosterHub {
    #[must_use]
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(128);
        Self { sender }
    }
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<RosterNotification> {
        self.sender.subscribe()
    }
    pub fn publish(
        &self,
        event_id: i64,
        roster_version: i64,
        change_kind: &'static str,
        changed_seat_keys: Vec<String>,
    ) {
        let _ = self.sender.send(RosterNotification {
            message_type: "roster_changed",
            event_id,
            roster_version,
            change_kind: Some(change_kind),
            changed_seat_keys: Some(changed_seat_keys),
        });
    }
}

impl Default for RosterHub {
    fn default() -> Self {
        Self::new()
    }
}
