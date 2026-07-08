use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Roles::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Roles::Id)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Roles::Name).string().not_null().unique_key())
                    .col(ColumnDef::new(Roles::Priority).integer().not_null().default(0))
                    .to_owned(),
            )
            .await?;

        // Seed some initial placeholder roles so the system has examples
        let db = manager.get_connection();
        db.execute(
            manager.get_database_backend().build(
                &Query::insert()
                    .into_table(Roles::Table)
                    .columns([Roles::Id, Roles::Name, Roles::Priority])
                    .values_panic(["386488773351047168".into(), "Admin".into(), 100.into()])
                    .values_panic(["111222333444555666".into(), "Moderator".into(), 50.into()])
                    .values_panic(["222333444555666777".into(), "User".into(), 10.into()])
                    .to_owned(),
            ),
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Roles::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum Roles {
    Table,
    Id,
    Name,
    Priority,
}
