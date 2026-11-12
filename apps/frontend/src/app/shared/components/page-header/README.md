# Page header

## Overview

`app-page-header` is the header of list, hub and form pages: title, optional badge and subtitle, a back link or breadcrumb trail, one primary action, an overflow menu and an optional tab bar. Detail pages of one record use `app-entity-header`.

## Interface

- Required `title`; optional `subtitle`, `badge`; `actions` defaults to `true`.
- `backLink` (router commands) with `backLabel` (translated text, defaults to "Back") renders a single back link; `breadcrumbs: readonly PageCrumb[]` (`{ label, link? }`, last = current page) renders a trail and wins over `backLink`.
- `menuItems: readonly MenuItem[]` with `menuLabel` renders the shared [`app-menu`](../menu/README.md) after the projected actions; `menuSelect` emits the chosen id.
- Slots: actions are any `button`, `a`, `[pageActions]` or `[headerActions]` child (project the one primary action and at most one secondary; the rest goes in `menuItems`); tabs are `app-tabs` or any `[pageTabs]` element.

## Invariants

The subtitle, badge, back/breadcrumb row, action wrapper and menu are conditional. The tabs wrapper is present but hidden when empty. The title is the page `h1` using the global `.page-title` class. The row wraps rather than switching on a viewport breakpoint.

## Side Effects

None. The breadcrumb label, back text and menu label default to i18n keys `ui.breadcrumb.label`, `ui.pageHeader.back`, `ui.menu.moreActions`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
