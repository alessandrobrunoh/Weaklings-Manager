//! Stable string keys persisted on `notifications.kind` and `discord_dm_status`.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Kind of in-app notification. Stored as the `snake_case` string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum NotificationKind {
    /// Officer/admin announcement fanned out to every member.
    Broadcast,
    /// Regear request approved.
    RegearAccepted,
    /// Regear request rejected.
    RegearRejected,
    /// Bank withdrawal paid out.
    BankWithdrawAccepted,
    /// Bank withdrawal rejected.
    BankWithdrawRejected,
    /// Warn issued against the recipient.
    WarnIssued,
    /// New event created. In-app only (Discord already pings the events channel).
    EventCreated,
    /// Event starts within one hour. In-app only for signed-up participants.
    EventReminder1h,
}

impl NotificationKind {
    /// Stable lowercase key stored in the database.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Broadcast => "broadcast",
            Self::RegearAccepted => "regear_accepted",
            Self::RegearRejected => "regear_rejected",
            Self::BankWithdrawAccepted => "bank_withdraw_accepted",
            Self::BankWithdrawRejected => "bank_withdraw_rejected",
            Self::WarnIssued => "warn_issued",
            Self::EventCreated => "event_created",
            Self::EventReminder1h => "event_reminder_1h",
        }
    }

    /// Whether a newly inserted row should queue a Discord DM.
    ///
    /// Event kinds stay `skipped`: the Discord poller already pings the events channel.
    #[must_use]
    pub fn queues_discord_dm(self) -> bool {
        !matches!(self, Self::EventCreated | Self::EventReminder1h)
    }
}

impl fmt::Display for NotificationKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for NotificationKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "broadcast" => Ok(Self::Broadcast),
            "regear_accepted" => Ok(Self::RegearAccepted),
            "regear_rejected" => Ok(Self::RegearRejected),
            "bank_withdraw_accepted" => Ok(Self::BankWithdrawAccepted),
            "bank_withdraw_rejected" => Ok(Self::BankWithdrawRejected),
            "warn_issued" => Ok(Self::WarnIssued),
            "event_created" => Ok(Self::EventCreated),
            "event_reminder_1h" => Ok(Self::EventReminder1h),
            other => Err(format!("unknown notification kind: {other}")),
        }
    }
}

/// Delivery state of the optional Discord DM for one notification row. Stored as `snake_case`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiscordDmStatus {
    /// Waiting for the background worker.
    Pending,
    /// DM sent successfully.
    Sent,
    /// Not sent on purpose (no discord id, opt-out, channel-duplicative kind, DM closed).
    Skipped,
    /// Exhausted retries.
    Failed,
}

impl DiscordDmStatus {
    /// Stable lowercase key stored in the database.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sent => "sent",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }
}

impl fmt::Display for DiscordDmStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for DiscordDmStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pending" => Ok(Self::Pending),
            "sent" => Ok(Self::Sent),
            "skipped" => Ok(Self::Skipped),
            "failed" => Ok(Self::Failed),
            other => Err(format!("unknown discord dm status: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_roundtrip() {
        for kind in [
            NotificationKind::Broadcast,
            NotificationKind::RegearAccepted,
            NotificationKind::RegearRejected,
            NotificationKind::BankWithdrawAccepted,
            NotificationKind::BankWithdrawRejected,
            NotificationKind::WarnIssued,
            NotificationKind::EventCreated,
            NotificationKind::EventReminder1h,
        ] {
            assert_eq!(kind.as_str().parse::<NotificationKind>().unwrap(), kind);
        }
    }

    #[test]
    fn event_kinds_do_not_queue_dms() {
        assert!(!NotificationKind::EventCreated.queues_discord_dm());
        assert!(!NotificationKind::EventReminder1h.queues_discord_dm());
        assert!(NotificationKind::Broadcast.queues_discord_dm());
        assert!(NotificationKind::WarnIssued.queues_discord_dm());
    }
}
