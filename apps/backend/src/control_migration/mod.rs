//! Control-plane migrator.
//!
//! Runs against the `control` schema (see [`crate::postgres`]), independently of
//! the tenant migrator in [`crate::migration`]. Each schema has its own
//! `seaql_migrations` table, so the two histories never collide.

pub use sea_orm_migration::prelude::*;

mod m20260908_000001_create_tenants_table;
mod m20260908_000002_create_platform_roles;
mod m20260908_000003_create_feature_catalog;
mod m20260908_000004_tenant_onboarding;
mod m20260908_000005_tenant_ranks;

/// Stable id of the seeded `SuperAdmin` platform role.
pub const SUPERADMIN_ROLE_ID: &str = "01990000-0000-4000-8000-000000000001";

/// Catalog key for the regolamento feature.
pub const FEATURE_REGOLAMENTO: &str = "regolamento";
/// Catalog key for premium split functions.
pub const FEATURE_SPLITS_PAID: &str = "splits.paid";

/// Platform permission: provision / suspend / resume tenants.
pub const PERM_TENANTS_MANAGE: &str = "tenants.manage";
/// Platform permission: assign or revoke platform roles.
pub const PERM_PLATFORM_ADMINS_MANAGE: &str = "platform_admins.manage";
/// Platform permission: toggle per-tenant feature flags.
pub const PERM_FEATURE_FLAGS_MANAGE: &str = "feature_flags.manage";

/// Control-plane migrator.
pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260908_000001_create_tenants_table::Migration),
            Box::new(m20260908_000002_create_platform_roles::Migration),
            Box::new(m20260908_000003_create_feature_catalog::Migration),
            Box::new(m20260908_000004_tenant_onboarding::Migration),
            Box::new(m20260908_000005_tenant_ranks::Migration),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::postgres::{
        connect_with_search_path, drop_schema, ensure_schema,
        test_support::{try_admin_db, unique_schema},
    };
    use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};

    async fn table_names(db: &DatabaseConnection, schema: &str) -> Vec<String> {
        let rows = db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
                [schema.into()],
            ))
            .await
            .expect("pg_tables");
        rows.into_iter()
            .map(|row| row.try_get_by_index::<String>(0).expect("tablename"))
            .collect()
    }

    #[test]
    fn control_migrations_do_not_share_names_with_tenant_migrations() {
        let control: Vec<String> = Migrator::migrations()
            .iter()
            .map(|m| m.name().to_string())
            .collect();
        let tenant: Vec<String> = crate::migration::Migrator::migrations()
            .iter()
            .map(|m| m.name().to_string())
            .collect();
        for name in &control {
            assert!(
                !tenant.contains(name),
                "control migration {name} collides with a tenant migration name"
            );
        }
        assert_eq!(control.len(), 5);
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn control_and_tenant_migrators_write_disjoint_schemas() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };

        let control_schema = unique_schema("it_ctl");
        let tenant_schema = unique_schema("it_ten");
        ensure_schema(&admin, &control_schema)
            .await
            .expect("control schema");
        ensure_schema(&admin, &tenant_schema)
            .await
            .expect("tenant schema");

        let control_db = connect_with_search_path(&url, &control_schema)
            .await
            .expect("control connect");
        let tenant_db = connect_with_search_path(&url, &tenant_schema)
            .await
            .expect("tenant connect");

        Migrator::up(&control_db, None)
            .await
            .expect("control migrator");
        crate::migration::Migrator::up(&tenant_db, None)
            .await
            .expect("tenant migrator");

        let control_tables = table_names(&admin, &control_schema).await;
        let tenant_tables = table_names(&admin, &tenant_schema).await;

        for required in [
            "tenants",
            "platform_roles",
            "platform_role_permissions",
            "platform_role_assignments",
            "feature_catalog",
            "tenant_feature_flags",
            "user_tenant_memberships",
            "tenant_ranks",
            "tenant_rank_features",
            "seaql_migrations",
        ] {
            assert!(
                control_tables.iter().any(|t| t == required),
                "control schema missing {required}: {control_tables:?}"
            );
        }
        for control_only in [
            "tenants",
            "platform_roles",
            "platform_role_permissions",
            "platform_role_assignments",
            "feature_catalog",
            "tenant_feature_flags",
            "user_tenant_memberships",
            "tenant_ranks",
            "tenant_rank_features",
        ] {
            assert!(
                !tenant_tables.iter().any(|t| t == control_only),
                "tenant schema unexpectedly has control table {control_only}"
            );
        }

        assert!(
            tenant_tables.iter().any(|t| t == "users"),
            "tenant schema missing users: {tenant_tables:?}"
        );
        assert!(
            tenant_tables.iter().any(|t| t == "guild_settings"),
            "tenant schema missing guild_settings"
        );
        assert!(
            !control_tables.iter().any(|t| t == "users"),
            "control schema must not receive tenant tables"
        );

        let superadmin: String = control_db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT name FROM platform_roles WHERE id = '01990000-0000-4000-8000-000000000001'"
                    .to_owned(),
            ))
            .await
            .expect("role query")
            .expect("superadmin row")
            .try_get_by_index(0)
            .expect("name");
        assert_eq!(superadmin, "SuperAdmin");

        let feature_count: i64 = control_db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT count(*) FROM feature_catalog".to_owned(),
            ))
            .await
            .expect("feature count")
            .expect("row")
            .try_get_by_index(0)
            .expect("count");
        assert_eq!(feature_count, 15);

        // Independent bookkeeping: applying control migrations must not mark
        // tenant migrations as done, and vice versa.
        let control_migration_count: i64 = control_db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT count(*) FROM seaql_migrations".to_owned(),
            ))
            .await
            .expect("control seaql count")
            .expect("row")
            .try_get_by_index(0)
            .expect("count");
        let tenant_migration_count: i64 = tenant_db
            .query_one(Statement::from_string(
                DbBackend::Postgres,
                "SELECT count(*) FROM seaql_migrations".to_owned(),
            ))
            .await
            .expect("tenant seaql count")
            .expect("row")
            .try_get_by_index(0)
            .expect("count");
        assert_eq!(control_migration_count, 5);
        assert!(
            tenant_migration_count > 50,
            "expected the full tenant history, got {tenant_migration_count}"
        );

        drop_schema(&admin, &control_schema)
            .await
            .expect("drop control");
        drop_schema(&admin, &tenant_schema)
            .await
            .expect("drop tenant");
    }
}
