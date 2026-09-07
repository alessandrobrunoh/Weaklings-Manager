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

/// MIME types Mistral's OCR endpoint documents support for.
///
/// Anything else still reaches this handler — a browser file input always
/// sets a content type, but nothing stops a raw HTTP client from lying about
/// one or omitting it — so it is checked rather than assumed.
const ALLOWED_IMAGE_MIME_TYPES: &[&str] =
    &["image/png", "image/jpeg", "image/webp", "image/gif"];

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
    multipart: Multipart,
) -> Result<Json<ApiResponse<OcrResult>>, AppError> {
    let (mime, bytes) = extract_supported_image(multipart).await?;

    let encoded = BASE64.encode(&bytes);
    let data_uri = format!("data:{mime};base64,{encoded}");

    let service = build_service(&cfg);
    let result = service.extract_text(&data_uri).await?;

    Ok(Json(ApiResponse::new(result)))
}

/// Finds the first multipart field carrying a non-empty, supported image and
/// returns its content type and raw bytes.
///
/// Split out of [`ocr_image`] so the validation — the only part of this
/// handler that does not depend on a live Mistral call — can be exercised
/// directly in a test.
///
/// # Errors
///
/// Returns `AppError::Validation` if the multipart body is malformed, a field
/// cannot be read, or no field's content type is in
/// [`ALLOWED_IMAGE_MIME_TYPES`].
async fn extract_supported_image(mut multipart: Multipart) -> Result<(String, Vec<u8>), AppError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::Validation(format!("Invalid multipart upload: {e}")))?
    {
        // No fallback: a part with no content type, or one that isn't a
        // supported image, must not be silently labeled `image/png` and
        // forwarded to Mistral as if it were one.
        let Some(mime) = field.content_type() else {
            continue;
        };
        if !ALLOWED_IMAGE_MIME_TYPES.contains(&mime) {
            continue;
        }
        let mime = mime.to_owned();
        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::Validation(format!("Failed to read uploaded file: {e}")))?;

        if !bytes.is_empty() {
            return Ok((mime, bytes.to_vec()));
        }
    }

    Err(AppError::Validation(format!(
        "No supported image file was provided in the multipart body (expected one of {})",
        ALLOWED_IMAGE_MIME_TYPES.join(", ")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::FromRequest;
    use axum::http::{Request, header};

    const BOUNDARY: &str = "X-TEST-BOUNDARY";

    /// Builds a `Multipart` extractor over one field, the way a real
    /// `multipart/form-data` request would carry it.
    async fn multipart_with_one_field(content_type: Option<&str>, content: &[u8]) -> Multipart {
        let mut body = format!("--{BOUNDARY}\r\n").into_bytes();
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"upload\"\r\n",
        );
        if let Some(content_type) = content_type {
            body.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
        }
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(content);
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

        let request = Request::builder()
            .method("POST")
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={BOUNDARY}"),
            )
            .body(Body::from(body))
            .expect("valid request");
        Multipart::from_request(request, &()).await.expect("valid multipart body")
    }

    #[tokio::test]
    async fn accepts_a_supported_image_type() {
        let multipart = multipart_with_one_field(Some("image/png"), b"not really png bytes").await;
        let (mime, bytes) = extract_supported_image(multipart).await.expect("accepted");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"not really png bytes");
    }

    #[tokio::test]
    async fn rejects_an_unsupported_content_type_instead_of_forwarding_it() {
        let multipart = multipart_with_one_field(Some("text/html"), b"<script>").await;
        let err = extract_supported_image(multipart).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    /// The escalation this change exists to close: no content type must not
    /// silently become `image/png`.
    #[tokio::test]
    async fn rejects_a_field_with_no_content_type_rather_than_defaulting_to_png() {
        let multipart = multipart_with_one_field(None, b"anonymous bytes").await;
        let err = extract_supported_image(multipart).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn rejects_an_empty_field_even_with_a_supported_content_type() {
        let multipart = multipart_with_one_field(Some("image/jpeg"), b"").await;
        let err = extract_supported_image(multipart).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
