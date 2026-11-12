//! Tests of the module registry.

use axum::{body::Body, http::Request, http::StatusCode};
use tower::ServiceExt as _;

/// The events router is reached at its mount path. It once answered 404 for every
/// `/api/events` path because `nest` drops a router that is only a fallback.
#[tokio::test]
async fn event_routes_are_reachable_at_their_mount_path() {
    let app = axum::Router::new().nest("/api", super::router());
    for path in ["/api/events?page=1&limit=10", "/api/events/summary", "/api/events/7"] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_ne!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
}
