//! Albion service logic module.
//!
//! `AlbionService` wraps the generic Albion Online API client scoped to the operator's
//! configured guild. `AlbionLinkService` manages the `albion_links` table backing the
//! self-service Discord <-> Albion player link feature.

use super::client::{
    AlbionAlliance, AlbionApiClient, AlbionGuild, AlbionGuildMember, AlbionPlayer, AlbionRegion,
    AlbionSearchResult,
};
use super::entities::albion_link;
use crate::errors::AppError;
use crate::pagination::{PaginatedData, PaginationParams};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    TransactionTrait,
};
use serde::Serialize;
use utoipa::ToSchema;

/// Service exposing Albion Online API operations, scoped to the operator's configured guild.
pub struct AlbionService {
    client: AlbionApiClient,
    guild_id: String,
}

impl AlbionService {
    #[must_use]
    pub fn new(region: AlbionRegion, guild_id: String) -> Self {
        Self {
            client: AlbionApiClient::new(region),
            guild_id,
        }
    }

    /// Fetches the full roster of the configured guild.
    pub async fn get_configured_guild_roster(&self) -> Result<Vec<AlbionGuildMember>, AppError> {
        self.client.get_guild_members(&self.guild_id).await
    }

    /// Fetches the configured guild's roster, filtered by an optional case-insensitive name
    /// substring and paginated locally (the upstream `/guilds/<id>/members` endpoint has no
    /// query/pagination support and guild rosters are small enough to filter in-memory).
    pub async fn search_configured_guild_roster(
        &self,
        query: Option<&str>,
        pagination: &PaginationParams,
    ) -> Result<PaginatedData<AlbionGuildMember>, AppError> {
        let mut roster = self.get_configured_guild_roster().await?;

        if let Some(q) = query.filter(|q| !q.trim().is_empty()) {
            let needle = q.to_lowercase();
            roster.retain(|member| member.name.to_lowercase().contains(&needle));
        }

        let total_items = roster.len() as u64;
        let limit = pagination.limit();
        let page = pagination.offset_page();
        let total_pages = if limit == 0 {
            0
        } else {
            total_items.div_ceil(limit)
        };

        let start = (page * limit) as usize;
        let items = roster
            .into_iter()
            .skip(start)
            .take(limit as usize)
            .collect();

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    pub async fn search(&self, query: &str) -> Result<AlbionSearchResult, AppError> {
        self.client.search(query).await
    }

    pub async fn get_player(&self, id: &str) -> Result<AlbionPlayer, AppError> {
        self.client.get_player(id).await
    }

    pub async fn get_guild(&self, id: &str) -> Result<AlbionGuild, AppError> {
        self.client.get_guild(id).await
    }

    pub async fn get_alliance(&self, id: &str) -> Result<AlbionAlliance, AppError> {
        self.client.get_alliance(id).await
    }
}

/// The current Discord-to-Albion-player link status for a user, as returned by
/// `GET /albion/link/me` and `POST /albion/link`.
///
/// When `linked` is `false`, the other three fields are entirely absent from the JSON (not sent
/// as `null`) — check `linked` first before reading them.
#[derive(Debug, Serialize, Clone, ToSchema)]
#[schema(example = json!({
    "linked": true,
    "albion_player_id": "aPngkjfLT2CGiZoWXLr8UQ",
    "albion_player_name": "Kay",
    "linked_at": "2026-07-08T02:15:00.631376+00:00"
}))]
pub struct AlbionLinkStatus {
    /// Whether the caller's Discord account currently has an Albion character linked.
    pub linked: bool,
    /// Present only when `linked` is `true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = "aPngkjfLT2CGiZoWXLr8UQ")]
    pub albion_player_id: Option<String>,
    /// Present only when `linked` is `true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = "Kay")]
    pub albion_player_name: Option<String>,
    /// Present only when `linked` is `true`. RFC 3339 timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = "2026-07-08T02:15:00.631376+00:00")]
    pub linked_at: Option<String>,
}

impl From<Option<albion_link::Model>> for AlbionLinkStatus {
    fn from(link: Option<albion_link::Model>) -> Self {
        match link {
            Some(link) => Self {
                linked: true,
                albion_player_id: Some(link.albion_player_id),
                albion_player_name: Some(link.albion_player_name),
                linked_at: Some(link.linked_at.to_rfc3339()),
            },
            None => Self {
                linked: false,
                albion_player_id: None,
                albion_player_name: None,
                linked_at: None,
            },
        }
    }
}

/// Service managing the `albion_links` table backing the Discord <-> Albion player link feature.
pub struct AlbionLinkService;

impl AlbionLinkService {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Fetches the link (if any) for the given Discord user.
    pub async fn get_link_for_discord_user(
        &self,
        db: &DatabaseConnection,
        discord_id: &str,
    ) -> Result<Option<albion_link::Model>, AppError> {
        Ok(albion_link::Entity::find()
            .filter(albion_link::Column::DiscordId.eq(discord_id))
            .one(db)
            .await?)
    }

