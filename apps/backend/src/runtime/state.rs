//! Pure job state machine shared by durable queues (sync-engine design 4.2).
//!
//! Only the transition table lives here, so it is unit-tested without a
//! database. The sync engine (SY-1) maps its `SyncError` and handler results
//! onto [`Outcome`] and persists the returned [`Step`].
//!
//! ```text
//! pending --claim--> processing --Done-------------> done
//!                               --Inactive---------> inactive
//!                               --Superseded-------> superseded
//!                               --Retryable--------> retry | exhausted (attempts >= max)
//!                               --Permanent--------> exhausted
//!                               --Blocked----------> blocked
//!                               --Paused-----------> paused (attempt refunded)
//! retry/exhausted/blocked --manual retry--> pending (attempts = 0)
//! paused --tenant resumed--> pending
//! ```

/// Lifecycle state of a queued job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    /// Waiting for its first claim (or re-armed).
    Pending,
    /// Claimed under a lease.
    Processing,
    /// Failed retryably; waits for `next_attempt_at`.
    Retry,
    /// Finished successfully.
    Done,
    /// The target no longer participates; nothing to do.
    Inactive,
    /// A newer version made this job moot.
    Superseded,
    /// No more automatic attempts (cap reached or permanent failure).
    Exhausted,
    /// Needs a human; re-armable.
    Blocked,
    /// Target tenant suspended; re-armed on resume without burning attempts.
    Paused,
    /// Cancelled by an operator.
    Cancelled,
}

impl JobState {
    /// Column value stored in the queue table.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Processing => "processing",
            Self::Retry => "retry",
            Self::Done => "done",
            Self::Inactive => "inactive",
            Self::Superseded => "superseded",
            Self::Exhausted => "exhausted",
            Self::Blocked => "blocked",
            Self::Paused => "paused",
            Self::Cancelled => "cancelled",
        }
    }

    /// Parses a stored column value.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "processing" => Self::Processing,
            "retry" => Self::Retry,
            "done" => Self::Done,
            "inactive" => Self::Inactive,
            "superseded" => Self::Superseded,
            "exhausted" => Self::Exhausted,
            "blocked" => Self::Blocked,
            "paused" => Self::Paused,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }

    /// States that still block later jobs with the same ordering key.
    #[must_use]
    pub fn blocks_ordering(self) -> bool {
        matches!(self, Self::Pending | Self::Retry | Self::Processing)
    }

    /// States no automatic transition leaves.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Done | Self::Inactive | Self::Superseded | Self::Exhausted | Self::Cancelled
        )
    }
}

/// Result of one handler run, already classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Applied (or already applied).
    Done,
    /// The target no longer participates.
    Inactive,
    /// A newer version made the job moot.
    Superseded,
    /// Transient failure; retry with backoff.
    Retryable,
    /// Retrying cannot help.
    Permanent,
    /// Needs a human decision.
    Blocked,
    /// Target tenant is suspended; retry later without burning an attempt.
    Paused,
}

/// Persisted consequence of an [`Outcome`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    /// State to write.
    pub state: JobState,
    /// The claim consumed an attempt that must be given back.
    pub refund_attempt: bool,
    /// `next_attempt_at` must be set from the backoff curve.
    pub schedule_retry: bool,
}

/// Transition of a `processing` job after its handler returned `outcome`.
///
/// `attempts` counts the claim that just ran (the claim increments it) and
/// `max_attempts` is the per-kind cap.
#[must_use]
pub fn next_state(attempts: i32, max_attempts: i32, outcome: &Outcome) -> Step {
    let plain = |state| Step {
        state,
        refund_attempt: false,
        schedule_retry: false,
    };
    match outcome {
        Outcome::Done => plain(JobState::Done),
        Outcome::Inactive => plain(JobState::Inactive),
        Outcome::Superseded => plain(JobState::Superseded),
        Outcome::Permanent => plain(JobState::Exhausted),
        Outcome::Blocked => plain(JobState::Blocked),
        Outcome::Paused => Step {
            state: JobState::Paused,
            refund_attempt: true,
            schedule_retry: false,
        },
        Outcome::Retryable if attempts >= max_attempts => plain(JobState::Exhausted),
        Outcome::Retryable => Step {
            state: JobState::Retry,
            refund_attempt: false,
            schedule_retry: true,
        },
    }
}

