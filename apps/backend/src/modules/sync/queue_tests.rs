//! Sync engine tests on the SQLite world: outbox, relay, queue, executor,
//! command ordering. Postgres-only invariants (row locks) are gated on
//! `TEST_DATABASE_URL` at the bottom.

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use sea_orm::{ConnectionTrait, DatabaseTransaction, DbBackend, Statement, TransactionTrait};

use super::engine::{CircuitBreaker, SyncCx, SyncEngine, execute_round, relay_round};
use super::error::SyncError;
use super::handler::{HandlerRegistry, OutboxRow, SyncHandler, TargetPlan};
use super::inbox;
use super::jobs::{self, ClaimRequest, Enqueued, NewJob};
use super::outbox::{self, SyncEmit, SyncOp};
use super::policy::SyncSettings;
use crate::errors::AppError;
use crate::modules::sync::failpoint::armed;
use crate::runtime::state::{Outcome, next_state};
use crate::testkit::{ALLIANCE, GUILDS, World};

fn t0() -> DateTime<Utc> {
    DateTime::from_timestamp(1_800_000_000, 0).expect("timestamp")
}

/// A kind whose targets are fixed and whose apply can be told to fail.
struct Noop {
    targets: Vec<String>,
    applies: AtomicUsize,
    failures_left: AtomicUsize,
    max_attempts: i32,
}

impl Noop {
    fn new(targets: &[&str]) -> Self {
        Self {
            targets: targets.iter().map(|t| (*t).to_owned()).collect(),
            applies: AtomicUsize::new(0),
            failures_left: AtomicUsize::new(0),
            max_attempts: 12,
        }
    }
}

#[async_trait]
impl SyncHandler for Noop {
    fn kind(&self) -> &'static str {
        "noop"
    }

    fn max_attempts(&self) -> i32 {
        self.max_attempts
    }

    async fn targets(
        &self,
        _cx: &SyncCx,
        _origin: &str,
        _txn: &DatabaseTransaction,
        _row: &OutboxRow,
    ) -> Result<TargetPlan, SyncError> {
        Ok(TargetPlan {
            desired: self.targets.clone(),
            retire: Vec::new(),
        })
    }

    async fn apply(&self, _cx: &SyncCx, _job: &jobs::ClaimedJob) -> Result<Outcome, SyncError> {
        self.applies.fetch_add(1, Ordering::SeqCst);
        if self
            .failures_left
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            return Err(SyncError::Retryable("injected".to_owned()));
        }
        Ok(Outcome::Done)
    }
}

fn engine_with(handler: Arc<Noop>) -> SyncEngine {
    SyncEngine::new(
        HandlerRegistry::new(vec![handler]),
        SyncSettings::parse("noop", ""),
    )
}

fn cx(world: &World, engine: &SyncEngine) -> SyncCx {
    SyncCx {
        control: world.control.clone(),
        registry: world.registry.clone(),
        breaker: engine.breaker.clone(),
    }
}

async fn count(db: &impl ConnectionTrait, sql: &str) -> i64 {
    db.query_one(Statement::from_string(DbBackend::Sqlite, sql))
        .await
        .expect("count query")
        .expect("row")
        .try_get_by_index(0)
        .expect("count")
}

async fn text(db: &impl ConnectionTrait, sql: &str) -> String {
    db.query_one(Statement::from_string(DbBackend::Sqlite, sql))
        .await
        .expect("text query")
        .expect("row")
        .try_get_by_index(0)
        .expect("text")
}

async fn emit_upsert(db: &impl ConnectionTrait, entity: i64) -> Option<i64> {
    outbox::emit(db, SyncEmit::state("noop", entity, SyncOp::Upsert))
        .await
        .expect("emit")
}

