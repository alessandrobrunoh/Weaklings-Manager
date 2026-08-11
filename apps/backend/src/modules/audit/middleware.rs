use axum::{
    body::{Body, Bytes},
    extract::Request,
    http::{Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use sea_orm::DatabaseConnection;
use serde_json::json;
use crate::modules::auth::UserContext;
use super::service::AuditService;

pub async fn audit_middleware(
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // We only care about mutative actions for audit logging
    if req.method() == Method::GET || req.method() == Method::OPTIONS {
        return Ok(next.run(req).await);
    }

    let method = req.method().clone();
    let uri = req.uri().clone();
    let action = format!("{} {}", method, uri.path());

    // Try to extract user from extensions.
    // UserContext is usually populated by the auth extractor before this middleware runs,
    // provided the middleware is placed *after* auth, OR we can extract it if the router 
    // uses `UserContext` as an extractor. Wait, `UserContext` is extracted by the handler, 
    // it's not placed in `req.extensions()` automatically by Axum unless we have an auth middleware.
    // If it's an extractor, the handler runs it. Middleware runs before the handler.
    // So the middleware can run `try_from_bot_headers` or similar, but it's easier to just 
    // run the request, get the response, and then log. But we still need the user!

    // Instead of full middleware, let's just log manually in key handlers or service methods.
    // Doing it manually provides much better `entity_id` and `details`.

    Ok(next.run(req).await)
}
