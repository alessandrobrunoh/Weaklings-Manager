# Albion Data module

## Overview

This module provides market-price lookup through Albion Online Data and constructs browser-ready item-icon URLs.

## Interface

- `GET /prices` is documented as `/api/albiondata/prices`. It accepts comma-separated `items`, with optional server, locations, and qualities.
- `GET /items/{item_id}/icon` is documented as `/api/albiondata/items/{item_id}/icon`; optional query fields select quality and size.
- Both handlers use session-cookie security and return `ApiResponse` values. `AlbionDataService` is the application facade and `AlbionDataApiClient` handles market requests.

## Invariants

- Item IDs are trimmed, blank entries dropped, an empty result rejected, and requests are limited to 120 IDs. The parser does not validate ID syntax or deduplicate.
- The default server is Europe; item-icon defaults are quality 1 and size 64. Icon lookup rejects blank IDs and size zero.
- Market hosts map Americas aliases to west and Asia aliases to east; other values use Europe.
- The item-icon endpoint returns a constructed URL, not proxied image bytes.

## Side Effects

Price lookup sends an HTTP GET to Albion Online Data with item IDs and optional filters. Transport, non-success status, and JSON errors become upstream-service errors. Item-icon construction performs no network request and the module registers GET operations only.

## Verification

From the repository root, run `cargo test -p backend`.