fn job(target: &str, version: i64, key: &str) -> NewJob {
    NewJob {
        kind: "noop".into(),
        op: "upsert",
        flow: "to_copy",
        origin_tenant_id: ALLIANCE.into(),
        origin_id: 42,
        target_tenant_id: target.into(),
        subject: String::new(),
        origin_version: version,
        ordering_key: format!("noop:{ALLIANCE}:42:{target}"),
        dedupe_key: format!("{ALLIANCE}:{version}:{target}:{key}"),
        payload: serde_json::json!({}),
        priority: 3,
        max_attempts: 12,
    }
}

fn command_job(key: &str, ordering: &str) -> NewJob {
    NewJob {
        op: "command",
        flow: "to_origin",
        ordering_key: ordering.into(),
        ..job(ALLIANCE, 1, key)
    }
}

async fn claim_all(world: &World, now: DateTime<Utc>) -> Vec<jobs::ClaimedJob> {
    jobs::claim_due(
        &world.control,
        ClaimRequest {
            limit: 10,
            now,
            kinds: &["noop".to_owned()],
            excluded_targets: &[],
        },
    )
    .await
    .expect("claim")
}

#[tokio::test]
async fn state_emits_coalesce_to_the_latest_outbox_row_and_commands_never_do() {
    let world = World::new().await;
    let db = &world.alliance().db;
    let first = emit_upsert(db, 42).await.expect("written");
    let second = emit_upsert(db, 42).await.expect("written");
    assert!(second > first);
    assert_eq!(count(db, "SELECT COUNT(*) FROM sync_outbox").await, 1);
    assert_eq!(
        count(db, "SELECT MAX(id) FROM sync_outbox").await,
        second,
        "the surviving row is the newest version"
    );

    for _ in 0..2 {
        outbox::emit(
            db,
            SyncEmit {
                command: Some(serde_json::json!({"discord_id": "9"})),
                ordering_key: Some("cmd:1".into()),
                ..SyncEmit::state("noop", 42, SyncOp::Command)
            },
        )
        .await
        .expect("command");
    }
    assert_eq!(count(db, "SELECT COUNT(*) FROM sync_outbox").await, 3);
}

#[tokio::test]
async fn an_emit_rolled_back_with_its_domain_transaction_leaves_no_row() {
    let world = World::new().await;
    let db = &world.alliance().db;
    let txn = db.begin().await.expect("begin");
    emit_upsert(&txn, 7).await.expect("emit");
    txn.rollback().await.expect("rollback");
    assert_eq!(count(db, "SELECT COUNT(*) FROM sync_outbox").await, 0);
}

#[tokio::test]
async fn state_emits_on_read_only_copies_are_skipped_and_detached_copies_emit() {
    let world = World::new().await;
    let db = &world.guild(1).db;
    db.execute_unprepared(
        "INSERT INTO sync_copies (kind, local_id, origin_tenant_id, origin_id, read_only, state) \
         VALUES ('noop', 7, 'alliance', 1, 1, 'active'), \
                ('noop', 8, 'alliance', 2, 0, 'detached')",
    )
    .await
    .expect("copies");
    assert_eq!(emit_upsert(db, 7).await, None, "active copy: no state");
    assert!(
        emit_upsert(db, 8).await.is_some(),
        "detached copy behaves as origin"
    );
    let command = outbox::emit(
        db,
        SyncEmit {
            command: Some(serde_json::json!({})),
            ordering_key: Some("cmd".into()),
            ..SyncEmit::state("noop", 7, SyncOp::Command)
        },
    )
    .await
    .expect("command");
    assert!(
        command.is_some(),
        "commands are how copies talk to the origin"
    );
}

