//! In-process roster change notifications for the single backend replica.
//!
//! One [`RosterHub`] is shared by every tenant (see `lib.rs`), so every
//! notification carries the tenant it belongs to and [`RosterHub::subscribe`]
//! filters on it. Event ids are per-schema sequences, not globally unique, so
//! event 42 exists in every tenant — without the tenant check here, a socket
//! open on one guild's event would also see seat assignments, build picks and
//! roster-version bumps from a same-numbered event in every other guild.

use serde::Serialize;
use tokio::sync::broadcast;

/// Small notification sent after a roster transaction commits.
#[derive(Debug, Clone, Serialize)]
pub struct RosterNotification {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    /// Tenant this notification belongs to. Never serialized to the client —
    /// it exists purely so [`RosterHub::subscribe`] can filter the shared
    /// broadcast channel before a socket ever sees another guild's traffic.
    #[serde(skip)]
    pub tenant_id: String,
    pub event_id: i64,
    pub roster_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_seat_keys: Option<Vec<String>>,
}

impl RosterNotification {
    /// The first message sent on a freshly opened socket, before any change.
    #[must_use]
    pub fn ready(tenant_id: impl Into<String>, event_id: i64, roster_version: i64) -> Self {
        Self {
            message_type: "ready",
            tenant_id: tenant_id.into(),
            event_id,
            roster_version,
            change_kind: None,
            changed_seat_keys: None,
        }
    }

    /// Sent when the socket missed messages on the shared channel (see
    /// [`tokio::sync::broadcast::error::RecvError::Lagged`]) and the client
    /// must refetch instead of trusting the incremental stream.
    #[must_use]
    pub fn resync_required(tenant_id: impl Into<String>, event_id: i64, roster_version: i64) -> Self {
        Self {
            message_type: "resync_required",
            tenant_id: tenant_id.into(),
            event_id,
            roster_version,
            change_kind: None,
            changed_seat_keys: None,
        }
    }
}

/// Broadcast hub shared by every tenant. Consumers filter by tenant id *and*
/// event id before writing to their socket — see the module docs for why the
/// tenant check is load-bearing, not defensive.
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
        tenant_id: impl Into<String>,
        event_id: i64,
        roster_version: i64,
        change_kind: &'static str,
        changed_seat_keys: Vec<String>,
    ) {
        let _ = self.sender.send(RosterNotification {
            message_type: "roster_changed",
            tenant_id: tenant_id.into(),
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

#[cfg(test)]
mod tests {
    use super::{RosterHub, RosterNotification};

    #[tokio::test]
    async fn notifications_keep_the_event_id_for_subscriber_filtering() {
        let hub = RosterHub::new();
        let mut first = hub.subscribe();
        let mut second = hub.subscribe();
        hub.publish("guild-a", 10, 2, "assigned", vec!["build:4:1".to_string()]);
        hub.publish("guild-a", 20, 3, "cleared", vec!["build:5:1".to_string()]);

        let first_events = [
            first.recv().await.unwrap().event_id,
            first.recv().await.unwrap().event_id,
        ];
        let second_events = [
            second.recv().await.unwrap().event_id,
            second.recv().await.unwrap().event_id,
        ];
        assert_eq!(first_events, [10, 20]);
        assert_eq!(second_events, [10, 20]);
    }

    /// The leak this module exists to prevent: event ids are per-schema, so
    /// event 10 in guild A and event 10 in guild B are unrelated rows. A
    /// subscriber must be able to tell them apart from the tenant id alone.
    #[tokio::test]
    async fn notifications_carry_the_tenant_id_so_same_numbered_events_stay_distinct() {
        let hub = RosterHub::new();
        let mut sub = hub.subscribe();
        hub.publish("guild-a", 10, 2, "assigned", vec!["build:4:1".to_string()]);
        hub.publish("guild-b", 10, 7, "assigned", vec!["build:9:1".to_string()]);

        let first = sub.recv().await.unwrap();
        let second = sub.recv().await.unwrap();
        assert_eq!((first.tenant_id.as_str(), first.roster_version), ("guild-a", 2));
        assert_eq!((second.tenant_id.as_str(), second.roster_version), ("guild-b", 7));
    }

    #[test]
    fn tenant_id_is_never_serialized_to_the_client() {
        let notification = RosterNotification::ready("guild-a", 10, 1);
        let json = serde_json::to_string(&notification).expect("serializes");
        assert!(!json.contains("guild-a"));
        assert!(!json.contains("tenant"));
    }
}
