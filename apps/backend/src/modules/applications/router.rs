use axum::{
    Extension, Json, Router,
    extract::Path,
    routing::{get, post},
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Serialize;

use crate::errors::AppError;
use crate::modules::auth::entities::role;
use crate::modules::auth::{BotDiscordUser, Permission, Permissions, UserContext};
use crate::responses::ApiResponse;
use serde::Deserialize;

use super::entities::{Column, Entity, Model};
use super::service::ApplicationService;

#[derive(Debug, Serialize)]
pub struct ApplicationView {
    pub id: i64,
    pub user_discord_id: String,
    pub username: String,
    pub channel_id: String,
    pub status: String,
    pub default_role_discord_id: Option<String>,
    /// Albion character the applicant gave when opening the ticket.
    pub ingame_name: Option<String>,
    /// How many times this same ticket has been brought back from the archive.
    pub reopen_count: i32,
}

impl From<Model> for ApplicationView {
    fn from(value: Model) -> Self {
        Self {
            id: value.id,
            user_discord_id: value.user_discord_id,
            username: value.username_snapshot,
            channel_id: value.channel_id,
            status: value.status,
            default_role_discord_id: None,
            ingame_name: value.ingame_name,
            reopen_count: value.reopen_count,
        }
    }
}

pub fn router() -> Router {
    Router::new()
        .route("/", post(create_application))
        .route("/active", get(get_active_application))
        .route("/latest", get(get_latest_application))
        .route("/{id}/reopen", post(reopen_application))
        .route("/{id}/accept", post(accept_application))
        .route("/{id}/decline", post(decline_application))
        .route("/{id}/close", post(close_application))
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CreateApplicationBody {
    ChannelId(String),
    Payload {
        channel_id: String,
        #[serde(default)]
        username: Option<String>,
        /// Albion character the applicant typed into the opening form.
        #[serde(default)]
        ingame_name: Option<String>,
    },
}

impl CreateApplicationBody {
    fn channel_id(&self) -> &str {
        match self {
            Self::ChannelId(channel_id) | Self::Payload { channel_id, .. } => channel_id,
        }
    }

    fn username<'a>(&'a self, actor: &'a BotDiscordUser) -> &'a str {
        match self {
            Self::Payload {
                username: Some(username),
                ..
            } if !username.trim().is_empty() => username.trim(),
            _ => actor
                .username
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or(&actor.discord_id),
        }
    }

    fn ingame_name(&self) -> Option<&str> {
        match self {
            Self::Payload { ingame_name, .. } => ingame_name.as_deref(),
            Self::ChannelId(_) => None,
        }
    }
}

async fn create_application(
    actor: BotDiscordUser,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(body): Json<CreateApplicationBody>,
) -> Result<Json<ApiResponse<ApplicationView>>, AppError> {
    let application = ApplicationService::create(
        &db,
        &actor.discord_id,
        actor.user_id,
        body.username(&actor),
        body.channel_id(),
        body.ingame_name(),
    )
    .await?;
    Ok(Json(ApiResponse::new(application.into())))
}

/// The caller's most recent ticket, in whatever state it ended.
async fn get_latest_application(
    actor: BotDiscordUser,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Option<ApplicationView>>>, AppError> {
    let application = ApplicationService::latest_for_user(&db, &actor.discord_id)
        .await?
        .map(Into::into);
    Ok(Json(ApiResponse::new(application)))
}

#[derive(Debug, Default, Deserialize)]
struct ReopenApplicationBody {
    /// Albion character given in the reopening form, when the applicant retyped it.
    #[serde(default)]
    ingame_name: Option<String>,
}

/// Brings the caller's own archived ticket back to `open`.
///
/// Only the applicant reopens their ticket: it happens when they press the
/// panel button again, and `ApplicationService::reopen` refuses a row that
/// belongs to anyone else.
async fn reopen_application(
    Path(id): Path<i64>,
    actor: BotDiscordUser,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    body: Option<Json<ReopenApplicationBody>>,
) -> Result<Json<ApiResponse<ApplicationView>>, AppError> {
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let application =
        ApplicationService::reopen(&db, id, &actor.discord_id, body.ingame_name.as_deref()).await?;
    Ok(Json(ApiResponse::new(application.into())))
}

async fn get_active_application(
    actor: BotDiscordUser,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Option<ApplicationView>>>, AppError> {
    let application = Entity::find()
        .filter(Column::UserDiscordId.eq(&actor.discord_id))
        .filter(Column::Status.eq("open"))
        .one(&db)
        .await?
        .map(Into::into);
    Ok(Json(ApiResponse::new(application)))
}

async fn accept_application(
    Path(id): Path<i64>,
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ApplicationView>>, AppError> {
    user.require(&perms, Permission::ApplicationsManage).await?;
    let settings = crate::modules::admin::service::AdminService::get_guild_settings(&db)
        .await
        .ok();
    let accepted_application_role = settings
        .as_ref()
        .and_then(|s| s.discord_applications_accepted_role_id.clone());
    let default_role_discord_id = role::Entity::find()
        .filter(role::Column::IsDefault.eq(true))
        .one(&db)
        .await?
        .and_then(|item| item.discord_role_id);
    let assigned_role = accepted_application_role.or(default_role_discord_id);
    let application = ApplicationService::resolve(&db, id, &user.id, "accepted").await?;
    let mut view: ApplicationView = application.into();
    view.default_role_discord_id = assigned_role;
    Ok(Json(ApiResponse::new(view)))
}

async fn decline_application(
    Path(id): Path<i64>,
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ApplicationView>>, AppError> {
    user.require(&perms, Permission::ApplicationsManage).await?;
    let application = ApplicationService::resolve(&db, id, &user.id, "declined").await?;
    Ok(Json(ApiResponse::new(application.into())))
}

async fn close_application(
    Path(id): Path<i64>,
    actor: BotDiscordUser,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<ApplicationView>>, AppError> {
    let existing = Entity::find()
        .filter(Column::Id.eq(id))
        .one(&db)
        .await?
        .ok_or_else(|| AppError::NotFound("Application not found".into()))?;
    if existing.user_discord_id != actor.discord_id {
        perms
            .require(
                actor.is_superadmin,
                &actor.roles,
                Permission::ApplicationsManage,
            )
            .await?;
    }
    let application = ApplicationService::resolve(&db, id, &actor.discord_id, "closed").await?;
    Ok(Json(ApiResponse::new(application.into())))
}
