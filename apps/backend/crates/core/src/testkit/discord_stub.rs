//! In-process Discord REST stub: an axum server on an ephemeral port.
//!
//! Tests point `Config.discord_api_base` at [`DiscordStub::base_url`] and answer every request
//! through a closure. Each request is recorded so a test can assert on the method, path and
//! `Authorization` header that reached "Discord".

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Uri};
use axum::response::Response;

/// One request as the stub received it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StubRequest {
    /// HTTP method, upper case.
    pub method: String,
    /// Path and query, including the `/api/v10` prefix of the base URL.
    pub path: String,
    /// `Authorization` header, if sent.
    pub authorization: Option<String>,
}

/// The stub's answer to one request.
#[derive(Debug, Clone)]
pub struct StubReply {
    /// HTTP status code.
    pub status: u16,
    /// Response body.
    pub body: String,
    /// Raw `Retry-After` header, if any.
    pub retry_after: Option<String>,
}

impl StubReply {
    /// A JSON answer with `status` and `body`.
    #[must_use]
    pub fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            body: body.to_owned(),
            retry_after: None,
        }
    }

    /// An answer with no body.
    #[must_use]
    pub fn empty(status: u16) -> Self {
        Self::json(status, "")
    }

    /// Adds a `Retry-After` header.
    #[must_use]
    pub fn with_retry_after(mut self, value: &str) -> Self {
        self.retry_after = Some(value.to_owned());
        self
    }
}

/// A running stub. The server lives until the test runtime shuts down.
pub struct DiscordStub {
    /// Base URL to put in `Config.discord_api_base` (ends with `/api/v10`).
    pub base_url: String,
    requests: Arc<Mutex<Vec<StubRequest>>>,
}

impl DiscordStub {
    /// Starts a stub that answers every request with `handler`.
    ///
    /// # Panics
    ///
    /// Panics when the loopback socket cannot be bound.
    pub async fn start<F>(handler: F) -> Self
    where
        F: Fn(&StubRequest) -> StubReply + Send + Sync + 'static,
    {
        let handler = Arc::new(handler);
        let requests: Arc<Mutex<Vec<StubRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let app = Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap| {
            let handler = Arc::clone(&handler);
            let recorded = Arc::clone(&recorded);
            async move {
                let request = StubRequest {
                    method: method.to_string(),
                    path: uri
                        .path_and_query()
                        .map_or_else(|| uri.path().to_owned(), |pq| pq.as_str().to_owned()),
                    authorization: headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                };
                recorded
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(request.clone());
                let reply = handler(&request);
                let mut builder = Response::builder()
                    .status(reply.status)
                    .header("content-type", "application/json");
                if let Some(value) = reply.retry_after {
                    builder = builder.header("retry-after", value);
                }
                builder
                    .body(Body::from(reply.body))
                    .expect("stub response is valid")
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind discord stub");
        let address = listener.local_addr().expect("stub address");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve discord stub");
        });
        Self {
            base_url: format!("http://{address}/api/v10"),
            requests,
        }
    }

    /// Every request received so far, in arrival order.
    #[must_use]
    pub fn requests(&self) -> Vec<StubRequest> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}
