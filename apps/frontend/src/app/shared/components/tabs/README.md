# Tabs

## Overview

`app-tabs` is the one tab bar of the product. It replaces the old `app-view-toggle` and every hand-rolled button row that switched sections of a page. Use it for in-page sections, for routed sub-pages and (as `segmented`) for small inline switches such as Mine / Everyone or 7 / 30 / 90 days.

## Interface

- Selector `app-tabs`. Inputs: required `options: readonly TabOption[]`, required `active: string`; optional `ariaLabel` (name of the tab list or nav), `variant: 'underline' | 'segmented'` (default `underline`), `panelIdPrefix` (opt-in `aria-controls`, only when the panels really have those ids).
- `TabOption`: `{ id, label, icon?, count?, disabled?, link?, queryParams? }`. Labels are already translated. `count` renders a small figure after the label (hidden for null, undefined and empty string).
- Output `activeChange: string` with the chosen id (click or keyboard). The host owns the state and passes it back as `active`.
- Project it into `app-page-header` with the `pageTabs` attribute or as a direct `app-tabs` child; the header places it under the title.

## Invariants

- In-page mode (default) is an ARIA tablist: `role="tablist"` of `role="tab"` buttons with `aria-selected`, roving `tabindex` (only the active tab, or the first enabled one, is a Tab stop). Left/Right wrap, Home/End jump, and focus moves with activation. Disabled tabs are skipped by the keyboard and never emit.
- Routed mode is chosen automatically when every option has a `link`: a `<nav>` of anchors using `routerLink` (and `queryParams`), the active one with `aria-current="page"`. There is no tablist role there because the destinations are pages, not panels. `activeChange` still fires on click for side effects; the host derives `active` from the URL.
- The bar scrolls horizontally inside itself (no page-level horizontal scroll) and scrolls the active tab into view. Touch devices get 40px targets.
- The look is token driven: 13px text, 2px primary underline for the active tab (or a raised segment in `segmented`), the shared focus ring, no motion under `prefers-reduced-motion`.

## Side Effects

Scrolls the active tab into view after render in the browser only. No network or storage access.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
