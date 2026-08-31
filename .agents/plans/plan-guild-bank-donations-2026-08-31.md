# Plan: Guild Bank donations and admin ledger

**Status**: Implementing

## Objective

Allow a member to donate their own payout share from a completed loot split to the Guild Bank through an explicit irreversible confirmation, and give authorized administrators a dedicated bank panel with the complete transaction ledger and money-flow statistics.

## Scope

- Add an atomic, self-only donation operation for an eligible split credit.
- Preserve an auditable transaction row with source and destination labels.
- Add a permissioned `/admin/bank` panel for all transactions and aggregates.
- Keep the existing member bank page and withdrawal workflow working.
- Add Italian, English, and Spanish copy for the new UI states.

## Assumption

“Il mio Split” means the current member’s own share in a completed split, not the entire split or another member’s share. The donation is available only while that share is still requestable (`pending` or `rejected`), and it cannot be reversed after confirmation.

## Acceptance criteria

- [ ] A participant can see a “Donate to Guild Bank” action for their own eligible split share in `splits/:splitId`.
- [ ] The action opens an accessible modal confirmation that shows the exact silver amount and states clearly that the operation is irreversible.
- [ ] Cancelling or dismissing the modal causes no API call and no state change.
- [ ] Confirming the action atomically changes only the caller’s eligible split credit, records the caller as source, records Guild Bank as destination, marks it donated, and makes a second donation impossible.
- [ ] Unauthorized users cannot donate another member’s share, a non-split transaction, a withdrawn/requested transaction, or a share belonging to another split.
- [ ] The Admin panel exposes a permission-protected Bank section and loads all ledger transactions with source, destination, type, amount, status, split link, and timestamps.
- [ ] The Admin bank panel shows totals for ledger volume, pending/requested/rejected obligations, paid out, and donated silver, plus grouped source, destination, and transaction-type breakdowns.
- [ ] Existing member bank, split completion, regear credits, withdrawal flow, and notification behavior remain compatible.
- [ ] Backend tests, frontend tests/build, formatting, and static checks pass.

## Vertical slices

### Slice 1: A member can irreversibly donate their own eligible split share

**Actor**: A split participant.

**Trigger**: Opens a completed split, selects their own eligible share, confirms the exact amount in the modal.

**Observable outcome**: The share is shown as donated to Guild Bank, disappears from the member’s requestable balance, and the API rejects repeat or invalid donations.

**Production path**: Split detail UI → donation endpoint → bank service atomic update → transaction ledger/audit → refreshed split detail.

**RED**: Add backend service tests for success, ownership/status/type validation, repeat donation, and exact ledger source/destination; add frontend tests for modal confirmation/cancellation and successful refresh if the project’s current component test harness supports the page.

**GREEN**: Add the donated transaction state, nullable virtual-bank destination representation, migration/entity/model changes, endpoint, and minimal split-detail action using the existing shared dialog.

**MUTATE / KILL MUTANTS**: Verify that ownership, eligible status, transaction type, split id, and atomic state transition are all asserted; strengthen tests for bypass attempts and duplicate requests.

**REFACTOR**: Keep virtual-party labeling centralized in bank view mapping and keep donation authorization in the backend service rather than trusting the UI.

### Slice 2: Authorized admins can inspect the complete Guild Bank ledger

**Actor**: A user with `bank.view_others`.

**Trigger**: Opens Admin → Bank.

**Observable outcome**: The panel lists all transactions, including donations, with source, destination, amount, type, status, split reference, and dates; table filters/search/sorting work server-side.

**Production path**: Admin route/nav card → permission guard → bank list endpoint with global scope → server-paginated data table.

**RED**: Add endpoint/service coverage for permission scope and global list fields, including a donation row whose destination is Guild Bank.

**GREEN**: Add `/admin/bank`, admin navigation/panel metadata, compatible transaction DTOs, and the focused admin ledger screen.

**MUTATE / KILL MUTANTS**: Verify global scope cannot be reached without `bank.view_others`, filters do not silently fall back, and nullable virtual-bank endpoints render correctly.

**REFACTOR**: Reuse shared table, dialog, stat-card, formatting, and translation conventions without coupling the admin screen to member-only withdrawal actions.

### Slice 3: Admins can understand money flows at a glance

**Actor**: A user with `bank.view_others`.

**Trigger**: Loads or refreshes Admin → Bank.

**Observable outcome**: Summary cards and grouped breakdowns show where money comes from, where it goes, and how it is categorized, with totals consistent with the ledger.

**RED**: Add service tests with mixed split credits, regear credits, payouts, and donations and assert total/count consistency for status/type/source/destination groups.

**GREEN**: Add an admin summary DTO/endpoint and render cards plus compact breakdown tables/charts in the admin bank panel.

**MUTATE / KILL MUTANTS**: Check donated rows are not counted as outstanding or paid-out, withdrawn rows retain payer source, and all grouped totals use decimal-safe backend aggregates.

**REFACTOR**: Centralize aggregation and display-label rules in the bank module so future transaction types appear in the admin report without duplicating ledger logic.

## Risks and mitigations

- **Schema compatibility**: `to_user_id` is currently required; use a forward migration that makes only the destination nullable and keep all existing credit/regear inserts valid.
- **Financial integrity**: perform donation validation and update inside one database transaction with a status predicate; never rely on client-side checks alone.
- **Existing consumers**: update all current `TransactionView` consumers for a virtual Guild Bank destination and preserve normal member rows unchanged.
- **Visibility**: gate both route and endpoint with `bank.view_others`; do not expose global ledger data through the regular member route.

## Success criteria

The member can donate exactly their own split share once with an explicit irreversible confirmation, and an authorized admin can reconcile every ledger row and its aggregate source/destination/status/type totals from the Admin panel.
