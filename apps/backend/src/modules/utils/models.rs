//! Request/response DTOs for the utils module.

use serde::Serialize;
use utoipa::ToSchema;

/// The result of OCR-ing an uploaded image.
#[derive(Debug, Serialize, ToSchema)]
#[schema(example = json!({
    "text": "Alice\nBob\nCarol",
    "lines": ["Alice", "Bob", "Carol"]
}))]
pub struct OcrResult {
    /// The raw concatenated text extracted from the image.
    pub text: String,
    /// `text` split into trimmed, non-empty lines.
    pub lines: Vec<String>,
}
