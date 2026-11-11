//! Counts the SQL statements a test runs against its own in-memory SQLite database.
//!
//! `SQLx` logs every statement as a `tracing` event with a `sqlx::query` target, but it emits
//! that event from the connection's worker thread, not from the caller. Each counted
//! database therefore gets a worker thread named after a unique tag, and one process-wide
//! layer counts the events by that tag. Tests running in parallel never see each other's
//! statements.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Once, OnceLock};

use sea_orm::{ConnectOptions, Database, DatabaseConnection};
use tracing::{Event, Subscriber};
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::{Layer, Registry};

const THREAD_PREFIX: &str = "sqlx-counted-";

type Counters = Mutex<HashMap<String, Arc<AtomicUsize>>>;

fn counters() -> &'static Counters {
    static COUNTERS: OnceLock<Counters> = OnceLock::new();
    COUNTERS.get_or_init(Counters::default)
}

static NEXT_TAG: AtomicU64 = AtomicU64::new(0);

struct CountLayer;

impl<S: Subscriber> Layer<S> for CountLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        if !event.metadata().target().starts_with("sqlx::query") {
            return;
        }
        let Some(thread) = std::thread::current().name().map(str::to_owned) else {
            return;
        };
        // Worker threads are named `sqlx-counted-{tag}-{worker id}`.
        let Some((tag, _)) = thread
            .strip_prefix(THREAD_PREFIX)
            .and_then(|rest| rest.rsplit_once('-'))
        else {
            return;
        };
        let counter = counters().lock().ok().and_then(|map| map.get(tag).cloned());
        if let Some(counter) = counter {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    }
}

fn install_layer() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        // Another subscriber may already be global; the counts then stay at zero, which the
        // callers' sanity assertions catch. The filter keeps every other span and event
        // disabled, so the process-wide subscriber costs the rest of the suite nothing.
        let layer =
            CountLayer.with_filter(filter_fn(|meta| meta.target().starts_with("sqlx::query")));
        let _ = tracing::subscriber::set_global_default(Registry::default().with(layer));
    });
}

/// An in-memory SQLite database whose statements are counted.
pub struct CountedDb {
    db: DatabaseConnection,
    counter: Arc<AtomicUsize>,
}

impl CountedDb {
    /// Opens a new, empty in-memory SQLite database.
    ///
    /// # Panics
    ///
    /// Panics when SQLite cannot be opened.
    pub async fn sqlite_memory() -> Self {
        install_layer();
        let tag = NEXT_TAG.fetch_add(1, Ordering::SeqCst).to_string();
        let counter = Arc::new(AtomicUsize::new(0));
        counters()
            .lock()
            .expect("query counters")
            .insert(tag.clone(), Arc::clone(&counter));

        let mut options = ConnectOptions::new("sqlite::memory:");
        options.map_sqlx_sqlite_opts(move |sqlite| {
            let tag = tag.clone();
            sqlite.thread_name(move |worker| format!("{THREAD_PREFIX}{tag}-{worker}"))
        });
        let db = Database::connect(options)
            .await
            .expect("counted sqlite database");
        Self { db, counter }
    }

    /// The connection; cloning it shares the same counted database.
    #[must_use]
    pub fn connection(&self) -> DatabaseConnection {
        self.db.clone()
    }

    /// Statements executed against this database so far.
    #[must_use]
    pub fn statements(&self) -> usize {
        self.counter.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};

    use super::CountedDb;

    #[tokio::test]
    async fn counts_each_statement_run_against_the_database() {
        let counted = CountedDb::sqlite_memory().await;
        let db = counted.connection();
        // Opening the connection runs its own setup statements; count from here.
        let before = counted.statements();
        for _ in 0..3 {
            db.query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT 1".to_owned(),
            ))
            .await
            .expect("select");
        }
        assert_eq!(counted.statements() - before, 3);
    }

    #[tokio::test]
    async fn one_database_does_not_count_another() {
        let busy = CountedDb::sqlite_memory().await;
        let idle = CountedDb::sqlite_memory().await;
        let (busy_before, idle_before) = (busy.statements(), idle.statements());
        busy.connection()
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT 1".to_owned(),
            ))
            .await
            .expect("select");
        assert_eq!(busy.statements() - busy_before, 1);
        assert_eq!(idle.statements(), idle_before);
    }
}
