//! Scripted upstream for cache and retry tests: a loopback HTTP server that
//! answers one canned response per request and records what it was asked.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A running fake upstream.
pub struct FakeUpstream {
    /// Base URL to hand to the client, for example `http://127.0.0.1:4000`.
    pub base_url: String,
    /// Request lines (`GET /path HTTP/1.1`) in arrival order.
    pub requests: Arc<Mutex<Vec<String>>>,
}

impl FakeUpstream {
    /// Number of requests received so far.
    pub fn request_count(&self) -> usize {
        self.requests.lock().expect("requests lock").len()
    }
}

/// Starts a server that answers request `n` with `responses[min(n, len - 1)]`.
/// Every response must be a complete HTTP/1.1 message with `Connection: close`.
pub async fn serve(responses: Vec<String>) -> FakeUpstream {
    assert!(!responses.is_empty(), "at least one scripted response");
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local addr");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 1024];
            while !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                match socket.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => buffer.extend_from_slice(&chunk[..read]),
                }
            }
            let head = String::from_utf8_lossy(&buffer);
            let request_line = head.lines().next().unwrap_or_default().to_string();
            let index = {
                let mut seen = recorded.lock().expect("requests lock");
                seen.push(request_line);
                seen.len() - 1
            };
            let response = &responses[index.min(responses.len() - 1)];
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });
    FakeUpstream {
        base_url: format!("http://{addr}"),
        requests,
    }
}

/// A complete `200 OK` JSON response.
pub fn json_ok(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// A bodyless error response with optional extra header lines (each ending in `\r\n`).
pub fn status(code: &str, extra_headers: &str) -> String {
    format!("HTTP/1.1 {code}\r\n{extra_headers}Content-Length: 0\r\nConnection: close\r\n\r\n")
}
