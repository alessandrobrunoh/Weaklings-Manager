//! One-shot backfill: promote the current single-tenant `public` schema to tenant #1.
//!
//! Moves every ordinary table out of the source schema with
//! `ALTER TABLE ... SET SCHEMA` (metadata-only) and registers the Discord guild
//! as a control-plane tenant. Destructive against the source schema.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, Statement, TransactionTrait, Value};
use thiserror::Error;

use crate::config::Config;
use crate::control_migration::{self, MigratorTrait, SUPERADMIN_ROLE_ID};
use crate::postgres::{
    self, CONTROL_SCHEMA, list_user_tables, quote_ident, schema_exists, table_row_count,
};

/// Tables the plan uses as post-move witnesses. Missing tables are skipped
/// (a brand-new database may not have created them yet).
const WITNESS_TABLES: &[&str] = &["users", "events", "splits", "roles"];

/// How the operator asked the backfill to run.
#[derive(Debug, Clone)]
pub struct BackfillParams {
    /// Discord guild snowflake; becomes `tenants.id`.
    pub tenant_id: String,
    /// Unique URL-ish slug stored on `tenants`.
    pub slug: String,
    /// Display name stored on `tenants`.
    pub name: String,
    /// Discord user id seeded as the `SuperAdmin` assignment.
    pub owner_discord_id: String,
    /// Schema that currently holds tenant tables (`public` in production).
    pub source_schema: String,
}

impl BackfillParams {
    /// Builds params from deployment config. Source schema is always `public`.
    #[must_use]
    pub fn from_config(cfg: &Config) -> Self {
        let tenant_id = cfg.discord_guild_id.clone();
        Self {
            slug: tenant_slug(&tenant_id).unwrap_or_else(|_| tenant_id.clone()),
            name: tenant_id.clone(),
            owner_discord_id: cfg.super_admin_discord_id.clone(),
            tenant_id,
            source_schema: "public".to_owned(),
        }
    }
}

/// Per-table row counts captured before the move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackfillReport {
    /// Discord guild id / `tenants.id`.
    pub tenant_id: String,
    /// Schema the tables were moved into.
    pub schema_name: String,
    /// `(table, count)` in name order.
    pub counts: Vec<(String, i64)>,
}

/// Outcome of a backfill attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackfillOutcome {
    /// Tables moved and the control-plane row was inserted.
    Moved(BackfillReport),
    /// Tenant already registered and the source schema is empty — safe no-op.
    AlreadyDone {
        /// Discord guild id.
        tenant_id: String,
        /// Schema already holding the data.
        schema_name: String,
    },
}

/// Backfill failures. Count mismatches panic via `assert_eq!` as required by the plan.
#[derive(Debug, Error)]
pub enum BackfillError {
    /// `discord_guild_id` cannot be turned into a Postgres schema name.
    #[error("discord guild id `{0}` cannot be used as a postgres schema name")]
    InvalidGuildId(String),
    /// Control-plane already has this tenant but leftover tables remain in the source schema.
    #[error(
        "tenant `{tenant_id}` is registered as `{schema_name}` but `{source_schema}` still has tables"
    )]
    PartialState {
        /// Tenant id.
        tenant_id: String,
        /// Registered schema.
        schema_name: String,
        /// Schema that still has tables.
        source_schema: String,
    },
    /// Target schema exists without a matching `tenants` row.
    #[error("schema `{0}` already exists")]
    SchemaExists(String),
    /// Underlying database error.
    #[error(transparent)]
    Db(#[from] DbErr),
}

/// `tenant_<sanitized guild id>` — the schema that will hold this tenant's tables.
///
/// # Errors
///
/// Returns [`BackfillError::InvalidGuildId`] when the id contains characters
/// that cannot appear in a Postgres identifier.
pub fn tenant_schema_name(discord_guild_id: &str) -> Result<String, BackfillError> {
    let slug = tenant_slug(discord_guild_id)?;
    let name = format!("tenant_{slug}");
    postgres::validate_schema_name(&name)
        .map_err(|_| BackfillError::InvalidGuildId(discord_guild_id.to_owned()))?;
    Ok(name)
}

