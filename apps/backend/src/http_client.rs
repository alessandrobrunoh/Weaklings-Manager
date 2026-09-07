//! One shared [`reqwest::Client`] for outgoing calls that build their own
//! per-call, rather than owning a long-lived typed client (`AlbionApiClient`,
//! `AlbionBbApiClient`, `AlbionDataApiClient` already do this correctly —
//! they build their `Client` once in their own `new()` and store it).
//!
//! `reqwest::Client` holds a connection pool internally and the crate's own
//! docs recommend building one and reusing it: `.clone()` is cheap (it's
//! `Arc`-backed under the hood) because it shares that pool rather than
//! opening a new one. A handler that calls `reqwest::Client::new()` on every
//! request pays for a fresh TCP + TLS handshake on every single outgoing
//! call instead — for a request pattern this crate uses often (a Discord
//! Bot API call per admin action, per login, per tenant registration), that
//! adds up.
//!
//! Call [`shared`] instead of `reqwest::Client::new()`. If one call needs a
//! different timeout than the default below, set it on the individual
//! request with [`reqwest::RequestBuilder::timeout`] rather than building a
//! separate client just for that.

use std::sync::OnceLock;
use std::time::Duration;

/// Applied to every request through [`shared`] unless a call overrides it
/// with [`reqwest::RequestBuilder::timeout`]. Matches the timeout most
/// call sites already asked for individually before this existed.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// The process-wide HTTP client for ad hoc outgoing calls.
///
/// Returns an owned `Client`, but cloning one is cheap and shares the same
/// underlying connection pool — this is not a fresh client per call.
#[must_use]
pub fn shared() -> reqwest::Client {
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(DEFAULT_TIMEOUT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::shared;

    /// Mostly a smoke test: `Client` exposes nothing that lets a test prove
    /// two clones share one pool from the outside, but this at least
    /// confirms `shared` builds successfully and stays callable many times
    /// (the `OnceLock` on repeat calls path, not just the first).
    #[test]
    fn callable_repeatedly_without_panicking() {
        for _ in 0..3 {
            let _client = shared();
        }
    }
}
