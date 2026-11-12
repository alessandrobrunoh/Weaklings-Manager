//! Retires the Albion link approval queue.
//!
//! A self-service link applies immediately again, so `albion_link_requests` has no purpose.
//! Every claim still open is applied as a link first (what an officer approving it would have
//! done), then the table is dropped. Applying a claim means the `albion_links` row only: the
//! nickname, Guild role and alliance copy are Discord/cross-tenant side effects a migration
//! cannot run, and an officer re-link (or the member linking again) picks them up.
//!
//! A claim is skipped, never forced, when its account already has a link or its character is
//! already linked. When several accounts claim the same character the oldest claim wins.

use sea_orm_migration::prelude::*;

const TABLE: &str = "albion_link_requests";

/// Migration step applying pending Albion link requests and dropping their table.
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager.has_table(TABLE).await? {
            return Ok(());
        }
        manager
            .get_connection()
            .execute_unprepared(
                "INSERT INTO albion_links (discord_id, albion_player_id, albion_player_name, linked_at) \
                 SELECT r.discord_id, r.albion_player_id, r.albion_player_name, r.requested_at \
                 FROM albion_link_requests r \
                 WHERE NOT EXISTS (\
                    SELECT 1 FROM albion_links l \
                    WHERE l.discord_id = r.discord_id OR l.albion_player_id = r.albion_player_id) \
                   AND r.id = (\
                    SELECT MIN(o.id) FROM albion_link_requests o \
                    WHERE o.albion_player_id = r.albion_player_id \
                      AND NOT EXISTS (\
                        SELECT 1 FROM albion_links l2 WHERE l2.discord_id = o.discord_id))",
            )
            .await?;
        manager
            .drop_table(
                Table::drop()
                    .table(Alias::new(TABLE))
                    .if_exists()
                    .to_owned(),
            )
            .await
    }

    /// Does nothing: the dropped requests cannot be recovered, and the applied links stay.
    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}
