//! Adds tenant-local rank names, XP thresholds, and optional display-only Discord role IDs.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

const DEFAULT_RANKS: &str = r#"[{"name":"Recruit","min_xp":0,"discord_role_id":null},{"name":"Active","min_xp":400,"discord_role_id":null},{"name":"Reliable","min_xp":900,"discord_role_id":null},{"name":"Veteran","min_xp":1500,"discord_role_id":null},{"name":"Core Member","min_xp":2200,"discord_role_id":null}]"#;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("progression_settings"))
                    .add_column(
                        ColumnDef::new(Alias::new("guild_ranks_json"))
                            .text()
                            .not_null()
                            .default(DEFAULT_RANKS),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("progression_settings"))
                    .drop_column(Alias::new("guild_ranks_json"))
                    .to_owned(),
            )
            .await
    }
}