    /// Links a Discord account to an Albion player.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Conflict` if the Discord account already has a link, or if the
    /// Albion player is already claimed by another Discord account.
    pub async fn create_link(
        &self,
        db: &DatabaseConnection,
        discord_id: &str,
        albion_player_id: &str,
        albion_player_name: &str,
    ) -> Result<albion_link::Model, AppError> {
        if self
            .get_link_for_discord_user(db, discord_id)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "Your Discord account is already linked to an Albion player".to_string(),
            ));
        }

        let existing_for_player = albion_link::Entity::find()
            .filter(albion_link::Column::AlbionPlayerId.eq(albion_player_id))
            .one(db)
            .await?;
        if existing_for_player.is_some() {
            return Err(AppError::Conflict(
                "This Albion player is already linked to another Discord account".to_string(),
            ));
        }

        let active = albion_link::ActiveModel {
            discord_id: Set(discord_id.to_string()),
            albion_player_id: Set(albion_player_id.to_string()),
            albion_player_name: Set(albion_player_name.to_string()),
            linked_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        };

        Ok(active.insert(db).await?)
    }

    /// Removes the link for the given Discord account.
    ///
    /// # Errors
    ///
    /// Returns `AppError::NotFound` if no link exists for this Discord account.
    pub async fn delete_link(
        &self,
        db: &DatabaseConnection,
        discord_id: &str,
    ) -> Result<(), AppError> {
        let existing = self
            .get_link_for_discord_user(db, discord_id)
            .await?
            .ok_or_else(|| {
                AppError::NotFound("No Albion link exists for this account".to_string())
            })?;

        albion_link::Entity::delete_by_id(existing.id)
            .exec(db)
            .await?;
        Ok(())
    }

    /// Fetches the link (if any) for the user identified by internal numeric `user_id`.
    pub async fn get_link_for_user_id(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
    ) -> Result<Option<albion_link::Model>, AppError> {
        let user = crate::modules::users::entities::Entity::find_by_id(user_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("User {user_id} not found")))?;

        if let Some(ref discord_id) = user.discord_id {
            self.get_link_for_discord_user(db, discord_id).await
        } else {
            Ok(None)
        }
    }

    /// Admin helper to link or re-link any user to an Albion player.
    pub async fn admin_link_user(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
        albion_player_id: &str,
        albion_player_name: &str,
    ) -> Result<albion_link::Model, AppError> {
        let user = crate::modules::users::entities::Entity::find_by_id(user_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("User {user_id} not found")))?;

        let discord_id = user.discord_id.ok_or_else(|| {
            AppError::Validation(
                "User has no associated Discord ID and cannot be linked to an Albion character"
                    .to_string(),
            )
        })?;

        let txn = db.begin().await?;

        // If the user already has a link, delete it to allow re-assignment
        if let Some(existing) = albion_link::Entity::find()
            .filter(albion_link::Column::DiscordId.eq(&discord_id))
            .one(&txn)
            .await?
        {
            albion_link::Entity::delete_by_id(existing.id)
                .exec(&txn)
                .await?;
        }

        // If another account was linked to this character, remove that link as well
        if let Some(other) = albion_link::Entity::find()
            .filter(albion_link::Column::AlbionPlayerId.eq(albion_player_id))
            .one(&txn)
            .await?
        {
            albion_link::Entity::delete_by_id(other.id)
                .exec(&txn)
                .await?;
        }

        let active = albion_link::ActiveModel {
            discord_id: Set(discord_id),
            albion_player_id: Set(albion_player_id.to_string()),
            albion_player_name: Set(albion_player_name.to_string()),
            linked_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        };

        let inserted = active.insert(&txn).await?;
        txn.commit().await?;
        Ok(inserted)
    }

    /// Admin helper to unlink any user from their Albion player.
    ///
    /// Returns the unlinked user's Discord ID when a link was actually removed, so the caller can
    /// best-effort revoke the configured Discord guild role — `None` when the user has no Discord
    /// ID or already had no active link.
    pub async fn admin_unlink_user(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
    ) -> Result<Option<String>, AppError> {
        let user = crate::modules::users::entities::Entity::find_by_id(user_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("User {user_id} not found")))?;

        let Some(discord_id) = user.discord_id else {
            return Ok(None);
        };

        if let Some(existing) = self.get_link_for_discord_user(db, &discord_id).await? {
            albion_link::Entity::delete_by_id(existing.id)
                .exec(db)
                .await?;
            return Ok(Some(discord_id));
        }

        Ok(None)
    }
}

impl Default for AlbionLinkService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use sea_orm::Database;

    async fn setup_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("Failed to connect to test database");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("Failed to run database migrations");
        db
    }

    #[tokio::test]
    async fn test_create_and_delete_link() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();

        assert!(
            service
                .get_link_for_discord_user(&db, "discord_a")
                .await
                .unwrap()
                .is_none()
        );

        let link = service
            .create_link(&db, "discord_a", "player_1", "PlayerOne")
            .await
            .expect("Failed to create link");
        assert_eq!(link.albion_player_id, "player_1");

        let fetched = service
            .get_link_for_discord_user(&db, "discord_a")
            .await
            .unwrap();
        assert!(fetched.is_some());

        service
            .delete_link(&db, "discord_a")
            .await
            .expect("Failed to delete link");
        assert!(
            service
                .get_link_for_discord_user(&db, "discord_a")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn test_cannot_link_same_discord_user_twice() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();

        service
            .create_link(&db, "discord_a", "player_1", "PlayerOne")
            .await
            .unwrap();

        let result = service
            .create_link(&db, "discord_a", "player_2", "PlayerTwo")
            .await;
        assert!(matches!(result, Err(AppError::Conflict(_))));
    }

    #[tokio::test]
    async fn test_cannot_link_same_player_to_two_discord_users() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();

        service
            .create_link(&db, "discord_a", "player_1", "PlayerOne")
            .await
            .unwrap();

        let result = service
            .create_link(&db, "discord_b", "player_1", "PlayerOne")
            .await;
        assert!(matches!(result, Err(AppError::Conflict(_))));
    }

    #[tokio::test]
    async fn test_delete_link_without_existing_link_fails() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();

        let result = service.delete_link(&db, "discord_a").await;
        assert!(matches!(result, Err(AppError::NotFound(_))));
    }
}
