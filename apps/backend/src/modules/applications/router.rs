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
        }
    }
}

pub fn router() -> Router {
    Router::new()
        .route("/", post(create_application))
        .route("/active", get(get_active_application))
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
    )
    .await?;
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
    let default_role_discord_id = role::Entity::find()
        .filter(role::Column::IsDefault.eq(true))
        .one(&db)
        .await?
        .and_then(|item| item.discord_role_id);
    let fallback_auto_role =
        crate::modules::admin::service::AdminService::get_autorole_settings(&db)
            .await
            .ok()
            .and_then(|settings| settings.discord_auto_role_id);
    let assigned_role = default_role_discord_id.or(fallback_auto_role);
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
