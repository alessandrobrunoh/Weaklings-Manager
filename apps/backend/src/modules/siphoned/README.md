# Siphoned energy module

## Overview

This module ingests and manages siphoned-energy ledger entries and exposes per-player balances.

## Interface

The router-relative operations are `POST /ingest`, `GET/POST /entries`, `PUT/DELETE /entries/{entry_id}`, `GET /balances`, `GET /balances/{player_name}`, `GET /batches`, and `DELETE /batches/{batch_id}`. OpenAPI annotations document `/api/siphoned` paths for the inspected ingest, entries, and balance collection operations.

`IngestRequest` contains rows with occurrence time, player name, reason, and decimal amount. Entry views format timestamps as RFC 3339; balance views include per-player totals, net, entry counts, first/last seen, and recent-entry details.

## Invariants

- Rows map to `siphoned_energy_entries`; player grouping uses display names case-insensitively. Amounts are signed. Entity documentation declares no foreign key to users or Albion links.
- Ingest rejects empty input and requests over 1,000 rows, validates rows before opening a transaction, and skips duplicate keys already stored or repeated in the request.
- New rows in one ingest share a generated batch ID and ingestion timestamp.
- Updating an entry changes occurrence time, player name, reason, and amount while retaining source, batch, and ingestion timestamp.
- The manual-create route currently stores source `albion_export` with no batch ID; the `Manual` source enum value is documented as reserved for future use.

## Side Effects

Ingest reads existing keys and inserts non-duplicates in a database transaction. Create inserts a row; update modifies one; delete removes it by ID and returns not-found if none was affected. Ingest and entry mutation handlers require `SiphonedIngest`; inspected entry and balance list handlers require `SiphonedView`.

## Verification

From the repository root, run `cargo test -p backend`.
