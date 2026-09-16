//! `Attention` routing module.
//!
//! One read-only endpoint: `GET /findings`, nested at `/attention` in
//! `modules::mod`, so the full path is `/api/attention/findings`. Gated on
//! `Permission::IntelReportView`, the same permission this codebase already
//! uses for every other intel drill-down with no module of its own (see
//! `tenant.rs`'s `("/api/attention", "intel")` feature gate).

use axum::{Extension, Json, Router, routing::get};
use sea_orm::DatabaseConnection;

use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::{Permission, Permissions, UserContext};
use crate::responses::{ApiResponse, ApiResponseAttentionFindingList};

use super::service::{self, AttentionFindingView};
use super::writer;

/// Creates the router for the `attention` module.
pub fn router() -> Router {
    Router::new().route("/findings", get(get_attention_findings))
}

/// Recomputes and lists every currently-held attention finding.
#[utoipa::path(
    get,
    path = "/api/attention/findings",
    tag = "attention",
    summary = "Get the current attention findings",
    description = "Recomputes every deterministic attention-signal rule (plan §7) synchronously \
        on every call — there is no caching and no scheduled recompute, matching this codebase's \
        eager/best-effort style elsewhere. A finding disappears the moment its condition stops \
        holding: this is always \"what's true right now\", never a ticket or a log of past \
        findings.",
    security(("session_cookie" = ["intel.report.view"])),
    responses(
        (status = 200, description = "Attention findings retrieved successfully", body = ApiResponseAttentionFindingList),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 403, description = "Missing the intel.report.view permission", body = ProblemDetails)
    )
)]
pub async fn get_attention_findings(
    user: UserContext,
    Extension(perms): Extension<Permissions>,
    Extension(db): Extension<DatabaseConnection>,
) -> Result<Json<ApiResponse<Vec<AttentionFindingView>>>, AppError> {
    user.require(&perms, Permission::IntelReportView).await?;
    writer::recompute_attention_findings(&db, chrono::Utc::now())
        .await
        .map_err(AppError::Database)?;
    let views = service::list_attention_findings(&db).await?;
    Ok(Json(ApiResponse::new(views)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A smoke test that the router builds without panicking. This codebase
    /// has no established idiom for a direct HTTP-layer router test (no
    /// `tower::ServiceExt::oneshot` usage anywhere else in `modules/`), so
    /// permission-gating and response-shape coverage lives in
    /// `service.rs`/`writer.rs`'s own tests instead.
    #[test]
    fn router_builds_without_panicking() {
        let _ = router();
    }
}
