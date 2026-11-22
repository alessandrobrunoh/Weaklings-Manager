use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE christmas_settings (
                    singleton boolean PRIMARY KEY CHECK (singleton),
                    enabled boolean NOT NULL,
                    preset integer NOT NULL CHECK (preset BETWEEN 1 AND 14),
                    intensity integer NOT NULL CHECK (intensity BETWEEN 1 AND 3)
                )",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE christmas_settings")
            .await?;
        Ok(())
    }
}
