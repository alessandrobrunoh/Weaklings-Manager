//! The per-kind contract the engine calls: who must receive a change, and how
//! to converge one target.
//!
//! Handlers never trust a job payload for state: `apply` re-reads the origin
//! row. SY-1 ships the trait and the registry only; the kinds are registered by
//! the slices that own them.

use std::sync::Arc;

use async_trait::async_trait;
use sea_orm::DatabaseTransaction;

use super::engine::SyncCx;
use super::error::SyncError;
use crate::runtime::state::Outcome;

/// One outbox row as the relay reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboxRow {
    /// Outbox id, which is also the job's `origin_version`.
    pub id: i64,
    /// Sync kind (`event`, `build`, ...).
    pub kind: String,
    /// Entity id in the origin tenant.
    pub entity_id: i64,
    /// `upsert`, `delete`, `archive` or `command`.
    pub op: String,
    /// Command body for `command` rows.
    pub command: Option<serde_json::Value>,
    /// Ordering key given by the emitter (commands).
    pub ordering_key: Option<String>,
}

/// Where a change has to go.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TargetPlan {
    /// Tenants that must hold the entity (upsert jobs).
    pub desired: Vec<String>,
    /// Tenants that held it and must drop it (delete jobs).
    pub retire: Vec<String>,
}

/// One sync kind.
#[async_trait]
pub trait SyncHandler: Send + Sync {
    /// Stable kind name, the key of `sync_outbox.kind` and `sync_jobs.kind`.
    fn kind(&self) -> &'static str;

    /// Automatic attempts before a job is `exhausted`.
    fn max_attempts(&self) -> i32 {
        12
    }

    /// Computes the targets of one outbox row, reading the origin state
    /// through `txn` (the relay's transaction on the origin tenant).
    ///
    /// # Errors
    ///
    /// Any failure leaves the row unrelayed, so the next round retries it.
    async fn targets(
        &self,
        cx: &SyncCx,
        origin_tenant_id: &str,
        txn: &DatabaseTransaction,
        row: &OutboxRow,
    ) -> Result<TargetPlan, SyncError>;

    /// Converges the job's target to the origin's current state.
    ///
    /// # Errors
    ///
    /// Classified by [`SyncError`]; the executor persists the matching state.
    async fn apply(&self, cx: &SyncCx, job: &super::jobs::ClaimedJob)
    -> Result<Outcome, SyncError>;
}

/// The handlers this process runs, keyed by kind.
#[derive(Clone, Default)]
pub struct HandlerRegistry {
    handlers: Arc<Vec<Arc<dyn SyncHandler>>>,
}

impl HandlerRegistry {
    /// A registry of `handlers`.
    ///
    /// # Panics
    ///
    /// Panics when two handlers claim the same kind.
    #[must_use]
    pub fn new(handlers: Vec<Arc<dyn SyncHandler>>) -> Self {
        for (index, handler) in handlers.iter().enumerate() {
            assert!(
                handlers[..index]
                    .iter()
                    .all(|other| other.kind() != handler.kind()),
                "duplicate sync handler for kind {}",
                handler.kind()
            );
        }
        Self {
            handlers: Arc::new(handlers),
        }
    }

    /// The handler of `kind`.
    #[must_use]
    pub fn get(&self, kind: &str) -> Option<Arc<dyn SyncHandler>> {
        self.handlers
            .iter()
            .find(|handler| handler.kind() == kind)
            .cloned()
    }

    /// Kinds with a handler, in registration order.
    pub fn kinds(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.handlers.iter().map(|handler| handler.kind())
    }
}