#[tokio::test]
async fn the_relay_writes_one_job_per_target_and_a_replay_is_a_no_op() {
    let world = World::new().await;
    let handler = Arc::new(Noop::new(&[GUILDS[0], GUILDS[1]]));
    let engine = engine_with(handler);
    let cx = cx(&world, &engine);
    emit_upsert(&world.alliance().db, 42).await.expect("emit");
    let tenants = vec![ALLIANCE.to_owned()];

    let stats = relay_round(&cx, &engine, &tenants, t0())
        .await
        .expect("relay");
    assert_eq!((stats.rows, stats.jobs), (1, 2));
    assert_eq!(
        count(&world.control, "SELECT COUNT(*) FROM sync_jobs").await,
        2
    );

    // Nothing left to relay, and re-relaying the same outbox row is idempotent.
    let stats = relay_round(&cx, &engine, &tenants, t0())
        .await
        .expect("relay");
    assert_eq!(stats.rows, 0);
    world
        .alliance()
        .db
        .execute_unprepared("UPDATE sync_outbox SET relayed_at = NULL")
        .await
        .expect("reset");
    let stats = relay_round(&cx, &engine, &tenants, t0())
        .await
        .expect("replay");
    assert_eq!(stats.rows, 1);
    assert_eq!(stats.jobs, 0, "coalesced replays insert no new job");
    assert_eq!(
        count(&world.control, "SELECT COUNT(*) FROM sync_jobs").await,
        2
    );
}

