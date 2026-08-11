//! Mistral AI OCR API client.
//!
//! Thin wrapper around Mistral's OCR endpoint (see <https://docs.mistral.ai/capabilities/OCR/>).
//! Sends a base64 data-URI-encoded image and returns the concatenated extracted text across
//! every page Mistral reports back.

use crate::errors::AppError;
use serde::{Deserialize, Serialize};

/// Base URL of the Mistral OCR API.
const BASE_URL: &str = "https://api.mistral.ai/v1/ocr";

/// The Mistral OCR model to use.
const MODEL: &str = "mistral-ocr-latest";

#[derive(Debug, Serialize)]
struct MistralOcrDocument<'a> {
    #[serde(rename = "type")]
    doc_type: &'a str,
    image_url: &'a str,
}

#[derive(Debug, Serialize)]
struct MistralOcrRequest<'a> {
    model: &'a str,
    document: MistralOcrDocument<'a>,
}

#[derive(Debug, Deserialize)]
struct MistralOcrPage {
    #[serde(default)]
    markdown: String,
}

#[derive(Debug, Deserialize)]
struct MistralOcrResponse {
    #[serde(default)]
    pages: Vec<MistralOcrPage>,
}

/// Thin typed HTTP client for the Mistral AI OCR API.
pub struct MistralOcrClient {
    http: reqwest::Client,
    api_key: String,
}

impl MistralOcrClient {
    #[must_use]
    pub fn new(api_key: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key,
        }
    }

    /// Sends an image (as a data URI, e.g. `"data:image/png;base64,..."`) to Mistral OCR and
    /// returns the concatenated markdown text extracted across all pages.
    ///
    /// # Errors
    ///
    /// Returns `AppError::UpstreamService` if the request fails, Mistral returns a non-2xx
    /// status, or the response cannot be parsed.
    pub async fn ocr_image(&self, image_data_uri: &str) -> Result<String, AppError> {
        let body = MistralOcrRequest {
            model: MODEL,
            document: MistralOcrDocument {
                doc_type: "image_url",
                image_url: image_data_uri,
            },
        };

        let response = self
            .http
            .post(BASE_URL)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                AppError::UpstreamService(format!("Failed to contact Mistral OCR API: {e}"))
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(AppError::UpstreamService(format!(
                "Mistral OCR API returned {status}: {detail}"
            )));
        }

        let parsed = response.json::<MistralOcrResponse>().await.map_err(|e| {
            AppError::UpstreamService(format!("Failed to parse Mistral OCR API response: {e}"))
        })?;

        Ok(parsed
            .pages
            .into_iter()
            .map(|p| p.markdown)
            .collect::<Vec<_>>()
            .join("\n"))
    }
}
