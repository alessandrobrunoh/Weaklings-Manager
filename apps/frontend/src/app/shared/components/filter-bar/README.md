# Filter bar

## Overview

`app-filter-bar` is the one filter bar of the product, generalized from the comps list filter bar (which is now a thin wrapper around it: `features/comps/list-filter-bar.ts`). A labelled search box and an always-visible primary slot sit on one row; the facets live in a panel that is inline on a wide screen and behind a "Filters (n)" button on a phone.

## Interface

- Selector `app-filter-bar`. Inputs: required `searchLabel` (accessible name of the search box and the `role="search"` region), `searchPlaceholder`, `query`, `activeCount` (facets in force, for the phone badge and the clear button).
- Outputs: `queryChange: string` (also `''` from the inline clear-search button) and `clear: void` (drop every filter; the page resets its own state).
- Slots: `[filterPrimary]` for one or two always-visible controls next to the search (Mine/Everyone, a segmented status switch); default content for the facets. Wrap a select as `<label class="filter-field"><span class="filter-field__label">Role</span><select class="select select--sm">` and a checkbox as `<label class="filter-check">`; both classes are global.

## Invariants

- The bar holds no filter state; pages own it. The clear button renders only when `activeCount > 0`.
- At 40rem and below the facet panel is collapsed behind a toggle with `aria-expanded` and `aria-controls`; above that the facets render inline and the toggle is hidden.
- All strings come from `ui.filters.*` i18n keys; labels of facets are the caller's.

## Side Effects

None. No network or storage access.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
