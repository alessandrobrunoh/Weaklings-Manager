//! Postgres helpers for schema-per-tenant isolation.
//!
//! `SeaORM`'s [`sea_orm::ConnectOptions::set_schema_search_path`] runs
//! `SET search_path = "<schema>"` on every pooled connection via `after_connect`.
//! That is the mechanism Stage 3 will use for per-tenant pools; this module is the
//! shared, tested entry point.
//!
//! The control-plane lives in [`CONTROL_SCHEMA`]; each tenant lives in its own
//! `tenant_<slug>` schema (see [`tenant_schema_name`]). Both migrators write their
//! own `seaql_migrations` bookkeeping into whichever schema is on `search_path`,
//! so dedicated schemas keep those trackers from mixing.

use sea_orm::{ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbErr, Statement};

/// Schema that holds control-plane tables (`tenants`, platform roles, feature flags).
pub const CONTROL_SCHEMA: &str = "control";

/// Maximum length of a Postgres identifier (bytes).
const MAX_IDENT_LEN: usize = 63;

/// Returns an error unless `schema` is a safe unquoted Postgres identifier.
///
/// Allowed: a lowercase ASCII letter, then lowercase letters, digits, or `_`,
/// at most 63 bytes. Rejecting anything else keeps `CREATE SCHEMA` interpolation
/// from becoming SQL injection when tenant ids flow into schema names later.
pub fn validate_schema_name(schema: &str) -> Result<(), DbErr> {
    let valid = !schema.is_empty()
        && schema.len() <= MAX_IDENT_LEN
        && schema
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase())
        && schema
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if valid {
        Ok(())
    } else {
        Err(DbErr::Custom(format!(
            "invalid postgres schema name '{schema}': must match [a-z][a-z0-9_]{{0,62}}"
        )))
    }
}

/// `tenant_<sanitized guild id>` — the schema that holds one tenant's tables.
///
/// # Errors
///
/// Returns an error when the id contains characters that cannot appear in a
/// Postgres identifier.
pub fn tenant_schema_name(discord_guild_id: &str) -> Result<String, DbErr> {
    let name = format!("tenant_{}", tenant_slug(discord_guild_id)?);
    validate_schema_name(&name)?;
    Ok(name)
}

/// Lowercase `[a-z0-9_]+` form of a Discord guild id, hyphens folded to underscores.
///
/// # Errors
///
/// Returns an error when the id is empty or contains characters other than
/// ASCII letters, digits, `_`, or `-`.
pub fn tenant_slug(discord_guild_id: &str) -> Result<String, DbErr> {
    let invalid = || {
        DbErr::Custom(format!(
            "discord guild id `{discord_guild_id}` cannot be used as a postgres schema name"
        ))
    };
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
            _ => return Err(invalid()),
        }
    }
    let slug = slug.trim_matches('_');
    if slug.is_empty() {
        return Err(invalid());
    }
    Ok(slug.to_owned())
}

/// `CREATE SCHEMA IF NOT EXISTS` for a validated identifier.
///
/// Must run on a connection whose `search_path` still includes a schema the
/// role can create objects in (typically `public`). The new schema is empty
/// until a later connection pins `search_path` to it and runs migrations.
pub async fn ensure_schema(db: &DatabaseConnection, schema: &str) -> Result<(), DbErr> {
    validate_schema_name(schema)?;
    db.execute(Statement::from_string(
        db.get_database_backend(),
        format!("CREATE SCHEMA IF NOT EXISTS \"{schema}\""),
    ))
    .await?;
    Ok(())
}

/// Connects to `database_url` with every pooled session pinned to `schema`.
///
/// The schema must already exist ([`ensure_schema`]). Unqualified
/// `CREATE TABLE` / `SELECT` then land in that schema, including `SeaORM`'s
/// `seaql_migrations` table.
pub async fn connect_with_search_path(
    database_url: &str,
    schema: &str,
) -> Result<DatabaseConnection, DbErr> {
    validate_schema_name(schema)?;
    let mut opt = ConnectOptions::new(database_url.to_owned());
    opt.set_schema_search_path(schema);
    Database::connect(opt).await
}

