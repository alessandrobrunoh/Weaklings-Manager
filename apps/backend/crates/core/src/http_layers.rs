//! Transport layers wrapped around the whole API router.
//!
//! * Response compression (gzip) for the large JSON payloads, such as the ~800 KB
//!   `OpenAlbion` catalog. `tower-http` skips responses it should not touch (images,
//!   event streams, tiny bodies), so streaming endpoints are unaffected.
//! * A response deadline for the request future. It covers the time until the
//!   handler returns its response head, not the body, so long streams are not cut.
//!   Expiry answers `408` with an empty body and leaves the error type `Infallible`.
//! * A request body ceiling, checked up front from `Content-Length` and while the body
//!   streams. Extractors keep their own, smaller, defaults.

use std::time::Duration;

use axum::Router;
use axum::http::StatusCode;
use tower_http::{
    compression::CompressionLayer, limit::RequestBodyLimitLayer, timeout::TimeoutLayer,
};

/// Longest a handler may take to produce its response head.
///
/// Expiry drops the handler future, so the work it had not finished is abandoned while
/// the client receives `408` and may retry. Cancellation is safe only where a handler
/// writes inside one database transaction (dropping the transaction rolls it back) or
/// does not write at all. A handler that writes in several statements, or that sends an
/// upstream request (`AlbionBB`, `Discord`) and then keeps working, can leave partial state
/// or a duplicate side effect behind. Accepted for the 60 s budget; any route that can
/// legitimately run longer needs its own layer outside this one.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Largest request body accepted by any route (8 MiB).
pub const REQUEST_BODY_LIMIT_BYTES: usize = 8 * 1024 * 1024;

/// Applies compression, the request deadline and the body ceiling to `router`.
pub fn apply<S>(router: Router<S>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    apply_with_timeout(router, REQUEST_TIMEOUT)
}

/// [`apply`] with an explicit deadline, so tests need not wait a minute.
pub fn apply_with_timeout<S>(router: Router<S>, timeout: Duration) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router
        .layer(RequestBodyLimitLayer::new(REQUEST_BODY_LIMIT_BYTES))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            timeout,
        ))
        .layer(CompressionLayer::new())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::Router;
    use axum::body::{Body, Bytes};
    use axum::http::{Request, StatusCode, header};
    use axum::routing::{get, post};
    use tower::ServiceExt;

    use super::{REQUEST_BODY_LIMIT_BYTES, apply_with_timeout};

    fn router(timeout: Duration) -> Router {
        apply_with_timeout(
            Router::new()
                .route("/big", get(|| async { "x".repeat(16 * 1024) }))
                .route(
                    "/slow",
                    get(|| async {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        "late"
                    }),
                )
                .route(
                    "/echo",
                    post(|body: Bytes| async move { body.len().to_string() }),
                ),
            timeout,
        )
    }

    #[tokio::test]
    async fn large_responses_are_gzipped_when_the_client_accepts_it() {
        let response = router(Duration::from_secs(5))
            .oneshot(
                Request::builder()
                    .uri("/big")
                    .header(header::ACCEPT_ENCODING, "gzip")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_ENCODING)
                .map(|v| v.to_str().ok()),
            Some(Some("gzip"))
        );
    }

    #[tokio::test]
    async fn responses_are_plain_without_an_accept_encoding_header() {
        let response = router(Duration::from_secs(5))
            .oneshot(
                Request::builder()
                    .uri("/big")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get(header::CONTENT_ENCODING).is_none());
    }

    #[tokio::test]
    async fn a_handler_past_the_deadline_gets_408() {
        let response = router(Duration::from_millis(50))
            .oneshot(
                Request::builder()
                    .uri("/slow")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("the timeout is a response, not an error");

        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
    }

    #[tokio::test]
    async fn a_handler_within_the_deadline_is_untouched() {
        let response = router(Duration::from_secs(5))
            .oneshot(
                Request::builder()
                    .uri("/big")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn a_declared_body_over_the_ceiling_is_refused_before_the_handler() {
        let too_big = REQUEST_BODY_LIMIT_BYTES + 1;
        let response = router(Duration::from_secs(5))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/echo")
                    .header(header::CONTENT_LENGTH, too_big)
                    .body(Body::from(vec![0_u8; too_big]))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn a_body_under_the_ceiling_still_reaches_the_handler() {
        let response = router(Duration::from_secs(5))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/echo")
                    .body(Body::from(vec![0_u8; 1024]))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
    }
}
