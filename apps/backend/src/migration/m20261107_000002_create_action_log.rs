//! Creates the tenant `action_log` table (shared-actions §3.5).

use sea_orm_migration::prelude::*;

/// One table, then separate index statements so SQLite accepts the schema (BASE-1).
#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum ActionLog {
    Table,
    Id,
    EntityType,
    EntityId,
    Action,
    ActorUserId,
    Channel,
    IdempotencyKey,
    FromState,
    ToState,
    Outcome,
    Params,
    EffectIds,
    CreatedAt,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ActionLog::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ActionLog::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(ActionLog::EntityType).text().not_null())
                    .col(ColumnDef::new(ActionLog::EntityId).big_integer().null())
                    .col(ColumnDef::new(ActionLog::Action).text().not_null())
                    .col(
                        ColumnDef::new(ActionLog::ActorUserId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(ActionLog::Channel).text().not_null())
                    .col(ColumnDef::new(ActionLog::IdempotencyKey).text().null())
                    .col(ColumnDef::new(ActionLog::FromState).text().null())
                    .col(ColumnDef::new(ActionLog::ToState).text().null())
                    .col(ColumnDef::new(ActionLog::Outcome).text().not_null())
                    .col(ColumnDef::new(ActionLog::Params).text().null())
                    .col(ColumnDef::new(ActionLog::EffectIds).text().null())
                    .col(
                        ColumnDef::new(ActionLog::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("action_log_entity_idx")
                    .table(ActionLog::Table)
                    .col(ActionLog::EntityType)
                    .col(ActionLog::EntityId)
                    .col((ActionLog::CreatedAt, IndexOrder::Desc))
                    .to_owned(),
            )
            .await?;

        // Partial unique index: keys are only unique when the request sent one.
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE UNIQUE INDEX IF NOT EXISTS action_log_idem \
                 ON action_log (actor_user_id, action, idempotency_key) \
                 WHERE idempotency_key IS NOT NULL",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ActionLog::Table).to_owned())
            .await
    }
}
