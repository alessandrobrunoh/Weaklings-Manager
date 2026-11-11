//! Lease fencing for claimed queue rows.
//!
//! A worker claims a row by writing a fresh `lease_token` and a `lease_until`
//! deadline. Every terminal update must be conditional on that token still
//! being the row's (`... WHERE id = $1 AND lease_token = $2 AND state =
//! 'processing'`); zero affected rows means the lease expired and another
//! worker reclaimed the row, so this worker's result is discarded. The
//! handlers are idempotent, therefore the replacement converges anyway.

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use backend_core::errors::AppError;

/// Token and deadline of one claimed row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeaseFence {
    token: Uuid,
    until: DateTime<Utc>,
}

impl LeaseFence {
    /// A fresh fence valid for `lease` from `now`.
    #[must_use]
    pub fn new(now: DateTime<Utc>, lease: Duration) -> Self {
        Self::with_token(Uuid::new_v4(), now + lease)
    }

    /// A fence rebuilt from a stored token and deadline.
    #[must_use]
    pub fn with_token(token: Uuid, until: DateTime<Utc>) -> Self {
        Self { token, until }
    }

    /// Token to write into `lease_token` and to fence terminal updates with.
    #[must_use]
    pub fn token(&self) -> Uuid {
        self.token
    }

    /// Deadline to write into `lease_until`.
    #[must_use]
    pub fn until(&self) -> DateTime<Utc> {
        self.until
    }

    /// Whether the lease deadline has passed (the row may be reclaimed).
    #[must_use]
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        self.until <= now
    }

    /// The same token with the deadline pushed to `now + lease` (heartbeat).
    #[must_use]
    pub fn extended(&self, now: DateTime<Utc>, lease: Duration) -> Self {
        Self {
            token: self.token,
            until: self.until.max(now + lease),
        }
    }

    /// Turns the `rows_affected` of a fenced terminal update into a result.
    ///
    /// # Errors
    ///
    /// `Conflict` when no row matched: the lease expired or was replaced and
    /// the caller must discard its result.
    pub fn ensure_held(rows_affected: u64, what: &str) -> Result<(), AppError> {
        if rows_affected == 0 {
            return Err(AppError::Conflict(format!(
                "{what} lease expired or was replaced"
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + secs, 0).expect("timestamp")
    }

    #[test]
    fn fence_expires_at_its_deadline() {
        let fence = LeaseFence::new(at(0), Duration::seconds(60));
        assert!(!fence.is_expired(at(59)));
        assert!(fence.is_expired(at(60)));
        assert!(fence.is_expired(at(600)));
    }

    #[test]
    fn every_claim_gets_a_distinct_token() {
        let a = LeaseFence::new(at(0), Duration::seconds(60));
        let b = LeaseFence::new(at(0), Duration::seconds(60));
        assert_ne!(a.token(), b.token());
    }

    #[test]
    fn heartbeat_extends_but_never_shortens() {
        let fence = LeaseFence::new(at(0), Duration::seconds(60));
        let longer = fence.extended(at(30), Duration::seconds(60));
        assert_eq!(longer.token(), fence.token());
        assert_eq!(longer.until(), at(90));
        let shorter = fence.extended(at(0), Duration::seconds(10));
        assert_eq!(shorter.until(), at(60));
    }

    #[test]
    fn zero_affected_rows_is_a_lease_conflict() {
        assert!(LeaseFence::ensure_held(1, "job").is_ok());
        let error = LeaseFence::ensure_held(0, "event fanout target").expect_err("fenced out");
        assert!(matches!(&error, AppError::Conflict(message)
            if message == "event fanout target lease expired or was replaced"));
    }
}
