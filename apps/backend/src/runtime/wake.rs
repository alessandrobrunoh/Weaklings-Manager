//! In-process wake-ups for the background loops.
//!
//! Every loop polls on a short tick, so a lost wake-up costs at most one tick.
//! A wake-up is only a latency optimisation: code that has just committed work
//! for a loop (an outbox row, a retry request) kicks it so the work is picked
//! up in milliseconds instead of waiting for the next poll. It is deliberately
//! process-local (single replica); correctness never depends on it.

use std::sync::Arc;

use tokio::sync::Notify;

/// A loop that can be woken. Owner slices add their variant next to the loop
/// they register in [`super::tasks`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WakeTarget {
    /// Alliance-to-guild event fanout retry queue.
    Fanout,
    /// Alliance event mirror retry queue.
    MirrorRetry,
    /// Sync engine relay (tenant outbox to control jobs).
    SyncRelay,
    /// Sync engine executors (claim and apply control jobs).
    SyncExecutor,
}

impl WakeTarget {
    /// Every target, in declaration order.
    pub const ALL: [WakeTarget; 4] = [
        WakeTarget::Fanout,
        WakeTarget::MirrorRetry,
        WakeTarget::SyncRelay,
        WakeTarget::SyncExecutor,
    ];

    const fn bit(self) -> u32 {
        1 << (self as u32)
    }
}

/// A set of loops to kick once a transaction has committed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WakeSet(u32);

impl WakeSet {
    /// The empty set.
    #[must_use]
    pub const fn none() -> Self {
        Self(0)
    }

    /// A set holding one target.
    #[must_use]
    pub const fn of(target: WakeTarget) -> Self {
        Self(target.bit())
    }

    /// Every target.
    #[must_use]
    pub fn all() -> Self {
        WakeTarget::ALL.into_iter().fold(Self::none(), Self::with)
    }

    /// This set plus `target`.
    #[must_use]
    pub const fn with(self, target: WakeTarget) -> Self {
        Self(self.0 | target.bit())
    }

    /// Union of two sets, so nested operations can accumulate their wake-ups.
    #[must_use]
    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    /// Whether `target` is in the set.
    #[must_use]
    pub const fn contains(self, target: WakeTarget) -> bool {
        self.0 & target.bit() != 0
    }

    /// Whether the set is empty.
    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Members of the set.
    pub fn iter(self) -> impl Iterator<Item = WakeTarget> {
        WakeTarget::ALL
            .into_iter()
            .filter(move |target| self.contains(*target))
    }
}

impl From<WakeTarget> for WakeSet {
    fn from(target: WakeTarget) -> Self {
        Self::of(target)
    }
}

/// Wake-up channel of one loop. Cloning shares the channel.
///
/// `kick` stores at most one permit, so any number of kicks while the loop is
/// busy collapse into exactly one extra pass, and a kick that lands between
/// two passes is never lost.
#[derive(Debug, Clone, Default)]
pub struct Wake(Arc<Notify>);

impl Wake {
    /// A fresh channel with no pending permit.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Wakes the loop now (or on its next wait if it is busy).
    pub fn kick(&self) {
        self.0.notify_one();
    }

    /// Completes when kicked, consuming the permit.
    pub async fn notified(&self) {
        self.0.notified().await;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn wake_set_algebra() {
        let none = WakeSet::none();
        assert!(none.is_empty());
        let fanout = WakeSet::of(WakeTarget::Fanout);
        assert!(fanout.contains(WakeTarget::Fanout));
        assert!(!fanout.contains(WakeTarget::MirrorRetry));
        let both = fanout.union(WakeSet::of(WakeTarget::MirrorRetry));
        assert_eq!(
            both.iter().collect::<Vec<_>>(),
            [WakeTarget::Fanout, WakeTarget::MirrorRetry]
        );
        let every = WakeTarget::ALL
            .into_iter()
            .fold(WakeSet::none(), WakeSet::with);
        assert_eq!(every, WakeSet::all());
        assert_eq!(every.iter().collect::<Vec<_>>(), WakeTarget::ALL);
        assert_eq!(fanout.union(fanout), fanout);
        assert_eq!(WakeSet::from(WakeTarget::MirrorRetry).iter().count(), 1);
    }

    #[tokio::test]
    async fn a_kick_before_the_wait_is_not_lost() {
        let wake = Wake::new();
        wake.kick();
        wake.kick();
        tokio::time::timeout(Duration::from_secs(1), wake.notified())
            .await
            .expect("stored permit");
        // The two kicks collapsed into one permit.
        assert!(
            tokio::time::timeout(Duration::from_millis(50), wake.notified())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_waiting_loop_is_woken() {
        let wake = Wake::new();
        let waiter = {
            let wake = wake.clone();
            tokio::spawn(async move { wake.notified().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        wake.kick();
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("woken")
            .expect("join");
    }
}