/// State a job returns to when an operator retries it (`attempts` reset to 0),
/// or `None` when the state cannot be re-armed.
#[must_use]
pub fn rearm(state: JobState) -> Option<JobState> {
    matches!(
        state,
        JobState::Retry | JobState::Exhausted | JobState::Blocked
    )
    .then_some(JobState::Pending)
}

/// State a job returns to when its suspended target tenant resumes.
#[must_use]
pub fn resume(state: JobState) -> Option<JobState> {
    (state == JobState::Paused).then_some(JobState::Pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [JobState; 10] = [
        JobState::Pending,
        JobState::Processing,
        JobState::Retry,
        JobState::Done,
        JobState::Inactive,
        JobState::Superseded,
        JobState::Exhausted,
        JobState::Blocked,
        JobState::Paused,
        JobState::Cancelled,
    ];

    #[test]
    fn terminal_outcomes_map_to_their_states() {
        for (outcome, state) in [
            (Outcome::Done, JobState::Done),
            (Outcome::Inactive, JobState::Inactive),
            (Outcome::Superseded, JobState::Superseded),
            (Outcome::Permanent, JobState::Exhausted),
            (Outcome::Blocked, JobState::Blocked),
        ] {
            let step = next_state(1, 12, &outcome);
            assert_eq!(step.state, state, "{outcome:?}");
            assert!(!step.refund_attempt && !step.schedule_retry, "{outcome:?}");
        }
    }

    #[test]
    fn retryable_retries_until_the_cap_then_exhausts() {
        let step = next_state(11, 12, &Outcome::Retryable);
        assert_eq!(step.state, JobState::Retry);
        assert!(step.schedule_retry && !step.refund_attempt);
        for attempts in [12, 13] {
            let step = next_state(attempts, 12, &Outcome::Retryable);
            assert_eq!(step.state, JobState::Exhausted);
            assert!(!step.schedule_retry);
        }
    }

    #[test]
    fn permanent_failure_exhausts_on_the_first_attempt() {
        assert_eq!(
            next_state(1, 12, &Outcome::Permanent).state,
            JobState::Exhausted
        );
    }

    #[test]
    fn paused_refunds_the_claim_attempt() {
        let step = next_state(3, 12, &Outcome::Paused);
        assert_eq!(step.state, JobState::Paused);
        assert!(step.refund_attempt);
        assert!(!step.schedule_retry);
    }

    #[test]
    fn only_retry_exhausted_and_blocked_rearm() {
        for state in ALL {
            let expected = matches!(
                state,
                JobState::Retry | JobState::Exhausted | JobState::Blocked
            );
            assert_eq!(
                rearm(state) == Some(JobState::Pending),
                expected,
                "{state:?}"
            );
        }
    }

    #[test]
    fn only_paused_resumes() {
        for state in ALL {
            assert_eq!(
                resume(state) == Some(JobState::Pending),
                state == JobState::Paused,
                "{state:?}"
            );
        }
    }

    #[test]
    fn ordering_is_blocked_only_by_live_states() {
        let blocking: Vec<_> = ALL.into_iter().filter(|s| s.blocks_ordering()).collect();
        assert_eq!(
            blocking,
            [JobState::Pending, JobState::Processing, JobState::Retry]
        );
        // Terminal states never block later keys.
        for state in ALL.into_iter().filter(|s| s.is_terminal()) {
            assert!(!state.blocks_ordering(), "{state:?}");
        }
    }

    #[test]
    fn column_values_round_trip() {
        for state in ALL {
            assert_eq!(JobState::parse(state.as_str()), Some(state));
        }
        assert_eq!(JobState::parse("nonsense"), None);
    }
}
