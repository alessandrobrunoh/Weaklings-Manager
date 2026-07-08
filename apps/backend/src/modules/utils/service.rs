//! Utils service logic module.
//!
//! `OcrService` wraps the Mistral OCR client and adds the generic "raw text -> non-empty
//! trimmed lines" transform. Has no knowledge of any domain concept (players, users, splits) —
//! consumers needing to match extracted lines against application data do that themselves.

use crate::errors::AppError;
use super::client::MistralOcrClient;
use super::models::OcrResult;

/// Service exposing generic OCR operations.
pub struct OcrService {
    client: MistralOcrClient,
}

impl OcrService {
    #[must_use]
    pub fn new(api_key: String) -> Self {
        Self {
            client: MistralOcrClient::new(api_key),
        }
    }

    /// Extracts text from an image (as a data URI), splitting it into trimmed, non-empty lines.
    ///
    /// # Errors
    ///
    /// Returns `AppError::UpstreamService` if the Mistral OCR API call fails.
    pub async fn extract_text(&self, image_data_uri: &str) -> Result<OcrResult, AppError> {
        let text = self.client.ocr_image(image_data_uri).await?;
        let lines = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect();

        Ok(OcrResult { text, lines })
    }
}