#[tokio::test]
async fn a_crash_between_job_insert_and_relayed_mark_replays_cleanly() {
    let world = World::new().await;
    let engine = engine_with(Arc::new(Noop::new(&[GUILDS[0], GUILDS[1]])));
    let cx = cx(&world, &engine);
    emit_upsert(&world.alliance().db, 42).await.expect("emit");
    let tenants = vec![ALLIANCE.to_owned()];

    armed::arm("relay.after_jobs");
    // The round logs the failed tenant and keeps going; the rows stay unrelayed.
    let crashed = relay_round(&cx, &engine, &tenants, t0())
        .await
        .expect("round");
    assert_eq!(crashed.rows, 0);
    assert_eq!(
        count(&world.control, "SELECT COUNT(*) FROM sync_jobs").await,
        2
    );
    assert_eq!(
        count(
            &world.alliance().db,
            "SELECT COUNT(*) FROM sync_outbox WHERE relayed_at IS NULL"
        )
        .await,
        1,
        "the crash rolled the relayed mark back"
    );

    relay_round(&cx, &engine, &tenants, t0())
        .await
        .expect("replay");
    assert_eq!(
        count(&world.control, "SELECT COUNT(*) FROM sync_jobs").await,
        2
    );
    assert_eq!(
        count(
            &world.alliance().db,
            "SELECT COUNT(*) FROM sync_outbox WHERE relayed_at IS NULL"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn the_executor_converges_every_target_and_finishes_the_jobs() {
    let world = World::new().await;
    let handler = Arc::new(Noop::new(&[GUILDS[0], GUILDS[1]]));
    let engine = engine_with(handler.clone());
    emit_upsert(&world.alliance().db, 42).await.expect("emit");

    world.run_until_idle(&engine, t0()).await.expect("idle");
    assert_eq!(handler.applies.load(Ordering::SeqCst), 2);
    assert_eq!(
        count(
            &world.control,
            "SELECT COUNT(*) FROM sync_jobs WHERE state = 'done'"
        )
        .await,
        2
    );
    // A finished job replayed by the relay is a no-op, not an error.
    world
        .alliance()
        .db
        .execute_unprepared("UPDATE sync_outbox SET relayed_at = NULL")
        .await
        .expect("reset");
    world.run_until_idle(&engine, t0()).await.expect("replay");
    assert_eq!(handler.applies.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_second_state_job_for_the_same_key_is_folded_into_the_waiting_one() {
    let world = World::new().await;
    let first = jobs::enqueue(&world.control, &job(GUILDS[0], 5, "a"), t0())
        .await
        .expect("first");
    let second = jobs::enqueue(&world.control, &job(GUILDS[0], 9, "b"), t0())
        .await
        .expect("second");
    assert_eq!((first, second), (Enqueued::Inserted, Enqueued::Coalesced));
    assert_eq!(
        count(&world.control, "SELECT COUNT(*) FROM sync_jobs").await,
        1
    );
    assert_eq!(
        count(&world.control, "SELECT origin_version FROM sync_jobs").await,
        9
    );
    // An older version never moves the version backwards.
    jobs::enqueue(&world.control, &job(GUILDS[0], 3, "c"), t0())
        .await
        .expect("older");
    assert_eq!(
        count(&world.control, "SELECT origin_version FROM sync_jobs").await,
        9
    );
    // Once the job has left the waiting states, a replay of its dedupe key
    // neither coalesces nor inserts: it is a duplicate.
    let other = jobs::enqueue(&world.control, &job(GUILDS[1], 4, "d"), t0())
        .await
        .expect("other target");
    assert_eq!(other, Enqueued::Inserted);
    world
        .control
        .execute_unprepared(
            "UPDATE sync_jobs SET state = 'done' WHERE target_tenant_id = 'GUILDS1'"
                .replace("GUILDS1", GUILDS[1])
                .as_str(),
        )
        .await
        .expect("finish");
    let dup = jobs::enqueue(&world.control, &job(GUILDS[1], 4, "d"), t0())
        .await
        .expect("replay");
    assert_eq!(dup, Enqueued::Duplicate);
}

#[tokio::test]
async fn a_retry_is_pulled_forward_by_an_emit_only_after_it_has_been_quiet() {
    let world = World::new().await;
    let handler = Arc::new(Noop::new(&[GUILDS[0]]));
    handler.failures_left.store(1, Ordering::SeqCst);
    let engine = engine_with(handler);
    jobs::enqueue(&world.control, &job(GUILDS[0], 1, "x"), t0())
        .await
        .expect("enqueue");
    execute_round(&cx(&world, &engine), &engine, t0(), 10)
        .await
        .expect("round");
    assert_eq!(
        text(&world.control, "SELECT state FROM sync_jobs").await,
        "retry"
    );
    let due_before = text(&world.control, "SELECT next_attempt_at FROM sync_jobs").await;

    // Just failed (updated now): an emit leaves the due time alone.
    jobs::enqueue(&world.control, &job(GUILDS[0], 2, "y"), t0())
        .await
        .expect("coalesce while busy");
    assert_eq!(
        text(&world.control, "SELECT next_attempt_at FROM sync_jobs").await,
        due_before
    );

    // Quiet for more than 30 s: the emit pulls the retry forward to now.
    let later = t0() + Duration::seconds(31);
    jobs::enqueue(&world.control, &job(GUILDS[0], 3, "z"), later)
        .await
        .expect("coalesce after quiet");
    assert_eq!(
        text(&world.control, "SELECT next_attempt_at FROM sync_jobs").await,
        later.to_rfc3339()
    );
}

#[tokio::test]
async fn a_key_runs_one_job_at_a_time_in_order() {
    let world = World::new().await;
    jobs::enqueue(&world.control, &command_job("c1", "cmd:1"), t0())
        .await
        .expect("c1");
    jobs::enqueue(&world.control, &command_job("c2", "cmd:1"), t0())
        .await
        .expect("c2");
    let kinds = ["noop".to_owned()];
    let first = jobs::claim_due(
        &world.control,
        ClaimRequest {
            limit: 10,
            now: t0(),
            kinds: &kinds,
            excluded_targets: &[],
        },
    )
    .await
    .expect("claim");
    assert_eq!(first.len(), 1, "the second job waits for the first");
    let fence = first[0].fence.token();
    jobs::finish(
        &world.control,
        first[0].id,
        fence,
        &jobs::Finish::new(next_state(1, 8, &Outcome::Done), 1, t0(), Duration::zero()),
        t0(),
    )
    .await
    .expect("finish");
    let second = claim_all(&world, t0()).await;
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].ordering_key, "cmd:1");
    assert_ne!(second[0].id, first[0].id);
}

#[tokio::test]
async fn an_expired_lease_is_taken_over_and_the_old_worker_is_fenced_off() {
    let world = World::new().await;
    jobs::enqueue(&world.control, &job(GUILDS[0], 1, "lease"), t0())
        .await
        .expect("enqueue");
    let old = claim_all(&world, t0()).await;
    assert_eq!(old.len(), 1);
    assert!(
        claim_all(&world, t0() + Duration::seconds(30))
            .await
            .is_empty(),
        "lease still held"
    );

    let takeover = claim_all(&world, t0() + Duration::seconds(61)).await;
    assert_eq!(takeover.len(), 1);
    assert_eq!(takeover[0].attempts, 2);
    let finish = jobs::Finish::new(next_state(1, 12, &Outcome::Done), 1, t0(), Duration::zero());
    let fenced = jobs::finish(
        &world.control,
        old[0].id,
        old[0].fence.token(),
        &finish,
        t0() + Duration::seconds(62),
    )
    .await;
    assert!(matches!(fenced, Err(AppError::Conflict(_))), "{fenced:?}");
    jobs::finish(
        &world.control,
        takeover[0].id,
        takeover[0].fence.token(),
        &finish,
        t0() + Duration::seconds(62),
    )
    .await
    .expect("the new holder finishes");
}

#[tokio::test]
async fn a_failpoint_before_finish_leaves_the_claim_to_its_lease() {
    let world = World::new().await;
    let handler = Arc::new(Noop::new(&[GUILDS[0]]));
    let engine = engine_with(handler.clone());
    jobs::enqueue(&world.control, &job(GUILDS[0], 1, "crash"), t0())
        .await
        .expect("enqueue");
    armed::arm("executor.before_finish");
    assert!(
        execute_round(&cx(&world, &engine), &engine, t0(), 10)
            .await
            .is_err()
    );
    assert_eq!(
        count(
            &world.control,
            "SELECT COUNT(*) FROM sync_jobs WHERE state = 'processing'"
        )
        .await,
        1
    );
    let later = t0() + Duration::seconds(61);
    world
        .run_until_idle(&engine, later)
        .await
        .expect("recovered");
    assert_eq!(
        count(
            &world.control,
            "SELECT COUNT(*) FROM sync_jobs WHERE state = 'done'"
        )
        .await,
        1
    );
}

#[tokio::test]
async fn retries_back_off_then_exhaust_at_the_cap() {
    let world = World::new().await;
    let mut handler = Noop::new(&[GUILDS[0]]);
    handler.max_attempts = 2;
    handler.failures_left.store(10, Ordering::SeqCst);
    let handler = Arc::new(handler);
    let engine = engine_with(handler.clone());
    let capped = NewJob {
        max_attempts: 2,
        ..job(GUILDS[0], 1, "cap")
    };
    jobs::enqueue(&world.control, &capped, t0())
        .await
        .expect("enqueue");
    let cx = cx(&world, &engine);
    execute_round(&cx, &engine, t0(), 10).await.expect("first");
    assert_eq!(
        count(
            &world.control,
            "SELECT COUNT(*) FROM sync_jobs WHERE state = 'retry'"
        )
        .await,
        1
    );
    execute_round(&cx, &engine, t0() + Duration::hours(2), 10)
        .await
        .expect("second");
    let state: String = world
        .control
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT state FROM sync_jobs",
        ))
        .await
        .expect("query")
        .expect("row")
        .try_get_by_index(0)
        .expect("state");
    assert_eq!(state, "exhausted");
    assert_eq!(handler.applies.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn paused_jobs_do_not_burn_an_attempt_and_resume_when_the_tenant_returns() {
    let world = World::new().await;
    jobs::enqueue(&world.control, &job(GUILDS[0], 1, "pause"), t0())
        .await
        .expect("enqueue");
    let claimed = claim_all(&world, t0()).await;
    let finish = jobs::Finish::new(
        next_state(claimed[0].attempts, 12, &Outcome::Paused),
        claimed[0].attempts,
        t0(),
        Duration::zero(),
    );
    assert_eq!(finish.attempts, 0, "the claim attempt is refunded");
    jobs::finish(
        &world.control,
        claimed[0].id,
        claimed[0].fence.token(),
        &finish,
        t0(),
    )
    .await
    .expect("paused");
    assert!(claim_all(&world, t0()).await.is_empty());
    assert_eq!(
        jobs::resume_tenant(&world.control, GUILDS[0], t0())
            .await
            .expect("resume"),
        1
    );
    let resumed = claim_all(&world, t0()).await;
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0].attempts, 1);
}

#[tokio::test]
async fn an_exhausted_job_is_re_armed_only_by_a_tenant_it_belongs_to() {
    let world = World::new().await;
    jobs::enqueue(&world.control, &job(GUILDS[0], 1, "rearm"), t0())
        .await
        .expect("enqueue");
    let claimed = claim_all(&world, t0()).await;
    let finish = jobs::Finish::new(
        next_state(1, 12, &Outcome::Permanent),
        1,
        t0(),
        Duration::zero(),
    );
    jobs::finish(
        &world.control,
        claimed[0].id,
        claimed[0].fence.token(),
        &finish,
        t0(),
    )
    .await
    .expect("exhaust");

    assert!(
        !jobs::rearm(&world.control, claimed[0].id, GUILDS[1], t0())
            .await
            .expect("other")
    );
    assert!(
        jobs::rearm(&world.control, claimed[0].id, ALLIANCE, t0())
            .await
            .expect("origin")
    );
    let rows = jobs::list(
        &world.control,
        &jobs::JobFilter {
            tenant_id: ALLIANCE.into(),
            as_origin: true,
            states: vec!["pending".into()],
            limit: 10,
            ..jobs::JobFilter::default()
        },
    )
    .await
    .expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].attempts, 0);
}