/// Lowercase `[a-z0-9_]+` form of a Discord guild id, hyphens folded to underscores.
///
/// # Errors
///
/// Returns [`BackfillError::InvalidGuildId`] when the id is empty or contains
/// characters other than ASCII letters, digits, `_`, or `-`.
pub fn tenant_slug(discord_guild_id: &str) -> Result<String, BackfillError> {
    let mut slug = String::with_capacity(discord_guild_id.len());
    for b in discord_guild_id.bytes() {
        match b {
            b'A'..=b'Z' => slug.push(char::from(b + 32)),
            b'a'..=b'z' | b'0'..=b'9' => slug.push(char::from(b)),
            b'-' | b'_' => {
                if !slug.ends_with('_') {
                    slug.push('_');
                }
            }
            _ => return Err(BackfillError::InvalidGuildId(discord_guild_id.to_owned())),
        }
    }
    let slug = slug.trim_matches('_');
    if slug.is_empty() {
        return Err(BackfillError::InvalidGuildId(discord_guild_id.to_owned()));
    }
    Ok(slug.to_owned())
}

/// Ensures the control-plane schema exists and is migrated, then returns that connection.
///
/// # Errors
///
/// Returns a database error if the schema cannot be created, the pool cannot
/// connect, or control-plane migrations fail.
pub async fn prepare_control_plane(
    admin: &DatabaseConnection,
    control_database_url: &str,
) -> Result<DatabaseConnection, DbErr> {
    postgres::ensure_schema(admin, CONTROL_SCHEMA).await?;
    let control = postgres::connect_with_search_path(control_database_url, CONTROL_SCHEMA).await?;
    control_migration::Migrator::up(&control, None).await?;
    Ok(control)
}

/// Database used by the HTTP process until Stage 3 introduces per-request tenant routing.
///
/// - no active tenants: migrate and serve `public` (pre-backfill)
/// - one active tenant: pin the whole process to that schema
/// - more than one: refuse to start — Stage 3 is required
///
/// # Errors
///
/// Returns a database error if migrations fail, the tenant schema name is
/// invalid, or more than one active tenant is registered.
pub async fn runtime_database(
    admin: DatabaseConnection,
    control: &DatabaseConnection,
    database_url: &str,
) -> Result<DatabaseConnection, DbErr> {
    use crate::migration::{Migrator, MigratorTrait};

    let active = postgres::list_active_tenants(control).await?;
    match active.as_slice() {
        [] => {
            Migrator::up(&admin, None).await?;
            Ok(admin)
        }
        [tenant] => {
            postgres::validate_schema_name(&tenant.schema_name)?;
            let db = postgres::connect_with_search_path(database_url, &tenant.schema_name).await?;
            Migrator::up(&db, None).await?;
            Ok(db)
        }
        _ => Err(DbErr::Custom(
            "multiple active tenants are registered; stage 3 tenant middleware is required".into(),
        )),
    }
}

/// Moves source-schema tables into `tenant_<id>` and registers the tenant.
///
/// # Errors
///
/// Returns [`BackfillError`] when the guild id is invalid, the tenant is in a
/// partial state, the target schema already exists, or the database rejects
/// the move.
///
/// # Panics
///
/// Panics if a table's row count after `SET SCHEMA` does not equal the count
/// taken immediately before the move.
pub async fn backfill_tenant_one(
    admin: &DatabaseConnection,
    params: &BackfillParams,
) -> Result<BackfillOutcome, BackfillError> {
    postgres::validate_schema_name(&params.source_schema)?;
    let schema_name = tenant_schema_name(&params.tenant_id)?;

    if let Some(existing) = load_tenant(admin, &params.tenant_id).await? {
        let leftover = list_user_tables(admin, &params.source_schema).await?;
        if leftover.is_empty() {
            return Ok(BackfillOutcome::AlreadyDone {
                tenant_id: params.tenant_id.clone(),
                schema_name: existing,
            });
        }
        return Err(BackfillError::PartialState {
            tenant_id: params.tenant_id.clone(),
            schema_name: existing,
            source_schema: params.source_schema.clone(),
        });
    }

    if schema_exists(admin, &schema_name).await? {
        return Err(BackfillError::SchemaExists(schema_name));
    }

    let tables = list_user_tables(admin, &params.source_schema).await?;
    let mut before = Vec::with_capacity(tables.len());
    for table in &tables {
        let count = table_row_count(admin, &params.source_schema, table).await?;
        before.push((table.clone(), count));
    }

    let txn = admin.begin().await?;
    txn.execute(Statement::from_string(
        txn.get_database_backend(),
        format!("CREATE SCHEMA {}", quote_ident(&schema_name)),
    ))
    .await?;
    for table in &tables {
        txn.execute(Statement::from_string(
            txn.get_database_backend(),
            format!(
                "ALTER TABLE {}.{} SET SCHEMA {}",
                quote_ident(&params.source_schema),
                quote_ident(table),
                quote_ident(&schema_name)
            ),
        ))
        .await?;
    }

    let mut after = Vec::with_capacity(tables.len());
    for table in &tables {
        let count = table_row_count(&txn, &schema_name, table).await?;
        after.push((table.clone(), count));
    }
    assert_eq!(
        before, after,
        "row counts diverged while moving tables to {schema_name}"
    );

    insert_tenant(&txn, params, &schema_name).await?;
    insert_superadmin_assignment(&txn, &params.owner_discord_id).await?;
    txn.commit().await?;

    let leftover = list_user_tables(admin, &params.source_schema).await?;
    assert!(
        leftover.is_empty(),
        "source schema {} still has tables after backfill: {leftover:?}",
        params.source_schema
    );
    for witness in WITNESS_TABLES {
        if before.iter().any(|(table, _)| table == witness) {
            assert!(
                !leftover.iter().any(|table| table == witness),
                "{witness} is still in {}",
                params.source_schema
            );
        }
    }

    Ok(BackfillOutcome::Moved(BackfillReport {
        tenant_id: params.tenant_id.clone(),
        schema_name,
        counts: after,
    }))
}

