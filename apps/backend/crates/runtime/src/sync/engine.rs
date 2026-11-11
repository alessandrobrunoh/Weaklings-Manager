//! The sync engine: the relay, executor and maintenance loops, and the rounds
//! they run.
//!
//! Every loop is registered with [`crate::spawn_all`] through
//! [`registered_tasks`]. Each one returns at once unless a kind is switched on
//! (`SYNC_ENGINE_KINDS`) and has a handler, so production behaves as before
//! until a slice enables a kind.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection, Statement};

use super::error::SyncError;
use super::failpoint;
use super::handler::HandlerRegistry;
use super::jobs::{self, ClaimRequest, ClaimedJob, Finish};
use super::policy::SyncSettings;
use super::relay::{self, RelayStats};
use crate::backoff;
use crate::state::{Outcome, next_state};
use crate::tasks::{LoopTask, TaskContext};
use crate::wake::WakeTarget;
use backend_core::errors::AppError;
use backend_identity::tenant::TenantRegistry;

/// Failures in a row before a target tenant is skipped for a while.
const TRIP_AFTER: u32 = 5;
/// How long a tripped target is skipped.
const OPEN_FOR_SECONDS: i64 = 60;

/// Per-tenant circuit breaker, in process memory (one replica per process).
#[derive(Debug, Default)]
pub struct CircuitBreaker {
    tenants: Mutex<HashMap<String, Tripped>>,
}

#[derive(Debug, Clone, Copy, Default)]
struct Tripped {
    failures: u32,
    open_until: Option<DateTime<Utc>>,
}

impl CircuitBreaker {
    /// Records the result of one attempt against `tenant_id`.
    pub fn record(&self, tenant_id: &str, ok: bool, now: DateTime<Utc>) {
        let mut tenants = self.tenants.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = tenants.entry(tenant_id.to_owned()).or_default();
        if ok {
            *entry = Tripped::default();
            return;
        }
        entry.failures += 1;
        if entry.failures >= TRIP_AFTER {
            entry.failures = 0;
            entry.open_until = Some(now + Duration::seconds(OPEN_FOR_SECONDS));
        }
    }