#[tokio::test]
async fn disabled_kinds_are_not_claimed_and_their_jobs_wait() {
    let world = World::new().await;
    let handler = Arc::new(Noop::new(&[GUILDS[0]]));
    let engine = SyncEngine::new(
        HandlerRegistry::new(vec![handler.clone()]),
        SyncSettings::parse("noop", "noop"),
    );
    jobs::enqueue(&world.control, &job(GUILDS[0], 1, "off"), t0())
        .await
        .expect("enqueue");
    assert_eq!(
        execute_round(&cx(&world, &engine), &engine, t0(), 10)
            .await
            .expect("round"),
        0
    );
    assert_eq!(handler.applies.load(Ordering::SeqCst), 0);
    assert_eq!(
        count(
            &world.control,
            "SELECT COUNT(*) FROM sync_jobs WHERE state = 'pending'"
        )
        .await,
        1
    );
}

#[tokio::test]
async fn a_tripped_tenant_is_skipped_for_a_minute_then_admitted_again() {
    let breaker = CircuitBreaker::default();
    for _ in 0..5 {
        breaker.record(GUILDS[0], false, t0());
    }
    assert_eq!(breaker.open_tenants(t0()), vec![GUILDS[0].to_owned()]);
    assert!(
        breaker
            .open_tenants(t0() + Duration::seconds(61))
            .is_empty()
    );
    breaker.record(GUILDS[1], false, t0());
    breaker.record(GUILDS[1], true, t0());
    breaker.record(GUILDS[1], false, t0());
    assert!(
        !breaker.open_tenants(t0()).contains(&GUILDS[1].to_owned()),
        "a success resets the count"
    );
}

