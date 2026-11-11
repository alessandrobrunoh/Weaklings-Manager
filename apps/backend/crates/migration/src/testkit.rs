//! Migrated tenant SQLite databases without running every migration per test.
//!
//! Applying the tenant migrations is the bulk of a SQLite-backed test's run time, and
//! hundreds of tests each need their own freshly migrated database. The migrations
//! therefore run once per test process, on a template database whose final state is
//! captured as a SQL script; every test database replays that script in one
//! transaction. The replayed database has the same `sqlite_master` entries (same SQL
//! text, so the same columns, constraints and indexes), the same rows (including
//! `seaql_migrations`, so `Migrator::up` stays a no-op and `Migrator::down` still
//! works) and the same `AUTOINCREMENT` counters as one migrated directly.
//!
//! Tests about the migrations themselves keep calling `Migrator::up`.

use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement, TransactionTrait,
};
use sea_orm_migration::MigratorTrait;
use tokio::sync::OnceCell;

static TENANT_SCHEMA_SCRIPT: OnceCell<String> = OnceCell::const_new();

/// A new in-memory SQLite database carrying every tenant migration: the same as
/// connecting to `sqlite::memory:` and running `Migrator::up`, only faster.
///
/// # Panics
///
/// Panics when SQLite or a migration fails.
pub async fn migrated_sqlite() -> DatabaseConnection {
    let db = Database::connect("sqlite::memory:")
        .await
        .expect("tenant sqlite");
    apply_tenant_schema(&db).await;
    db
}

/// Brings an empty SQLite database to the fully migrated tenant schema, seeded rows
/// included.
///
/// # Panics
///
/// Panics when SQLite or a migration fails.
pub async fn apply_tenant_schema(db: &DatabaseConnection) {
    let script = TENANT_SCHEMA_SCRIPT
        .get_or_init(capture_tenant_schema)
        .await;
    let txn = db.begin().await.expect("begin tenant schema");
    txn.execute_unprepared(script)
        .await
        .expect("replay tenant schema");
    txn.commit().await.expect("commit tenant schema");
}

/// Migrates a template database and returns a script recreating it: tables, rows,
/// `AUTOINCREMENT` counters, then indexes, then triggers and views (after the rows,
/// so no trigger fires while they are copied).
async fn capture_tenant_schema() -> String {
    let db = Database::connect("sqlite::memory:")
        .await
        .expect("template sqlite");
    crate::Migrator::up(&db, None)
        .await
        .expect("tenant migrations");

    let objects = db
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT type, name, sql FROM sqlite_master \
             WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY rowid",
        ))
        .await
        .expect("template sqlite_master");

    // Rows are copied with foreign keys checked at commit, not per row.
    let mut script = String::from("PRAGMA defer_foreign_keys = ON;\n");
    let mut tables = Vec::new();
    let mut indexes = Vec::new();
    let mut late = Vec::new();
    for object in &objects {
        let kind: String = object.try_get_by_index(0).expect("type");
        let name: String = object.try_get_by_index(1).expect("name");
        let sql: String = object.try_get_by_index(2).expect("sql");
        match kind.as_str() {
            "table" => {
                script.push_str(&sql);
                script.push_str(";\n");
                tables.push(name);
            }
            "index" => indexes.push(sql),
            _ => late.push(sql),
        }
    }

    for table in &tables {
        for insert in strings(&db, &insert_statements_query(&db, table).await).await {
            script.push_str(&insert);
            script.push('\n');
        }
    }

    let has_sequence = !strings(
        &db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
    )
    .await
    .is_empty();
    if has_sequence {
        // The copied rows bumped the counters to their max ids; restore the template's.
        script.push_str("DELETE FROM sqlite_sequence;\n");
        for insert in strings(
            &db,
            "SELECT 'INSERT INTO sqlite_sequence (name, seq) VALUES (' \
             || quote(name) || ', ' || quote(seq) || ');' FROM sqlite_sequence",
        )
        .await
        {
            script.push_str(&insert);
            script.push('\n');
        }
    }

    for sql in indexes.iter().chain(&late) {
        script.push_str(sql);
        script.push_str(";\n");
    }

    let user_version = db
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "PRAGMA user_version",
        ))
        .await
        .expect("user_version")
        .map_or(0, |row| {
            row.try_get_by_index::<i64>(0).expect("user_version")
        });
    if user_version != 0 {
        script.push_str(&format!("PRAGMA user_version = {user_version};\n"));
    }
    script
}