/// Quotes a Postgres identifier. Callers must already trust or validate `ident`.
#[must_use]
#[cfg(test)]
pub fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// An active control-plane tenant (id = Discord guild snowflake).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveTenant {
    /// Discord guild id, also the control-plane primary key.
    pub id: String,
    /// Postgres schema holding this tenant's tables.
    pub schema_name: String,
    /// Display name stored on `tenants`.
    pub name: String,
    /// URL-ish slug stored on `tenants`.
    pub slug: String,
}

/// Active tenants in the control-plane (`status = 'active'`).
///
/// `control_db` must already have `search_path` pinned to [`CONTROL_SCHEMA`].
pub async fn list_active_tenants(
    control_db: &DatabaseConnection,
) -> Result<Vec<ActiveTenant>, DbErr> {
    let rows = control_db
        .query_all(Statement::from_string(
            control_db.get_database_backend(),
            "SELECT id, schema_name, name, slug FROM tenants WHERE status = 'active' ORDER BY id"
                .to_owned(),
        ))
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(ActiveTenant {
            id: row.try_get_by_index(0)?,
            schema_name: row.try_get_by_index(1)?,
            name: row.try_get_by_index(2)?,
            slug: row.try_get_by_index(3)?,
        });
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) async fn drop_schema(db: &DatabaseConnection, schema: &str) -> Result<(), DbErr> {
    validate_schema_name(schema)?;
    db.execute(Statement::from_string(
        db.get_database_backend(),
        format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"),
    ))
    .await?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::{Database, DatabaseConnection, DbErr};
    use sea_orm::{ConnectionTrait, DbBackend};

    pub(crate) fn postgres_url() -> Option<(String, bool)> {
        let _ = dotenvy::dotenv();
        if let Ok(url) = std::env::var("TEST_DATABASE_URL") {
            return Some((url, true));
        }
        let url = std::env::var("DATABASE_URL").ok()?;
        if url.starts_with("postgres://") || url.starts_with("postgresql://") {
            Some((url, false))
        } else {
            None
        }
    }

    pub(crate) async fn try_admin_db() -> Option<(String, DatabaseConnection)> {
        let (url, required) = postgres_url()?;
        match Database::connect(&url).await {
            Ok(db) if db.get_database_backend() == DbBackend::Postgres => Some((url, db)),
            Ok(db) if required => {
                panic!(
                    "TEST_DATABASE_URL is set but backend is {:?}, expected Postgres",
                    db.get_database_backend()
                );
            }
            Ok(_) => None,
            Err(err) if required => panic!("TEST_DATABASE_URL is set but connect failed: {err}"),
            Err(err) => {
                eprintln!("skipping postgres integration test: {err}");
                None
            }
        }
    }

    pub(crate) fn unique_schema(prefix: &str) -> String {
        format!(
            "{prefix}_{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        )
    }

    pub(crate) async fn cleanup_control_tenant(
        control_db: &DatabaseConnection,
        tenant_id: &str,
        owner_discord_id: &str,
    ) -> Result<(), DbErr> {
        use sea_orm::{ConnectionTrait, Statement};
        control_db
            .execute(Statement::from_sql_and_values(
                control_db.get_database_backend(),
                "DELETE FROM tenant_feature_flags WHERE tenant_id = $1",
                [tenant_id.into()],
            ))
            .await?;
        control_db
            .execute(Statement::from_sql_and_values(
                control_db.get_database_backend(),
                "DELETE FROM tenants WHERE id = $1",
                [tenant_id.into()],
            ))
            .await?;
        control_db
            .execute(Statement::from_sql_and_values(
                control_db.get_database_backend(),
                "DELETE FROM platform_role_assignments WHERE discord_id = $1",
                [owner_discord_id.into()],
            ))
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{try_admin_db, unique_schema};
    use super::*;
    use sea_orm::DbBackend;

    #[test]
    fn accepts_control_and_tenant_shaped_names() {
        assert!(validate_schema_name("control").is_ok());
        assert!(validate_schema_name("tenant_123456789012345678").is_ok());
        assert!(validate_schema_name("a").is_ok());
        assert!(validate_schema_name(&format!("t{}", "x".repeat(62))).is_ok());
    }

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
    fn rejects_empty_uppercase_hyphen_injection_and_overlong() {
        assert!(validate_schema_name("").is_err());
        assert!(validate_schema_name("Control").is_err());
        assert!(validate_schema_name("tenant-1").is_err());
        assert!(validate_schema_name("1tenant").is_err());
        assert!(validate_schema_name("foo;drop table users").is_err());
        assert!(validate_schema_name("foo\"bar").is_err());
        assert!(validate_schema_name(&format!("t{}", "x".repeat(63))).is_err());
    }

    #[test]
    fn control_schema_constant_is_valid() {
        assert!(validate_schema_name(CONTROL_SCHEMA).is_ok());
        assert_ne!(CONTROL_SCHEMA, "public");
    }

    async fn schema_of(db: &DatabaseConnection) -> String {
        let row = db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT current_schema()".to_owned(),
            ))
            .await
            .expect("current_schema query")
            .expect("current_schema row");
        row.try_get_by_index::<String>(0)
            .expect("current_schema is text")
    }

    /// Spike: two `SeaORM` pools on the same DSN, different `search_path`, never see
    /// each other's unqualified tables. This is the isolation primitive Stage 3
    /// depends on.
    #[tokio::test]
    async fn search_path_isolates_unqualified_tables_across_two_schemas() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };

        let schema_a = unique_schema("it_spa");
        let schema_b = unique_schema("it_spb");
        ensure_schema(&admin, &schema_a)
            .await
            .expect("create schema a");
        ensure_schema(&admin, &schema_b)
            .await
            .expect("create schema b");

        let db_a = connect_with_search_path(&url, &schema_a)
            .await
            .expect("connect a");
        let db_b = connect_with_search_path(&url, &schema_b)
            .await
            .expect("connect b");

        assert_eq!(schema_of(&db_a).await, schema_a);
        assert_eq!(schema_of(&db_b).await, schema_b);

        db_a.execute_unprepared("CREATE TABLE probe (id int PRIMARY KEY, label text NOT NULL)")
            .await
            .expect("create probe a");
        db_b.execute_unprepared("CREATE TABLE probe (id int PRIMARY KEY, label text NOT NULL)")
            .await
            .expect("create probe b");
        db_a.execute_unprepared("INSERT INTO probe (id, label) VALUES (1, 'alpha')")
            .await
            .expect("insert a");
        db_b.execute_unprepared("INSERT INTO probe (id, label) VALUES (1, 'beta')")
            .await
            .expect("insert b");

        let label_a = db_a
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT label FROM probe WHERE id = 1".to_owned(),
            ))
            .await
            .expect("select a")
            .expect("row a")
            .try_get_by_index::<String>(0)
            .expect("label a");
        let label_b = db_b
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT label FROM probe WHERE id = 1".to_owned(),
            ))
            .await
            .expect("select b")
            .expect("row b")
            .try_get_by_index::<String>(0)
            .expect("label b");
        assert_eq!(label_a, "alpha");
        assert_eq!(label_b, "beta");

        let count_a: i64 = db_a
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT count(*) FROM probe".to_owned(),
            ))
            .await
            .expect("count a")
            .expect("count row a")
            .try_get_by_index(0)
            .expect("count value a");
        assert_eq!(count_a, 1);

        drop_schema(&admin, &schema_a).await.expect("drop a");
        drop_schema(&admin, &schema_b).await.expect("drop b");
    }

    #[tokio::test]
    async fn connect_with_search_path_rejects_unsafe_schema_before_connecting() {
        let err = connect_with_search_path("postgres://unused", "not-safe")
            .await
            .expect_err("hyphenated name");
        let msg = err.to_string();
        assert!(
            msg.contains("invalid postgres schema name"),
            "unexpected error: {msg}"
        );
    }
}
