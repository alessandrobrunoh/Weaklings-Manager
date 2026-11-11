//! Standard API response envelopes.
//!
//! Provides wrappers to maintain consistent success response formatting.

use serde::Serialize;
use utoipa::ToSchema;

/// The standard success wrapper envelope (`JSend` style) for generics.
///
/// Annotations name the instantiation directly, e.g. `body = ApiResponse<TenantView>`.
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponse<T> {
    /// Indicates the outcome of the request, always "success" for this envelope.
    pub status: &'static str,
    /// The actual payload of the response.
    pub data: T,
}

impl<T> ApiResponse<T> {
    /// Wraps a data payload in the standard success envelope.
    pub fn new(data: T) -> Self {
        Self {
            status: "success",
            data,
        }
    }
}
