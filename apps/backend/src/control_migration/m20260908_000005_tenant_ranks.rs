//! Tenant ranks (plans) created by platform admins, plus optional module catalog.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const OPTIONAL_FEATURES: &[(&str, &str, &str)] = &[
    ("events", "Events", "Event calendar and roster"),
    ("comps", "Comps", "Composition planner"),
    ("tests", "Combat tests", "Timed combat tests"),
    ("battles", "Battles", "Battle history"),
    ("intel", "Intel", "Scout reports and intel"),
    ("bank", "Bank", "Guild bank and withdrawals"),
    ("splits", "Splits", "Loot splits"),
    ("regears", "Regears", "Regear requests"),
    ("siphoned", "Siphoned energy", "Siphoned energy tracker"),
    ("warns", "Warns", "Member warnings"),
    ("giveaways", "Giveaways", "Giveaway campaigns"),
    ("applications", "Applications", "Guild applications"),
    ("progression", "Progression", "XP and season progression"),
];

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "ALTER TABLE feature_catalog \
             ADD COLUMN IF NOT EXISTS always_on boolean NOT NULL DEFAULT false",
        )
        .await?;
        db.execute_unprepared(
            "CREATE TABLE IF NOT EXISTS tenant_ranks (
                id uuid PRIMARY KEY,
                name text NOT NULL UNIQUE,
                description text,
                created_at timestamptz NOT NULL DEFAULT now()
            )",
        )
        .await?;
        db.execute_unprepared(
            "CREATE TABLE IF NOT EXISTS tenant_rank_features (
                rank_id uuid NOT NULL REFERENCES tenant_ranks(id) ON DELETE CASCADE,
                feature_key text NOT NULL REFERENCES feature_catalog(key) ON DELETE CASCADE,
                PRIMARY KEY (rank_id, feature_key)
            )",
        )
        .await?;
        db.execute_unprepared(
            "ALTER TABLE tenants \
             ADD COLUMN IF NOT EXISTS rank_id uuid REFERENCES tenant_ranks(id)",
        )
        .await?;

        for (key, name, description) in OPTIONAL_FEATURES {
            let escaped_name = name.replace('\'', "''");
            let escaped_desc = description.replace('\'', "''");
            db.execute_unprepared(&format!(
                "INSERT INTO feature_catalog (key, display_name, description, always_on) \
                 VALUES ('{key}', '{escaped_name}', '{escaped_desc}', false) \
                 ON CONFLICT (key) DO NOTHING"
            ))
            .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("ALTER TABLE tenants DROP COLUMN IF EXISTS rank_id")
            .await?;
        db.execute_unprepared("DROP TABLE IF EXISTS tenant_rank_features")
            .await?;
        db.execute_unprepared("DROP TABLE IF EXISTS tenant_ranks")
            .await?;
        db.execute_unprepared("ALTER TABLE feature_catalog DROP COLUMN IF EXISTS always_on")
            .await?;
        Ok(())
    }
}
