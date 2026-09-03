use axum::{
    Extension, Json, Router,
    routing::{get, post},
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Serialize;

use crate::errors::AppError;
use crate::modules::auth::UserContext;
use crate::responses::ApiResponse;

use super::entities::{Column, Entity, Model};
use super::service::ApplicationService;

#[derive(Debug, Serialize)]
pub struct ApplicationView {
    pub id: i64,
    pub user_discord_id: String,
    pub username: String,
    pub channel_id: String,
    pub status: String,
}

impl From<Model> for ApplicationView {
    fn from(value: Model) -> Self {
        Self {
            id: value.id,
            user_discord_id: value.user_discord_id,
            username: value.username_snapshot,
            channel_id: value.channel_id,
            status: value.status,
        }
    }
}

pub fn router() -> Router {
    Router::new()
        .route("/", post(create_application))
        .route("/active", get(get_active_application))
}

async fn create_application(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    Json(channel_id): Json<String>,
) -> Result<Json<ApiResponse<ApplicationView>>, AppError> {
    let application = ApplicationService::create(&db, &user, &channel_id).await?;
    Ok(Json(ApiResponse::new(application.into())))
}

async fn get_active_application(
    user: UserContext,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
) -> Result<Json<ApiResponse<Option<ApplicationView>>>, AppError> {
    let application = Entity::find()
        .filter(Column::UserDiscordId.eq(user.id))
        .filter(Column::Status.eq("open"))
        .one(&db)
        .await?
        .map(Into::into);
    Ok(Json(ApiResponse::new(application)))
}
