//! VOD review claims: forum checks, unique URL per season, then XP award.

use chrono::{DateTime, FixedOffset, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder,
};

use crate::errors::AppError;
use crate::modules::progression::models::AwardSpec;
use crate::modules::progression::service::ProgressionService;
use crate::modules::progression::status::XpSource;

use super::entities::{VodReviewActiveModel, VodReviewColumn, VodReviewEntity, VodReviewModel};
use super::models::{SubmitVodRequest, VodReviewView};

/// Stateless VOD operations.
pub struct VodService;

impl Default for VodService {
    fn default() -> Self {
        Self
    }
}

impl VodService {
    /// Creates a new instance.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Claims a VOD URL for the caller in the covering season and awards XP.
    ///
    /// # Errors
    ///
    /// * `400` if the VOD forum is not configured, the post is in the wrong forum, there is no
    ///   covering season, or the URL is empty/invalid.
    /// * `403` if the thread owner is not the claimer.
    /// * `409` if the normalized URL is already claimed this season (no XP).
    pub async fn submit(
        &self,
        db: &DatabaseConnection,
        claimer_user_id: i64,
        claimer_discord_id: &str,
        req: &SubmitVodRequest,
    ) -> Result<VodReviewView, AppError> {
        let settings = ProgressionService::new().get_settings(db).await?;
        let Some(configured_forum) = settings
            .vod_forum_channel_id
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        else {
            return Err(AppError::Validation("VOD forum is not configured".into()));
        };
        if req.forum_channel_id.trim() != configured_forum {
            return Err(AppError::Validation(
                "must be posted in the configured VOD forum".into(),
            ));
        }
        if req.thread_owner_discord_id.trim() != claimer_discord_id {
            return Err(AppError::Forbidden(
                "only the thread owner can claim this VOD".into(),
            ));
        }

        let url = normalize_vod_url(&req.url)?;
        let now: DateTime<FixedOffset> = Utc::now().into();
        let Some(season) = ProgressionService::new().covering_season(db).await? else {
            return Err(AppError::Validation("no active covering season".into()));
        };

        let existing = VodReviewEntity::find()
            .filter(VodReviewColumn::SeasonId.eq(season.id))
            .filter(VodReviewColumn::Url.eq(&url))
            .one(db)
            .await?;
        if existing.is_some() {
            return Err(AppError::Conflict(
                "this VOD URL has already been claimed this season".into(),
            ));
        }

        let row = VodReviewActiveModel {
            user_id: Set(claimer_user_id),
            season_id: Set(season.id),
            url: Set(url.clone()),
            discord_thread_id: Set(req.discord_thread_id.trim().to_string()),
            discord_message_id: Set(req.discord_message_id.trim().to_string()),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(db)
        .await?;

        if let Err(error) = ProgressionService::new()
            .award(
                db,
                AwardSpec {
                    user_id: claimer_user_id,
                    source: XpSource::Vod,
                    base_amount: Some(i64::from(settings.xp_vod)),
                    idempotency_key: format!("vod:{url}"),
                    actor_user_id: None,
                },
            )
            .await
        {
            tracing::warn!(
                user_id = claimer_user_id,
                url = %url,
                error = %error,
                "failed to award VOD XP"
            );
        }

        Ok(vod_view(&row))
    }

    /// Lists VOD reviews claimed by `user_id`, newest first.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn list_mine(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
    ) -> Result<Vec<VodReviewView>, AppError> {
        let rows = VodReviewEntity::find()
            .filter(VodReviewColumn::UserId.eq(user_id))
            .order_by_desc(VodReviewColumn::CreatedAt)
            .all(db)
            .await?;
        Ok(rows.iter().map(vod_view).collect())
    }
}

fn vod_view(row: &VodReviewModel) -> VodReviewView {
    VodReviewView {
        id: row.id,
        user_id: row.user_id,
        season_id: row.season_id,
        url: row.url.clone(),
        discord_thread_id: row.discord_thread_id.clone(),
        discord_message_id: row.discord_message_id.clone(),
        created_at: row.created_at.to_rfc3339(),
    }
}