    /// Tenants that are skipped at `now`.
    #[must_use]
    pub fn open_tenants(&self, now: DateTime<Utc>) -> Vec<String> {
        let tenants = self.tenants.lock().unwrap_or_else(PoisonError::into_inner);
        tenants
            .iter()
            .filter(|(_, tripped)| tripped.open_until.is_some_and(|until| until > now))
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/// What a round needs besides its inputs.
#[derive(Clone)]
pub struct SyncCx {
    /// Control plane (the job queue).
    pub control: DatabaseConnection,
    /// Tenant contexts (origin and target databases).
    pub registry: TenantRegistry,
    /// Failure memory per tenant.
    pub breaker: Arc<CircuitBreaker>,
}

/// The engine's configuration and handlers.
pub struct SyncEngine {
    /// Registered kinds.
    pub handlers: HandlerRegistry,
    /// Kill switches.
    pub settings: SyncSettings,
    /// Shared with every round of this engine.
    pub breaker: Arc<CircuitBreaker>,
}

impl SyncEngine {
    /// An engine over `handlers` and `settings`.
    #[must_use]
    pub fn new(handlers: HandlerRegistry, settings: SyncSettings) -> Self {
        Self {
            handlers,
            settings,
            breaker: Arc::new(CircuitBreaker::default()),
        }
    }

    /// The round context for a loop running under `task`.
    #[must_use]
    pub fn context(&self, task: &TaskContext) -> SyncCx {
        SyncCx {
            control: task.control.clone(),
            registry: task.registry.clone(),
            breaker: self.breaker.clone(),
        }
    }

    /// Kinds that may run now: enabled by the switches and registered.
    #[must_use]
    pub fn active_kinds(&self) -> Vec<String> {
        self.settings.active_kinds(self.handlers.kinds())
    }
}

/// One relay pass over `tenants` (origin tenants whose outboxes are read).
///
/// # Errors
///
/// Control-plane failures while enqueueing; tenant failures only trip the
/// breaker for that tenant.
pub async fn relay_round(
    cx: &SyncCx,
    engine: &SyncEngine,
    tenants: &[String],
    now: DateTime<Utc>,
) -> Result<RelayStats, AppError> {
    let kinds = engine.active_kinds();
    let mut total = RelayStats::default();
    if kinds.is_empty() {
        return Ok(total);
    }
    for tenant in tenants {
        let ctx = match cx.registry.get_or_load(tenant).await {
            Ok(ctx) => ctx,
            Err(error) => {
                tracing::warn!(tenant_id = %tenant, error = %error, "sync relay skipped tenant");
                cx.breaker.record(tenant, false, now);
                continue;
            }
        };
        match relay::relay_tenant(cx, &engine.handlers, &kinds, tenant, &ctx.db, now).await {
            Ok(stats) => {
                cx.breaker.record(tenant, true, now);
                total.rows += stats.rows;
                total.jobs += stats.jobs;
            }
            Err(error) => {
                tracing::error!(tenant_id = %tenant, error = %error, "sync relay failed");
                cx.breaker.record(tenant, false, now);
            }
        }
    }
    Ok(total)
}

/// One executor pass: claims up to `limit` due jobs and runs them one by one.
///
/// Returns the number of jobs claimed. A job whose lease was taken over during
/// its run is dropped (its replacement converges the same target).
///
/// # Errors
///
/// Control-plane failures.
pub async fn execute_round(
    cx: &SyncCx,
    engine: &SyncEngine,
    now: DateTime<Utc>,
    limit: u64,
) -> Result<usize, AppError> {
    let kinds = engine.active_kinds();
    if kinds.is_empty() {
        return Ok(0);
    }
    let excluded = cx.breaker.open_tenants(now);
    let claimed = jobs::claim_due(
        &cx.control,
        ClaimRequest {
            limit,
            now,
            kinds: &kinds,
            excluded_targets: &excluded,
        },
    )
    .await?;
    let count = claimed.len();
    for job in &claimed {
        let (outcome, error) = match run_job(cx, engine, job, now).await {
            Ok(outcome) => (outcome, None),
            Err(error) => (error.outcome(), Some(error)),
        };
        failpoint::check("executor.before_finish")?;
        let step = next_state(job.attempts, job.max_attempts, &outcome);
        let delay = {
            let mut rng = rand::thread_rng();
            backoff::backoff(job.attempts, &mut rng)
        };
        let delay = Duration::from_std(delay).unwrap_or_else(|_| Duration::zero());
        let mut finish = Finish::new(step, job.attempts, now, delay);
        if let Some(error) = &error {
            finish.error_class = error.error_class();
            finish.last_error = Some(error.message());
        }
        match jobs::finish(&cx.control, job.id, job.fence.token(), &finish, now).await {
            Ok(()) => {}
            Err(AppError::Conflict(message)) => {
                tracing::warn!(job_id = %job.id, message = %message, "sync job result discarded");
            }
            Err(other) => return Err(other),
        }
    }
    Ok(count)
}

async fn run_job(
    cx: &SyncCx,
    engine: &SyncEngine,
    job: &ClaimedJob,
    now: DateTime<Utc>,
) -> Result<Outcome, SyncError> {
    let handler = engine.handlers.get(&job.kind).ok_or_else(|| {
        SyncError::Permanent(format!("no handler registered for sync kind {}", job.kind))
    })?;
    for tenant in [job.origin_tenant_id.as_str(), job.target_tenant_id.as_str()] {
        match cx.registry.get_or_load(tenant).await {
            Ok(_) => cx.breaker.record(tenant, true, now),
            Err(error) => {
                cx.breaker.record(tenant, false, now);
                return Err(SyncError::from(error));
            }
        }
    }
    handler.apply(cx, job).await
}

/// Purges finished history (see [`jobs::purge`]).
///
/// # Errors
///
/// Control-plane failures.
pub async fn maintenance_round(cx: &SyncCx, now: DateTime<Utc>) -> Result<u64, AppError> {
    jobs::purge(&cx.control, now).await
}

/// Tenant ids that are active in the control plane.
///
/// # Errors
///
/// Control-plane failures.
pub async fn active_tenant_ids(control: &DatabaseConnection) -> Result<Vec<String>, AppError> {
    let rows = control
        .query_all(Statement::from_string(
            control.get_database_backend(),
            "SELECT id FROM tenants WHERE status = 'active' ORDER BY id",
        ))
        .await?;
    rows.iter()
        .map(|row| Ok(row.try_get_by_index::<String>(0)?))
        .collect()
}

struct RelayTask(Arc<SyncEngine>);

#[async_trait]
impl LoopTask for RelayTask {
    fn name(&self) -> &'static str {
        "sync_relay"
    }

    fn tick(&self) -> std::time::Duration {
        std::time::Duration::from_secs(5)
    }

    fn wake_target(&self) -> Option<WakeTarget> {
        Some(WakeTarget::SyncRelay)
    }

    async fn run_once(&self, task: &TaskContext) -> Result<(), AppError> {
        if !self.0.settings.any_active() {
            return Ok(());
        }
        let cx = self.0.context(task);
        let tenants = active_tenant_ids(&task.control).await?;
        relay_round(&cx, &self.0, &tenants, Utc::now())
            .await
            .map(|_| ())
    }
}

struct ExecuteTask(Arc<SyncEngine>);

#[async_trait]
impl LoopTask for ExecuteTask {
    fn name(&self) -> &'static str {
        "sync_executor"
    }

    fn tick(&self) -> std::time::Duration {
        std::time::Duration::from_secs(5)
    }

    fn wake_target(&self) -> Option<WakeTarget> {
        Some(WakeTarget::SyncExecutor)
    }

    async fn run_once(&self, task: &TaskContext) -> Result<(), AppError> {
        if !self.0.settings.any_active() {
            return Ok(());
        }
        let cx = self.0.context(task);
        execute_round(&cx, &self.0, Utc::now(), 16)
            .await
            .map(|_| ())
    }
}

struct MaintenanceTask(Arc<SyncEngine>);

#[async_trait]
impl LoopTask for MaintenanceTask {
    fn name(&self) -> &'static str {
        "sync_maintenance"
    }

    fn tick(&self) -> std::time::Duration {
        std::time::Duration::from_secs(60)
    }

    async fn run_once(&self, task: &TaskContext) -> Result<(), AppError> {
        if !self.0.settings.any_active() {
            return Ok(());
        }
        let cx = self.0.context(task);
        maintenance_round(&cx, Utc::now()).await.map(|_| ())
    }
}

/// The sync loops the server runs. Production registers no handler, so the
/// loops idle until a slice registers one and enables its kind.
#[must_use]
pub fn registered_tasks() -> Vec<Arc<dyn LoopTask>> {
    let engine = Arc::new(SyncEngine::new(
        HandlerRegistry::default(),
        SyncSettings::from_env(),
    ));
    vec![
        Arc::new(RelayTask(engine.clone())),
        Arc::new(ExecuteTask(engine.clone())),
        Arc::new(MaintenanceTask(engine)),
    ]
}
