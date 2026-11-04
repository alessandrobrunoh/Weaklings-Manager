# Siphoned energy module

## Overview

This module ingests and manages siphoned-energy ledger entries and exposes per-player balances.

## Interface

The router-relative operations are `POST /ingest`, `GET/POST /entries`, `PUT/DELETE /entries/{entry_id}`, `GET /balances`, `GET /balances/{player_name}`, `GET /batches`, `DELETE /batches/{batch_id}`, `POST /settlement-quotes`, and `POST /settlement-quotes/{quote_id}/confirm`.

`IngestRequest` contains rows with occurrence time, player name, reason, and decimal amount. Entry views format timestamps as RFC 3339; balance views include per-player totals, net, entry counts, first/last seen, and recent-entry details.

## Invariants

- Rows map to `siphoned_energy_entries`; player grouping uses display names case-insensitively. Amounts are signed. Entity documentation declares no foreign key to users or Albion links.
- Ingest rejects empty input and requests over 1,000 rows, validates rows before opening a transaction, and skips duplicate keys already stored or repeated in the request.
- New rows in one ingest share a generated batch ID and ingestion timestamp.
- Updating an entry changes occurrence time, player name, reason, and amount while retaining source, batch, and ingestion timestamp.
- The manual-create route currently stores source `albion_export` with no batch ID; atomic settlement rows use source `manual` and no batch ID.
- Settlement quotes are server-generated, actor-bound, and expire after two minutes. Pricing uses Albion Online Data's `sell_price_min`, then `buy_price_max`, then the existing 11,000 silver fallback.
- Confirmation accepts only the quote ID. It rejects expired quotes and any debt whose current net no longer matches the quoted debt. A quote's confirmation writes the positive siphoned settlement entry, donated bank transaction, audit row, and replay result in one transaction.
- A quote confirmation is idempotent: retrying it as the same officer returns the original entry and transaction ids. PostgreSQL advisory locks serialize settlement and siphoned-ledger mutations by case-folded player name.

## Side Effects

Ingest reads existing keys and inserts non-duplicates in a database transaction. Create inserts a row; update modifies one; delete removes it by ID and returns not-found if none was affected. Ingest and entry mutation handlers require `SiphonedIngest`; inspected entry and balance list handlers require `SiphonedView`. Quote and confirmation operations require both `SiphonedIngest` and `BankTransactionsCreate`.

## Verification

From the repository root, run `cargo test -p backend`.