#[tokio::test]
async fn an_open_tenant_is_excluded_from_the_claim() {
    let world = World::new().await;
    jobs::enqueue(&world.control, &job(GUILDS[0], 1, "ex"), t0())
        .await
        .expect("g1");
    jobs::enqueue(&world.control, &job(GUILDS[1], 1, "ex2"), t0())
        .await
        .expect("g2");
    let kinds = ["noop".to_owned()];
    let excluded = [GUILDS[0].to_owned()];
    let claimed = jobs::claim_due(
        &world.control,
        ClaimRequest {
            limit: 10,
            now: t0(),
            kinds: &kinds,
            excluded_targets: &excluded,
        },
    )
    .await
    .expect("claim");
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].target_tenant_id, GUILDS[1]);
}

#[tokio::test]
async fn the_command_inbox_admits_only_newer_pairs_across_emitters() {
    let world = World::new().await;
    let db = &world.alliance().db;
    let a = t0();
    let b = t0() + Duration::seconds(1);
    assert!(inbox::admit(db, "cmd:42:1", a, 1).await.expect("first"));
    assert!(!inbox::admit(db, "cmd:42:1", a, 1).await.expect("same pair"));
    // Emitter B issued later: admitted even with a smaller seq.
    assert!(
        inbox::admit(db, "cmd:42:1", b, 1)
            .await
            .expect("later emitter")
    );
    // An old command from emitter A arriving late is superseded.
    assert!(!inbox::admit(db, "cmd:42:1", a, 9).await.expect("late"));
    // Another ordering key is independent.
    assert!(inbox::admit(db, "cmd:42:2", a, 1).await.expect("other key"));
}

