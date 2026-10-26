# Utilities module

## Overview

The utilities module provides a generic image OCR passthrough backed by Mistral AI. It does not perform domain-specific matching of extracted text.

## Interface

- `POST /ocr` is documented in OpenAPI as `/api/utils/ocr`; the full runtime mount prefix is owned by the parent router.
- The request is multipart form data. The handler selects the first non-empty field with a supported content type; accepted types are PNG, JPEG, WebP, and GIF.
- The response wraps `OcrResult`, containing raw `text` and normalized non-empty `lines`. The handler takes a `UserContext`.

## Invariants

- Upload selection uses content type and non-empty bytes, not file inspection. The handler does not validate the multipart field name or require exactly one image.
- If no supported non-empty field is found, the handler returns a validation error.
- `OcrService::extract_text` retains raw text and derives `lines` by trimming each line and dropping empty lines.
- The client joins page markdown with newline separators and uses the `mistral-ocr-latest` model.

## Side Effects

The handler base64-encodes the selected image into a data URI and sends it to Mistral through the shared `reqwest` client using the configured API key as bearer authentication. This module does not persist OCR results.

## Verification

From the repository root, run `cargo test -p backend`.