async fn load_tenant(admin: &DatabaseConnection, tenant_id: &str) -> Result<Option<String>, DbErr> {
    let row = admin
        .query_one(Statement::from_sql_and_values(
            admin.get_database_backend(),
            format!(
                "SELECT schema_name FROM {}.tenants WHERE id = $1",
                quote_ident(CONTROL_SCHEMA)
            ),
            [tenant_id.into()],
        ))
        .await?;
    match row {
        Some(row) => Ok(Some(row.try_get_by_index(0)?)),
        None => Ok(None),
    }
}

async fn insert_tenant(
    db: &impl ConnectionTrait,
    params: &BackfillParams,
    schema_name: &str,
) -> Result<(), DbErr> {
    db.execute(Statement::from_sql_and_values(
        db.get_database_backend(),
        format!(
            "INSERT INTO {}.tenants (id, slug, name, schema_name, status, owner_discord_id) \
             VALUES ($1, $2, $3, $4, 'active', $5)",
            quote_ident(CONTROL_SCHEMA)
        ),
        [
            params.tenant_id.clone().into(),
            params.slug.clone().into(),
            params.name.clone().into(),
            schema_name.into(),
            params.owner_discord_id.clone().into(),
        ],
    ))
    .await?;
    Ok(())
}

async fn insert_superadmin_assignment(
    db: &impl ConnectionTrait,
    discord_id: &str,
) -> Result<(), DbErr> {
    db.execute(Statement::from_sql_and_values(
        db.get_database_backend(),
        format!(
            "INSERT INTO {}.platform_role_assignments (discord_id, platform_role_id, assigned_by) \
             VALUES ($1, $2::uuid, $3) \
             ON CONFLICT (discord_id, platform_role_id) DO NOTHING",
            quote_ident(CONTROL_SCHEMA)
        ),
        [
            discord_id.into(),
            Value::from(SUPERADMIN_ROLE_ID),
            Value::from("backfill_tenant_one"),
        ],
    ))
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::postgres::test_support::{cleanup_control_tenant, try_admin_db, unique_schema};
    use crate::postgres::{connect_with_search_path, drop_schema, ensure_schema};

    #[test]
    fn schema_name_from_snowflake() {
        assert_eq!(
            tenant_schema_name("123456789012345678").unwrap(),
            "tenant_123456789012345678"
        );
        assert_eq!(
            tenant_slug("123456789012345678").unwrap(),
            "123456789012345678"
        );
    }

    #[test]
    fn schema_name_folds_hyphens_and_case() {
        assert_eq!(tenant_schema_name("My-Guild").unwrap(), "tenant_my_guild");
        assert_eq!(tenant_slug("My-Guild").unwrap(), "my_guild");
    }

    #[test]
    fn schema_name_rejects_injection() {
        assert!(tenant_schema_name("foo;drop table users").is_err());
        assert!(tenant_schema_name("").is_err());
        assert!(tenant_schema_name("---").is_err());
        assert!(tenant_schema_name("foo\"bar").is_err());
    }

    #[test]
    fn from_config_uses_public_and_guild_id() {
        let cfg = Config {
            backend_port: 3000,
            database_url: "postgres://localhost/db".into(),
            control_database_url: None,
            discord_client_id: "id".into(),
            discord_client_secret: "secret".into(),
            discord_redirect_uri: "http://localhost/callback".into(),
            discord_guild_id: "999888777".into(),
            bot_api_secret: None,
            discord_bot_token: None,
            super_admin_discord_id: "admin-1".into(),
            session_secret: "x".repeat(64),
            frontend_url: "http://localhost".into(),
            albion_api_region: "europe".into(),
            albion_guild_id: "albion".into(),
            albion_allied_guild_ids: String::new(),
            albion_allied_guild_names: String::new(),
            mistral_api_key: String::new(),
            albionbb_base_url: "http://localhost".into(),
            albionbb_request_timeout_secs: 60,
            albiondata_request_timeout_secs: 30,
        };
        let params = BackfillParams::from_config(&cfg);
        assert_eq!(params.tenant_id, "999888777");
        assert_eq!(params.slug, "999888777");
        assert_eq!(params.source_schema, "public");
        assert_eq!(params.owner_discord_id, "admin-1");
        assert_eq!(
            tenant_schema_name(&params.tenant_id).unwrap(),
            "tenant_999888777"
        );
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn moves_tables_and_seeds_superadmin_then_is_idempotent() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };

        let source = unique_schema("it_bfsrc");
        let tenant_id = unique_schema("g");
        let owner = format!("owner_{tenant_id}");
        let target = tenant_schema_name(&tenant_id).expect("schema name");

        ensure_schema(&admin, CONTROL_SCHEMA)
            .await
            .expect("control schema");
        let control = connect_with_search_path(&url, CONTROL_SCHEMA)
            .await
            .expect("control connect");
        control_migration::Migrator::up(&control, None)
            .await
            .expect("control migrations");

        ensure_schema(&admin, &source).await.expect("source schema");
        let src = connect_with_search_path(&url, &source)
            .await
            .expect("source connect");
        src.execute_unprepared(
            "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL); \
             CREATE TABLE roles (id text PRIMARY KEY, name text NOT NULL); \
             CREATE TABLE events (id serial PRIMARY KEY); \
             CREATE TABLE splits (id serial PRIMARY KEY); \
             CREATE TABLE seaql_migrations (version varchar NOT NULL PRIMARY KEY); \
             INSERT INTO users (name) VALUES ('alice'), ('bob'); \
             INSERT INTO roles (id, name) VALUES ('1', 'Admin'); \
             INSERT INTO events DEFAULT VALUES; \
             INSERT INTO events DEFAULT VALUES; \
             INSERT INTO events DEFAULT VALUES; \
             INSERT INTO seaql_migrations (version) VALUES ('m1');",
        )
        .await
        .expect("seed source");

        let params = BackfillParams {
            tenant_id: tenant_id.clone(),
            slug: tenant_slug(&tenant_id).unwrap(),
            name: "Test Guild".into(),
            owner_discord_id: owner.clone(),
            source_schema: source.clone(),
        };

        let outcome = backfill_tenant_one(&admin, &params)
            .await
            .expect("first backfill");
        let BackfillOutcome::Moved(report) = outcome else {
            panic!("expected Moved, got {outcome:?}");
        };
        assert_eq!(report.schema_name, target);
        let counts: std::collections::HashMap<_, _> = report.counts.into_iter().collect();
        assert_eq!(counts.get("users").copied(), Some(2));
        assert_eq!(counts.get("roles").copied(), Some(1));
        assert_eq!(counts.get("events").copied(), Some(3));
        assert_eq!(counts.get("splits").copied(), Some(0));
        assert_eq!(counts.get("seaql_migrations").copied(), Some(1));

        let source_tables = list_user_tables(&admin, &source)
            .await
            .expect("list source");
        assert!(source_tables.is_empty(), "{source_tables:?}");
        let target_tables = list_user_tables(&admin, &target)
            .await
            .expect("list target");
        for required in ["users", "roles", "events", "splits", "seaql_migrations"] {
            assert!(
                target_tables.iter().any(|t| t == required),
                "missing {required} in {target_tables:?}"
            );
        }

        let status: String = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT status FROM tenants WHERE id = $1",
                [tenant_id.clone().into()],
            ))
            .await
            .expect("tenant query")
            .expect("tenant row")
            .try_get_by_index(0)
            .expect("status");
        assert_eq!(status, "active");

        let assigned: i64 = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT count(*) FROM platform_role_assignments \
                 WHERE discord_id = $1 AND platform_role_id = $2::uuid",
                [owner.clone().into(), Value::from(SUPERADMIN_ROLE_ID)],
            ))
            .await
            .expect("assignment query")
            .expect("row")
            .try_get_by_index(0)
            .expect("count");
        assert_eq!(assigned, 1);

        let again = backfill_tenant_one(&admin, &params)
            .await
            .expect("second backfill");
        assert_eq!(
            again,
            BackfillOutcome::AlreadyDone {
                tenant_id: tenant_id.clone(),
                schema_name: target.clone(),
            }
        );

        drop_schema(&admin, &target).await.expect("drop target");
        drop_schema(&admin, &source).await.expect("drop source");
        cleanup_control_tenant(&control, &tenant_id, &owner)
            .await
            .expect("cleanup control");
    }
}
