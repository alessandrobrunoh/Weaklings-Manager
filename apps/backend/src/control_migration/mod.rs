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
mod m20260908_000006_default_tenant_rank;
mod m20260908_000007_tenant_kind;
mod m20260908_000008_alliance_memberships;
mod m20260908_000009_alliance_shares;
mod m20260908_000010_alliance_share_split;
mod m20260917_000001_alliance_shares_comp;
mod m20260918_000001_alliance_membership_discord_role;
mod m20260918_000001_event_sync_links;
mod m20260921_000001_repair_alliance_share_artifact_types;
mod m20260922_000001_sidebar_feature;
mod m20260922_000002_default_tenant;
mod m20260922_000003_tenant_rail_feature;
mod m20261028_000001_alliance_departure;
mod m20261028_000002_tenant_albion_alliance;
mod m20261029_000001_allow_event_fanout;
mod m20261030_000001_event_fanout_outbox;
mod m20261102_000001_event_participant_attribution;
mod m20261103_000001_alliance_split_distribution;
mod m20261104_000001_event_mirror_requests;
mod m20261105_000001_unique_event_sync_source_target;
mod m20261106_000001_mirror_request_inactive_state;
mod m20261107_000001_discord_delivery;

/// Stable id of the seeded `SuperAdmin` platform role.
pub const SUPERADMIN_ROLE_ID: &str = "01990000-0000-4000-8000-000000000001";

/// Catalog key for the regolamento feature.
pub const FEATURE_REGOLAMENTO: &str = "regolamento";
/// Catalog key for premium split functions.
pub const FEATURE_SPLITS_PAID: &str = "splits.paid";
/// Catalog key for the tenant navigation sidebar.
pub const FEATURE_SIDEBAR: &str = "sidebar";

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
            Box::new(m20260908_000006_default_tenant_rank::Migration),
            Box::new(m20260908_000007_tenant_kind::Migration),
            Box::new(m20260908_000008_alliance_memberships::Migration),
            Box::new(m20260908_000009_alliance_shares::Migration),
            Box::new(m20260917_000001_alliance_shares_comp::Migration),
            Box::new(m20260908_000010_alliance_share_split::Migration),
            Box::new(m20260918_000001_alliance_membership_discord_role::Migration),
            Box::new(m20260918_000001_event_sync_links::Migration),
            Box::new(m20260921_000001_repair_alliance_share_artifact_types::Migration),
            Box::new(m20260922_000001_sidebar_feature::Migration),
            Box::new(m20260922_000002_default_tenant::Migration),
            Box::new(m20260922_000003_tenant_rail_feature::Migration),
            Box::new(m20261028_000001_alliance_departure::Migration),
            Box::new(m20261028_000002_tenant_albion_alliance::Migration),
            Box::new(m20261029_000001_allow_event_fanout::Migration),
            Box::new(m20261030_000001_event_fanout_outbox::Migration),
            Box::new(m20261102_000001_event_participant_attribution::Migration),
            Box::new(m20261103_000001_alliance_split_distribution::Migration),
            Box::new(m20261104_000001_event_mirror_requests::Migration),
            Box::new(m20261105_000001_unique_event_sync_source_target::Migration),
            Box::new(m20261106_000001_mirror_request_inactive_state::Migration),
            Box::new(m20261107_000001_discord_delivery::Migration),
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
        // Migrations are append-only at the end of `migrations()`; the number of
        // registered ones is whatever the list says, never a hand-kept constant.
        let mut unique = control.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique.len(),
            control.len(),
            "duplicate control migration name"
        );
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
            "alliance_memberships",
            "alliance_shares",
            "event_sync_links",
            "event_fanout_jobs",
            "event_fanout_targets",
            "event_fanout_assets",
            "event_participant_attributions",
            "alliance_split_distribution_batches",
            "alliance_split_distribution_items",
            "event_mirror_requests",
            "alliance_role_grants",
            "alliance_role_revocations",
            "seaql_migrations",
        ] {
            assert!(
                control_tables.iter().any(|t| t == required),
                "control schema missing {required}: {control_tables:?}"
            );
        }
        let source_indexes = admin
            .query_all(Statement::from_sql_and_values(
                sea_orm::DbBackend::Postgres,
                "SELECT indexdef FROM pg_indexes \
                 WHERE schemaname = $1 AND tablename = 'event_sync_links'",
                [control_schema.clone().into()],
            ))
            .await
            .expect("event sync link indexes")
            .into_iter()
            .map(|row| row.try_get_by_index::<String>(0).expect("index definition"))
            .collect::<Vec<_>>();
        assert!(
            source_indexes
                .iter()
                .any(|index| index.contains("idx_event_sync_links_source")),
            "control schema is missing the fanout lookup index: {source_indexes:?}"
        );
        assert!(
            !source_indexes.iter().any(|index| {
                index.contains("UNIQUE")
                    && index.contains("source_tenant_id")
                    && index.contains("source_event_id")
                    && !index.contains("mirror_tenant_id")
            }),
            "control schema still enforces one source event per link: {source_indexes:?}"
        );
        assert!(
            source_indexes.iter().any(|index| {
                index.contains("UNIQUE")
                    && index.contains("source_tenant_id")
                    && index.contains("source_event_id")
                    && index.contains("mirror_tenant_id")
            }),
            "control schema must prevent a duplicate source-to-destination link: {source_indexes:?}"
        );
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
            "alliance_memberships",
            "alliance_shares",
            "event_sync_links",
            "event_fanout_jobs",
            "event_fanout_targets",
            "event_fanout_assets",
            "event_participant_attributions",
            "alliance_split_distribution_batches",
            "alliance_split_distribution_items",
            "event_mirror_requests",
            "alliance_role_grants",
            "alliance_role_revocations",
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
        assert_eq!(feature_count, 16);

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
        assert_eq!(
            control_migration_count,
            <i64 as TryFrom<usize>>::try_from(Migrator::migrations().len())
                .expect("migration count")
        );
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
