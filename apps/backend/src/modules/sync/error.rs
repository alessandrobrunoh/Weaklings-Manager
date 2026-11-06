//! Failure classes of one sync job and how they map onto the job state machine.
//!
//! Handlers return [`SyncError`]; the executor turns it into a
//! [`crate::runtime::state::Outcome`] and persists the resulting state.

use crate::errors::AppError;
use crate::runtime::state::Outcome;

/// Why a handler did not complete its job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    /// Transient (database, lease or upstream trouble): retry with backoff.
    Retryable(String),
    /// Retrying cannot help (the target schema violates an invariant).
    Permanent(String),
    /// Needs a human decision; re-armed by an operator retry.
    Blocked {
        /// Machine-readable reason, e.g. `participant_unresolved`.
        code: &'static str,
        /// Human-readable explanation shown in the status API.
        detail: String,
    },
    /// The job no longer applies (membership gone, origin removed, scope off).
    Inactive(String),
    /// The target tenant is suspended; resumed without burning an attempt.
    Paused(String),
}

impl SyncError {
    /// The state-machine outcome of this failure.
    #[must_use]
    pub fn outcome(&self) -> Outcome {
        match self {
            Self::Retryable(_) => Outcome::Retryable,
            Self::Permanent(_) => Outcome::Permanent,
            Self::Blocked { .. } => Outcome::Blocked,
            Self::Inactive(_) => Outcome::Inactive,
            Self::Paused(_) => Outcome::Paused,
        }
    }

    /// Value stored in `sync_jobs.error_class`, when the failure is an error.
    #[must_use]
    pub fn error_class(&self) -> Option<&'static str> {
        match self {
            Self::Retryable(_) => Some("retryable"),
            Self::Permanent(_) => Some("permanent"),
            Self::Blocked { .. } => Some("blocked"),
            Self::Inactive(_) | Self::Paused(_) => None,
        }
    }

    /// Text stored in `sync_jobs.last_error`.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Retryable(message) | Self::Permanent(message) => message.clone(),
            Self::Blocked { code, detail } => format!("{code}: {detail}"),
            Self::Inactive(message) | Self::Paused(message) => message.clone(),
        }
    }
}

impl From<AppError> for SyncError {
    /// Classifies an application error raised while a job ran.
    ///
    /// A `Forbidden` tenant is suspended (the registry refuses non-active
    /// tenants), `NotFound` means the tenant or row is gone, and database,
    /// conflict and upstream failures are transient.
    fn from(error: AppError) -> Self {
        let message = error.to_string();
        match error {
            AppError::Forbidden(_) => Self::Paused(message),
            AppError::NotFound(_) => Self::Inactive(message),
            AppError::Conflict(_)
            | AppError::TooManyRequests(_)
            | AppError::UpstreamService(_)
            | AppError::Database(_)
            | AppError::Internal(_) => Self::Retryable(message),
            _ => Self::Permanent(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_failure_maps_to_its_outcome_and_error_class() {
        let cases = [
            (
                SyncError::Retryable("db".into()),
                Outcome::Retryable,
                Some("retryable"),
            ),
            (
                SyncError::Permanent("schema".into()),
                Outcome::Permanent,
                Some("permanent"),
            ),
            (
                SyncError::Blocked {
                    code: "participant_unresolved",
                    detail: "link the player".into(),
                },
                Outcome::Blocked,
                Some("blocked"),
            ),
            (SyncError::Inactive("gone".into()), Outcome::Inactive, None),
            (SyncError::Paused("suspended".into()), Outcome::Paused, None),
        ];
        for (error, outcome, class) in cases {
            assert_eq!(error.outcome(), outcome, "{error:?}");
            assert_eq!(error.error_class(), class, "{error:?}");
        }
    }

    #[test]
    fn app_errors_are_classified_by_their_cause() {
        assert!(matches!(
            SyncError::from(AppError::Forbidden("tenant x is suspended".into())),
            SyncError::Paused(_)
        ));
        assert!(matches!(
            SyncError::from(AppError::NotFound("row".into())),
            SyncError::Inactive(_)
        ));
        assert!(matches!(
            SyncError::from(AppError::Conflict("lease".into())),
            SyncError::Retryable(_)
        ));
        assert!(matches!(
            SyncError::from(AppError::Validation("bad".into())),
            SyncError::Permanent(_)
        ));
    }
}
