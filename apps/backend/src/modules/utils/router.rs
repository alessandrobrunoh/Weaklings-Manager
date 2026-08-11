//! Utils routing module.
//!
//! Exposes generic, reusable backend utilities not tied to any specific domain.

use axum::{Extension, Json, Router, extract::Multipart, routing::post};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;

use super::models::OcrResult;
use super::service::OcrService;
use crate::config::Config;
use crate::errors::{AppError, ProblemDetails};
use crate::modules::auth::UserContext;
use crate::responses::{ApiResponse, ApiResponseOcrResult};

/// Creates the router for the utils module.
pub fn router() -> Router {
    Router::new().route("/ocr", post(ocr_image))
}

fn build_service(cfg: &Config) -> OcrService {
    OcrService::new(cfg.mistral_api_key.clone())
}

/// OCR an uploaded image via Mistral AI.
#[utoipa::path(
    post,
    path = "/api/utils/ocr",
    tag = "utils",
    summary = "OCR an uploaded image via Mistral AI",
    description = "Generic, reusable OCR passthrough with no domain-specific logic. Accepts a \
        single image as `multipart/form-data` (any field name — the first field carrying a \
        non-empty file is used), forwards it to Mistral's OCR API as a base64 data URI, and \
        returns both the raw concatenated text and it split into non-empty, trimmed lines. \
        Consumers needing to match extracted lines against application data (e.g. the splits \
        module matching Albion Online character names via \
        `POST /splits/match-participants`) do that matching themselves against this endpoint's \
        output — this endpoint has no knowledge of players, users, or splits.",
    security(("session_cookie" = [])),
    responses(
        (status = 200, description = "OCR completed successfully", body = ApiResponseOcrResult),
        (status = 400, description = "Validation error - no image file was provided in the multipart body", body = ProblemDetails),
        (status = 401, description = "Unauthorized - no active session", body = ProblemDetails),
        (status = 502, description = "Upstream Mistral OCR API error - the OCR request failed or timed out", body = ProblemDetails)
    )
)]
pub async fn ocr_image(
    _user: UserContext,
    Extension(cfg): Extension<Config>,
    mut multipart: Multipart,
) -> Result<Json<ApiResponse<OcrResult>>, AppError> {
    let mut image: Option<(String, Vec<u8>)> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::Validation(format!("Invalid multipart upload: {e}")))?
    {
        let mime = field.content_type().unwrap_or("image/png").to_string();
        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::Validation(format!("Failed to read uploaded file: {e}")))?;

        if !bytes.is_empty() {
            image = Some((mime, bytes.to_vec()));
            break;
        }
    }

    let (mime, bytes) = image.ok_or_else(|| {
        AppError::Validation("No image file was provided in the multipart body".to_string())
    })?;

    let encoded = BASE64.encode(&bytes);
    let data_uri = format!("data:{mime};base64,{encoded}");

    let service = build_service(&cfg);
    let result = service.extract_text(&data_uri).await?;

    Ok(Json(ApiResponse::new(result)))
}
