# Data table

## Overview

`DataTable<T>` is a reusable Angular table with loading, error, empty, search, filter, sort, and pagination states. It supports projected action content and custom cell templates.

## Interface

- Required inputs: `columns`, `rows`, and `trackBy`. Optional inputs configure query synchronization, paging, server mode, search/filter state, loading/errors, and control visibility.
- `pageChange` emits page, size, search, sort, and column-filter state; `rowClick` emits row selections.
- `DataTableColumn<T>` describes column access, sorting, searching, filtering, and alignment. `dataTableCell` associates projected templates with column keys.
- `data-table-query.ts` exports query parsing/serialization helpers and query-key constants.

## Invariants

- Rows are tracked by the required `trackBy` input. Client-mode rows are filtered, sorted, then paginated; server mode uses `totalItems`.
- The default page size is 10. Query parsing accepts positive integer page/size values and encodes descending sort keys with a leading `-`.
- Reserved query keys are namespaced for column filters; an optional prefix namespaces all query keys.

## Side Effects

When route synchronization is enabled, the component reads query parameters and emits `pageChange` when resolved query state changes. It clears its search timer on destruction.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan of `data-table.ts` exceeded the per-file cap; findings are limited to its first 300 lines.
