# Bank module

## Overview

The bank module implements the guild transaction ledger, derived balances, summaries, and withdrawal lifecycle. Alliance tenants have no transaction table of their own: reads fan out across active member guilds and writes proxy to a member guild's bank service.

## Interface

The module-relative router provides balance and guild/admin summaries; transaction listing, creation, update, and deletion; and withdrawal request, accept, and reject operations. `BankService` provides ledger and withdrawal operations.

Balance queries may target another user only with `BankViewOthers`. Transaction list filters include pagination, transaction fields, user, and global mode; request DTOs cover create/update and withdrawal actions.

## Invariants

- Transaction statuses are stored as lowercase strings: `pending`, `requested`, `rejected`, `withdrawn`, and `donated`. Amount is positive; direction is represented by payer/recipient/destination.
- Balances are derived from transaction rows, not stored. Requested withdrawals are reported separately; rejected withdrawals remain requestable.
- Withdrawal selection is limited to the recipient's requestable rows. Explicit selections are checked for ownership/requestability and cannot exceed the net requestable balance.
- Accept only affects requested rows. Conditional status checks skip rows changed concurrently.
- Alliance reads ignore non-active guilds; alliance writes select one member guild and invoke its bank service.

## Side Effects

Withdrawal request and acceptance update selected transaction rows and linked splits inside a database transaction, then commit. Request auditing is best-effort; acceptance audit errors propagate. Recipient notification is best-effort and is omitted when the officer is also the recipient. Alliance member databases that cannot be opened are skipped with a warning.

## Verification

From the repository root, run `cargo test -p backend`.
