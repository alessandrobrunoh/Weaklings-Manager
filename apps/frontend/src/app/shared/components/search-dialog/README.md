# Search dialog

## Overview

`SearchDialog` is a searchable picker built on `app-dialog`, with optional ownership-scope and date filters.

## Interface

- `SearchDialogOption` requires `id` and `title`; `subtitle` and `chip` are optional.
- Inputs include required `title` and `options`, plus placeholder, loading, date-filter, ownership-scope, and scope controls.
- Outputs: `close`, `scopeChange`, `select`, and `filterChange`; filter data contains `search`, `dateFrom`, and `dateTo`.

## Invariants

Search and date fields start empty. Loading takes precedence over empty results; otherwise an empty list shows the empty state and options render as selectable buttons. Optional filters render only when enabled.

## Side Effects

The component schedules focus on the search field after rendering, emits filter/scope/selection/close outputs, and uses `TranslateService` for displayed state text.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