/// Trim, lowercase the host, strip a trailing slash on the path.
///
/// # Errors
///
/// Returns `AppError::Validation` when the URL is empty or has no scheme/host.
pub fn normalize_vod_url(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("url is required".into()));
    }
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Err(AppError::Validation(
            "url must include a scheme (https://...)".into(),
        ));
    };
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(AppError::Validation(
            "url scheme must be http or https".into(),
        ));
    }
    let (host_port, remainder) = if let Some(slash) = rest.find('/') {
        (&rest[..slash], &rest[slash..])
    } else if let Some(query) = rest.find('?') {
        (&rest[..query], &rest[query..])
    } else {
        (rest, "")
    };
    if host_port.is_empty() {
        return Err(AppError::Validation("url host is required".into()));
    }
    let host_port = host_port.to_ascii_lowercase();
    let remainder = remainder.trim_end_matches('/');
    if remainder.is_empty() {
        Ok(format!("{scheme}://{host_port}"))
    } else {
        Ok(format!("{scheme}://{host_port}{remainder}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::progression::entities::ProgressionSeasonActiveModel;
    use crate::modules::progression::models::UpdateProgressionSettingsRequest;
    use crate::modules::users::entities::ActiveModel as UserActiveModel;
    use chrono::Duration;
    use sea_orm::Database;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    async fn insert_user(db: &DatabaseConnection, username: &str, email: &str) -> i64 {
        UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            discord_id: Set(Some(format!("discord-{username}"))),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id
    }

    async fn insert_covering_season(db: &DatabaseConnection) -> i64 {
        let now = Utc::now();
        let starts: DateTime<FixedOffset> = (now - Duration::days(1)).into();
        let ends: DateTime<FixedOffset> = (now + Duration::days(30)).into();
        ProgressionSeasonActiveModel {
            name: Set("s25".into()),
            starts_at: Set(starts),
            ends_at: Set(ends),
            is_active: Set(true),
            updated_at: Set(now.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("season")
        .id
    }

    fn req(url: &str, forum: &str) -> SubmitVodRequest {
        SubmitVodRequest {
            url: url.to_string(),
            discord_thread_id: "thread-1".into(),
            discord_message_id: "msg-1".into(),
            forum_channel_id: forum.to_string(),
            thread_owner_discord_id: "discord-alice".into(),
        }
    }

    #[test]
    fn normalize_lowercases_host_and_strips_slash() {
        assert_eq!(
            normalize_vod_url(" HTTPS://YouTube.com/watch?v=AbC/ ").unwrap(),
            "https://youtube.com/watch?v=AbC"
        );
    }

    #[tokio::test]
    async fn submit_rejects_missing_forum_config() {
        let db = seed_db().await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        insert_covering_season(&db).await;
        let err = VodService::new()
            .submit(
                &db,
                user_id,
                "discord-alice",
                &req("https://youtu.be/a", "forum"),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(msg) if msg.contains("not configured")));
    }

    #[tokio::test]
    async fn submit_rejects_wrong_forum() {
        let db = seed_db().await;
        let editor = insert_user(&db, "admin", "admin@example.com").await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        insert_covering_season(&db).await;
        ProgressionService::new()
            .update_settings(
                &db,
                editor,
                &UpdateProgressionSettingsRequest {
                    vod_forum_channel_id: Some("correct-forum".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let err = VodService::new()
            .submit(
                &db,
                user_id,
                "discord-alice",
                &req("https://youtu.be/a", "wrong-forum"),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(msg) if msg.contains("configured VOD forum")));
    }

    #[tokio::test]
    async fn submit_unique_url_per_season() {
        let db = seed_db().await;
        let editor = insert_user(&db, "admin", "admin@example.com").await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        insert_covering_season(&db).await;
        ProgressionService::new()
            .update_settings(
                &db,
                editor,
                &UpdateProgressionSettingsRequest {
                    vod_forum_channel_id: Some("forum-1".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let service = VodService::new();
        let first = service
            .submit(
                &db,
                user_id,
                "discord-alice",
                &req("HTTPS://YouTube.com/watch?v=AbC/", "forum-1"),
            )
            .await
            .unwrap();
        assert_eq!(first.url, "https://youtube.com/watch?v=AbC");

        let dup = service
            .submit(
                &db,
                user_id,
                "discord-alice",
                &req("https://youtube.com/watch?v=AbC", "forum-1"),
            )
            .await
            .unwrap_err();
        assert!(matches!(dup, AppError::Conflict(_)));

        let me = ProgressionService::new()
            .get_me(&db, user_id)
            .await
            .unwrap();
        assert_eq!(me.xp, 40);
    }
}