#[tokio::test]
async fn the_tenant_tables_default_copies_to_discord_delivery_and_number_outbox_rows() {
    let world = World::new().await;
    let db = &world.guild(2).db;
    db.execute_unprepared(
        "INSERT INTO sync_copies (kind, local_id, origin_tenant_id, origin_id) VALUES ('noop', 1, 'a', 1)",
    )
    .await
    .expect("copy");
    assert_eq!(
        count(
            db,
            "SELECT COUNT(*) FROM sync_copies WHERE deliver_discord = 1 AND read_only = 1"
        )
        .await,
        1
    );
    let first = emit_upsert(db, 2).await.expect("row");
    let second = outbox::emit(db, SyncEmit::state("build", 1, SyncOp::Upsert))
        .await
        .expect("row")
        .expect("written");
    assert!(second > first, "ids ascend");
}

#[tokio::test]
async fn purge_keeps_recent_history_and_drops_old_finished_jobs() {
    let world = World::new().await;
    for (key, state, age) in [
        ("p1", "done", 31),
        ("p2", "done", 1),
        ("p3", "cancelled", 8),
    ] {
        jobs::enqueue(
            &world.control,
            &command_job(key, key),
            t0() - Duration::days(age),
        )
        .await
        .expect("enqueue");
        world
            .control
            .execute_unprepared(&format!(
                "UPDATE sync_jobs SET state = '{state}', completed_at = '{}' WHERE dedupe_key LIKE '%:{key}'",
                (t0() - Duration::days(age)).to_rfc3339()
            ))
            .await
            .expect("finish");
    }
    let removed = jobs::purge(&world.control, t0()).await.expect("purge");
    assert_eq!(removed, 2, "30-day done and 7-day cancelled");
    assert_eq!(
        count(&world.control, "SELECT COUNT(*) FROM sync_jobs").await,
        1
    );
}

#[tokio::test]
async fn the_summary_counts_unfinished_jobs_of_the_caller_only() {
    let world = World::new().await;
    jobs::enqueue(&world.control, &job(GUILDS[0], 1, "s1"), t0())
        .await
        .expect("s1");
    jobs::enqueue(&world.control, &job(GUILDS[1], 1, "s2"), t0())
        .await
        .expect("s2");
    let g1 = jobs::summary(&world.control, GUILDS[0])
        .await
        .expect("summary");
    assert_eq!(g1, vec![("noop".to_owned(), "pending".to_owned(), 1)]);
    let g3 = jobs::summary(&world.control, GUILDS[2])
        .await
        .expect("summary");
    assert!(g3.is_empty());
}

#[tokio::test]
async fn rearm_of_an_unknown_job_matches_nothing() {
    let world = World::new().await;
    let id = uuid::Uuid::new_v4();
    assert!(
        !jobs::rearm(&world.control, id, ALLIANCE, t0())
            .await
            .expect("rearm")
    );
}

#[test]
fn the_failpoint_fires_once_and_only_when_armed() {
    armed::arm("unit.point");
    assert!(super::failpoint::check("unit.point").is_err());
    assert!(super::failpoint::check("unit.point").is_ok());
    assert!(super::failpoint::check("never.armed").is_ok());
}
