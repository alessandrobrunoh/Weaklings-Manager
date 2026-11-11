//! Platform-admin routes over the event fanout outbox, mounted under `/api/platform`.
//!
//! The outbox belongs to the events feature, so these handlers live here; the app merges
//! [`platform_routes`] into the control-plane platform router.

use axum::{
    Extension, Json, Router,
    extract::Path,
    routing::{get, post},
};

use crate::errors::{AppError, ProblemDetails};
use crate::modules::events::fanout_outbox::{self, ExhaustedTarget};
use crate::modules::platform::PlatformAdmin;
use crate::responses::ApiResponse;
use crate::tenant::ControlDb;

/// Routes merged into the `/api/platform` router.
pub fn platform_routes() -> Router {
    Router::new()
        .route("/fanout/exhausted", get(list_exhausted_fanout))
        .route(
            "/fanout/exhausted/{job_id}/{tenant_id}/requeue",
            post(requeue_exhausted_fanout),
        )
}

/// Maximum exhausted fanout targets returned by one listing.
const EXHAUSTED_FANOUT_LIST_LIMIT: u64 = 200;

/// List event fanout targets that used up their retries.
#[utoipa::path(
    get,
    path = "/api/platform/fanout/exhausted",
    tag = "platform",
    responses(
        (status = 200, description = "Exhausted fanout targets, newest first", body = ApiResponse<Vec<ExhaustedTarget>>),
        (status = 403, description = "Not a platform admin", body = ProblemDetails)
    )
)]
pub async fn list_exhausted_fanout(
    _admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
) -> Result<Json<ApiResponse<Vec<ExhaustedTarget>>>, AppError> {
    Ok(Json(ApiResponse::new(
        fanout_outbox::list_exhausted(&control.0, EXHAUSTED_FANOUT_LIST_LIMIT).await?,
    )))
}

/// Re-arm one exhausted fanout target (attempts reset, due immediately).
#[utoipa::path(
    post,
    path = "/api/platform/fanout/exhausted/{job_id}/{tenant_id}/requeue",
    tag = "platform",
    params(
        ("job_id" = String, Path, description = "Fanout job id"),
        ("tenant_id" = String, Path, description = "Destination tenant id")
    ),
    responses(
        (status = 200, description = "Target requeued"),
        (status = 403, description = "Not a platform admin", body = ProblemDetails),
        (status = 404, description = "No exhausted target for that job and tenant", body = ProblemDetails)
    )
)]
pub async fn requeue_exhausted_fanout(
    admin: PlatformAdmin,
    Extension(control): Extension<ControlDb>,
    Path((job_id, tenant_id)): Path<(uuid::Uuid, String)>,
) -> Result<Json<ApiResponse<()>>, AppError> {
    fanout_outbox::requeue_exhausted(&control.0, job_id, &tenant_id).await?;
    tracing::info!(
        job_id = %job_id,
        target_tenant_id = %tenant_id,
        actor = %admin.discord_id,
        "exhausted event fanout target requeued"
    );
    Ok(Json(ApiResponse::new(())))
}
