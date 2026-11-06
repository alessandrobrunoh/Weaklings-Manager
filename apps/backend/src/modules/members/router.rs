//! Members HTTP routes.

use axum::{Extension, Json, Router, routing::post};
use sea_orm::{DatabaseConnection, EntityTrait};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::BotSecret;
use crate::modules::platform::service::PlatformService;
use crate::modules::users::entities::Entity as UserEntity;
use crate::modules::users::identity::{self, MemberSeed, Presence, Via};
use crate::responses::ApiResponse;
use crate::tenant::{ControlDb, CurrentTenantId};

/// Creates the members router.
pub fn router() -> Router {
    Router::new().route("/ensure", post(ensure_member))
}

/// Body of `POST /api/members/ensure`.
#[derive(Debug, Deserialize, ToSchema)]
pub struct EnsureMemberRequest {
    /// Discord snowflake of a member the bot has just seen in this server.
    pub discord_id: String,
    /// Discord username, used for new rows and kept current.
    pub username: Option<String>,
    /// Optional Discord role snowflakes; replaces the stored snapshot when present.
    pub role_ids: Option<Vec<String>>,
}

/// Result of `POST /api/members/ensure`.
#[derive(Debug, Serialize, ToSchema)]
pub struct EnsureMemberView {
    /// Local `users.id`.
    pub user_id: i64,
    /// The row was created by this call.
    pub created: bool,
    /// The row is active in this tenant after the call.
    pub active: bool,
}

/// Provisions a member the bot has verified is in this server.
///
/// Use it for a target chosen with a user option (`/warn`, `/xp`, `/rank`, `/warns`): the bot
/// calls it only after the option resolved to a server member. Backend-only references (a
/// `user_ref` on a warning) never reach this route and never activate a member.
#[utoipa::path(
    post,
    path = "/api/members/ensure",
    tag = "members",
    summary = "Create or reactivate a member the bot verified is in this server",
    description = "Requires the configured X-Bot-Secret and X-Guild-Id. Idempotent; concurrent \
        first calls converge on one row.",
    responses(
        (status = 200, description = "Member row ensured"),
        (status = 400, description = "Invalid Discord id", body = ProblemDetails),
        (status = 401, description = "Invalid or missing bot secret", body = ProblemDetails)
    )
)]
pub async fn ensure_member(
    _bot: BotSecret,
    Extension(db): Extension<DatabaseConnection>,
    Extension(control): Extension<ControlDb>,
    Extension(tenant): Extension<CurrentTenantId>,
    Json(req): Json<EnsureMemberRequest>,
) -> Result<Json<ApiResponse<EnsureMemberView>>, AppError> {
    let discord_id = req.discord_id.trim();
    if discord_id.is_empty()
        || discord_id.len() > 25
        || !discord_id.chars().all(|c| c.is_ascii_digit())
    {
        return Err(AppError::Validation(
            "discord_id must be a Discord snowflake".to_string(),
        ));
    }
    let username = req
        .username
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.chars().take(100).collect::<String>());
    let ensured = identity::ensure_member(
        &db,
        MemberSeed {
            discord_id,
            username: username.as_deref(),
            verified_email: None,
            role_ids: req.role_ids.as_deref(),
            presence: Presence::Present,
            via: Via::Bot,
            event_at: chrono::Utc::now(),
        },
    )
    .await?;
    if !tenant.0.trim().is_empty() {
        PlatformService::record_membership(&control.0, discord_id, &tenant.0).await?;
    }
    let row = UserEntity::find_by_id(ensured.user_id)
        .one(&db)
        .await?
        .ok_or_else(|| AppError::Internal("member row vanished".to_string()))?;
    Ok(Json(ApiResponse::new(EnsureMemberView {
        user_id: ensured.user_id,
        created: ensured.created,
        active: row.active,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use sea_orm::Database;

    async fn tenant_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("sqlite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    fn request(discord_id: &str) -> EnsureMemberRequest {
        EnsureMemberRequest {
            discord_id: discord_id.to_string(),
            username: Some("  Nouveau  ".to_string()),
            role_ids: None,
        }
    }

    /// Control database for the route; the tenant id is empty, so no membership row is written.
    async fn control() -> ControlDb {
        ControlDb(
            Database::connect("sqlite::memory:")
                .await
                .expect("control sqlite"),
        )
    }

    #[tokio::test]
    async fn ensure_creates_once_and_repeats_are_idempotent() {
        let db = tenant_db().await;
        let tenant = CurrentTenantId(String::new());
        let first = ensure_member(
            BotSecret,
            Extension(db.clone()),
            Extension(control().await),
            Extension(tenant.clone()),
            Json(request("4711")),
        )
        .await
        .expect("first")
        .0
        .data;
        assert!(first.created);
        assert!(first.active);

        let second = ensure_member(
            BotSecret,
            Extension(db.clone()),
            Extension(control().await),
            Extension(tenant),
            Json(request("4711")),
        )
        .await
        .expect("second")
        .0
        .data;
        assert!(!second.created);
        assert_eq!(second.user_id, first.user_id);

        let stored = crate::modules::users::identity::find_by_discord_id(&db, "4711")
            .await
            .expect("lookup")
            .expect("row");
        assert_eq!(stored.provisioned_via, "bot");
        assert_eq!(stored.username, "Nouveau");
    }

    #[tokio::test]
    async fn ensure_rejects_anything_that_is_not_a_snowflake() {
        let db = tenant_db().await;
        let too_long = "9".repeat(26);
        for bad in ["", "  ", "12a", "@someone", too_long.as_str()] {
            let err = ensure_member(
                BotSecret,
                Extension(db.clone()),
                Extension(control().await),
                Extension(CurrentTenantId(String::new())),
                Json(request(bad)),
            )
            .await
            .expect_err(bad);
            assert!(matches!(err, AppError::Validation(_)), "{bad:?}");
        }
    }
}
