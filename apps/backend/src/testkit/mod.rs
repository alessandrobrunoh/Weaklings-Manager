//! Shared test fixtures (`#[cfg(test)]` only).
//!
//! [`World`] is the one fixture every cross-tenant test builds on instead of
//! hand-rolling its own: an alliance tenant and three guild tenants (`G1`..`G3`),
//! each with its own in-memory SQLite database carrying the full tenant schema.
//!
//! Control-plane migrations are Postgres-only, so the control side is an empty
//! SQLite connection until a slice needs control rows (the sync engine extends
//! this fixture with `run_until_idle` and failpoints; Postgres-backed worlds
//! stay behind `TEST_DATABASE_URL`).

use std::collections::BTreeMap;

use sea_orm::{ConnectionTrait, Database, DatabaseConnection};
use sea_orm_migration::MigratorTrait;

use crate::{runtime::Runtime, tenant::TenantRegistry};

/// Discord id of the alliance tenant.
pub const ALLIANCE: &str = "1000000000000000001";
/// Discord ids of the guild tenants `G1`, `G2`, `G3`.
pub const GUILDS: [&str; 3] = [
    "2000000000000000001",
    "2000000000000000002",
    "2000000000000000003",
];

/// Albion guild ids of `G1` and `G2` once [`World::seed_albion_control`] ran.
pub const ALBION_GUILDS: [&str; 2] = ["alb-guild-1", "alb-guild-2"];

/// One tenant of the world.
pub struct WorldTenant {
    /// Tenant id (the Discord guild id).
    pub id: &'static str,
    /// `alliance` or `guild`.
    pub kind: &'static str,
    /// Tenant database with every tenant migration applied.
    pub db: DatabaseConnection,
}

/// Alliance + three guilds, a control connection and a detached runtime.
pub struct World {
    /// Control-plane connection (no control tables on SQLite).
    pub control: DatabaseConnection,
    /// Registry over `control`; tenant contexts are not preloaded.
    pub registry: TenantRegistry,
    /// Wake channels without loops: kicks are observable, nothing polls.
    pub runtime: Runtime,
    tenants: BTreeMap<&'static str, WorldTenant>,
}

impl World {
    /// Builds the world; every tenant database is migrated.
    ///
    /// # Panics
    ///
    /// Panics when SQLite or a migration fails.
    pub async fn new() -> Self {
        let control = Database::connect("sqlite::memory:")
            .await
            .expect("control sqlite");
        let mut tenants = BTreeMap::new();
        for (id, kind) in std::iter::once((ALLIANCE, "alliance"))
            .chain(GUILDS.into_iter().map(|id| (id, "guild")))
        {
            let db = Database::connect("sqlite::memory:")
                .await
                .expect("tenant sqlite");
            crate::migration::Migrator::up(&db, None)
                .await
                .expect("tenant migrations");
            tenants.insert(id, WorldTenant { id, kind, db });
        }
        Self {
            registry: TenantRegistry::new("sqlite::memory:".into(), control.clone()),
            control,
            runtime: Runtime::detached(),
            tenants,
        }
    }

    /// The alliance tenant.
    #[must_use]
    pub fn alliance(&self) -> &WorldTenant {
        self.tenant(ALLIANCE)
    }

    /// Guild `n` (1-based: `guild(1)` is `G1`).
    ///
    /// # Panics
    ///
    /// Panics when `n` is not 1..=3.
    #[must_use]
    pub fn guild(&self, n: usize) -> &WorldTenant {
        self.tenant(GUILDS[n - 1])
    }

    /// Any tenant by id.
    ///
    /// # Panics
    ///
    /// Panics for an id that is not part of the world.
    #[must_use]
    pub fn tenant(&self, id: &str) -> &WorldTenant {
        self.tenants
            .get(id)
            .unwrap_or_else(|| panic!("tenant {id} is not part of the world"))
    }

    /// Every tenant, alliance first.
    pub fn tenants(&self) -> impl Iterator<Item = &WorldTenant> {
        self.tenants.values()
    }

    /// Creates the slice of the control `tenants` / `alliance_memberships`
    /// tables that Albion scope reads (SQLite has no control migrations) and
    /// fills it: `G1` and `G2` are guilds with different Albion guilds
    /// ([`ALBION_GUILDS`]), `G3` is a guild without an Albion identity, and the
    /// alliance tenant has `G1` and `G2` as active members and `G3` as left.
    ///
    /// # Panics
    ///
    /// Panics when a statement fails.
    pub async fn seed_albion_control(&self) {
        self.control
            .execute_unprepared(
                "CREATE TABLE tenants (id TEXT PRIMARY KEY, kind TEXT NOT NULL, \
                 albion_guild_id TEXT, albion_api_region TEXT, albion_alliance_id TEXT, \
                 albion_allied_guild_ids TEXT, albion_allied_guild_names TEXT)",
            )
            .await
            .expect("tenants table");
        self.control
            .execute_unprepared(
                "CREATE TABLE alliance_memberships (alliance_tenant_id TEXT NOT NULL, \
                 guild_tenant_id TEXT NOT NULL, status TEXT NOT NULL)",
            )
            .await
            .expect("alliance_memberships table");
        for (n, albion_guild) in ALBION_GUILDS.into_iter().enumerate() {
            self.control
                .execute_unprepared(&format!(
                    "INSERT INTO tenants (id, kind, albion_guild_id, albion_api_region) \
                     VALUES ('{}', 'guild', '{albion_guild}', 'europe')",
                    GUILDS[n]
                ))
                .await
                .expect("guild tenant");
        }
        self.control
            .execute_unprepared(&format!(
                "INSERT INTO tenants (id, kind, albion_api_region) \
                 VALUES ('{}', 'guild', 'europe')",
                GUILDS[2]
            ))
            .await
            .expect("unconfigured guild tenant");
        self.control
            .execute_unprepared(&format!(
                "INSERT INTO tenants (id, kind, albion_api_region, albion_alliance_id) \
                 VALUES ('{ALLIANCE}', 'alliance', 'europe', 'alb-alliance')"
            ))
            .await
            .expect("alliance tenant");
        for (guild, status) in [
            (GUILDS[0], "active"),
            (GUILDS[1], "active"),
            (GUILDS[2], "left"),
        ] {
            self.control
                .execute_unprepared(&format!(
                    "INSERT INTO alliance_memberships \
                     (alliance_tenant_id, guild_tenant_id, status) \
                     VALUES ('{ALLIANCE}', '{guild}', '{status}')"
                ))
                .await
                .expect("membership");
        }
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};

    use super::*;

    async fn table_exists(db: &DatabaseConnection, name: &str) -> bool {
        db.query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1",
            [name.into()],
        ))
        .await
        .expect("sqlite_master")
        .is_some()
    }

    #[tokio::test]
    async fn world_has_an_alliance_and_three_isolated_migrated_guilds() {
        let world = World::new().await;
        assert_eq!(world.tenants().count(), 4);
        assert_eq!(world.alliance().kind, "alliance");
        assert_eq!(world.guild(3).id, GUILDS[2]);
        for tenant in world.tenants() {
            assert!(table_exists(&tenant.db, "events").await, "{}", tenant.id);
            assert!(table_exists(&tenant.db, "users").await, "{}", tenant.id);
        }

        // Rows written in G1 are invisible to G2.
        world
            .guild(1)
            .db
            .execute_unprepared("CREATE TABLE world_probe (id integer)")
            .await
            .expect("probe table");
        assert!(table_exists(&world.guild(1).db, "world_probe").await);
        assert!(!table_exists(&world.guild(2).db, "world_probe").await);
    }
}