/// A query yielding one `INSERT` statement per row of `table`, values rendered with
/// SQLite's own `quote()` so every type round-trips exactly.
async fn insert_statements_query(db: &DatabaseConnection, table: &str) -> String {
    let columns = strings(
        db,
        &format!(
            "SELECT name FROM pragma_table_xinfo({}) WHERE hidden = 0 ORDER BY cid",
            literal(table)
        ),
    )
    .await;
    let column_list = columns
        .iter()
        .map(|column| ident(column))
        .collect::<Vec<_>>()
        .join(", ");
    let values = columns
        .iter()
        .map(|column| format!("quote({})", ident(column)))
        .collect::<Vec<_>>()
        .join(" || ', ' || ");
    let prefix = format!("INSERT INTO {} ({column_list}) VALUES (", ident(table));
    format!(
        "SELECT {} || {values} || ');' FROM {}",
        literal(&prefix),
        ident(table)
    )
}

async fn strings(db: &DatabaseConnection, sql: &str) -> Vec<String> {
    db.query_all(Statement::from_string(DbBackend::Sqlite, sql))
        .await
        .unwrap_or_else(|err| panic!("template query `{sql}`: {err}"))
        .iter()
        .map(|row| row.try_get_by_index::<String>(0).expect("text column"))
        .collect()
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// A throwaway tenant schema (all tenant migrations applied) on `TEST_DATABASE_URL`.
pub struct TenantSchema {
    /// Connection whose `search_path` is the migrated schema.
    pub db: DatabaseConnection,
    admin: DatabaseConnection,
    schema: String,
}

impl TenantSchema {
    /// Creates and migrates a fresh schema; `None` when `TEST_DATABASE_URL` is not set.
    ///
    /// # Panics
    ///
    /// Panics when the schema cannot be created, connected to or migrated.
    pub async fn try_new(prefix: &str) -> Option<Self> {
        let (url, admin) = backend_core::postgres::test_support::try_admin_db().await?;
        let schema = backend_core::postgres::test_support::unique_schema(prefix);
        backend_core::postgres::ensure_schema(&admin, &schema)
            .await
            .expect("create tenant schema");
        let db = backend_core::postgres::connect_with_search_path(&url, &schema)
            .await
            .expect("connect tenant schema");
        crate::Migrator::up(&db, None)
            .await
            .expect("migrate tenant schema");
        Some(Self { db, admin, schema })
    }

    /// Drops the schema; call at the end of the test.
    pub async fn cleanup(self) {
        let _ = backend_core::postgres::drop_schema(&self.admin, &self.schema).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn snapshot(db: &DatabaseConnection) -> (Vec<String>, Vec<String>, Vec<String>) {
        let schema = strings(
            db,
            "SELECT type || ' ' || name || ' ' || COALESCE(sql, '') FROM sqlite_master \
             WHERE name != 'sqlite_sequence' ORDER BY type, name",
        )
        .await;
        let sequence = strings(
            db,
            "SELECT name || '=' || seq FROM sqlite_sequence ORDER BY name",
        )
        .await;
        let mut data = Vec::new();
        for table in strings(
            db,
            "SELECT name FROM sqlite_master WHERE type = 'table' \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name != 'seaql_migrations' \
             ORDER BY name",
        )
        .await
        {
            let query = insert_statements_query(db, &table).await;
            let mut inserts: Vec<String> = strings(db, &query)
                .await
                .iter()
                .map(|row| mask_timestamps(row))
                .collect();
            inserts.sort();
            data.extend(inserts);
        }
        data.extend(strings(db, "SELECT version FROM seaql_migrations ORDER BY version").await);
        (schema, sequence, data)
    }

    /// Seed rows default their timestamps to `CURRENT_TIMESTAMP`, so the
    /// shared template and a fresh migration differ only in when they ran.
    fn mask_timestamps(row: &str) -> String {
        row.split('\'')
            .enumerate()
            .map(|(i, part)| {
                if i % 2 == 1 && looks_like_timestamp(part) {
                    "<ts>"
                } else {
                    part
                }
            })
            .collect::<Vec<_>>()
            .join("'")
    }

    fn looks_like_timestamp(text: &str) -> bool {
        let bytes = text.as_bytes();
        bytes.len() >= 19
            && bytes[..19].iter().enumerate().all(|(i, c)| match i {
                4 | 7 => *c == b'-',
                10 => *c == b' ' || *c == b'T',
                13 | 16 => *c == b':',
                _ => c.is_ascii_digit(),
            })
    }

    #[tokio::test]
    async fn replayed_schema_matches_a_directly_migrated_database() {
        let migrated = Database::connect("sqlite::memory:").await.expect("sqlite");
        crate::Migrator::up(&migrated, None)
            .await
            .expect("tenant migrations");
        let replayed = migrated_sqlite().await;

        assert_eq!(snapshot(&replayed).await, snapshot(&migrated).await);
        crate::Migrator::up(&replayed, None)
            .await
            .expect("nothing left to apply");
        assert!(
            crate::Migrator::get_pending_migrations(&replayed)
                .await
                .expect("pending")
                .is_empty()
        );
    }
}
