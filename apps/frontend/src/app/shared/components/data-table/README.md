# Data table

## Overview

`DataTable<T>` is a reusable Angular table with loading, error, empty, search, filter, sort, and pagination states. It supports projected action content and custom cell templates.

## Interface

- Required inputs: `columns`, `rows`, and `trackBy`. Optional inputs configure query synchronization, paging, server mode, search/filter state, loading/errors, and control visibility.
- Layout inputs: `bordered` (frame; leave off inside a `.card`), `stickyFirstColumn` (pins the first column while the table scrolls sideways), `mobileLayout: 'scroll' | 'stack'` (default `scroll`; `stack` renders each row as a labelled block below 40rem), `maxHeight` (CSS length; scrolls rows under a sticky header), `ariaLabel` (name of the scroll region), `footerLabel`.
- Totals row: register cells with `<ng-template dataTableFooterCell="key">` (`DataTableFooterCell`); the first column falls back to `footerLabel` or "Total". The table only sees one page, so the host computes totals.
- `pageChange` emits page, size, search, sort, and column-filter state; `rowClick` emits row selections.
- `DataTableColumn<T>` describes column access, sorting, searching, filtering, and alignment. `dataTableCell` associates projected templates with column keys.
- `data-table-query.ts` exports query parsing/serialization helpers and query-key constants.

## Invariants

- One density shared with the global `.table`: 12px/600 sentence-case headers on a muted band, 13px cells, hairline rows, tabular numerals; `align: 'right'` columns right-align header and cell. Sortable headers are buttons inside `th` with `aria-sort`; the active column shows a chevron.
- All visible strings are i18n (`ui.table.*`, `common.*`): range text, page size labels, page buttons (`aria-current="page"`), empty hint. The page buttons render only when there is more than one page. Loading shows a table skeleton and errors the shared error state; an empty result uses the compact empty state.

- Rows are tracked by the required `trackBy` input. Client-mode rows are filtered, sorted, then paginated; server mode uses `totalItems`.
- The default page size is 10. Query parsing accepts positive integer page/size values and encodes descending sort keys with a leading `-`.
- Reserved query keys are namespaced for column filters; an optional prefix namespaces all query keys.

## Side Effects

When route synchronization is enabled, the component reads query parameters and emits `pageChange` when resolved query state changes. It clears its search timer on destruction.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scan of `data-table.ts` exceeded the per-file cap; findings are limited to its first 300 lines.
