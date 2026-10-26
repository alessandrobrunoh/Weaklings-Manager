# Page header

## Overview

`app-page-header` renders a semantic page heading with optional subtitle and badge, plus projected actions and tabs.

## Interface

- Required `title`; optional `subtitle` and `badge`; `actions` defaults to `true`.
- Action content may be projected through supported button/action selectors. Tab content is projected through `[pageTabs]` or `app-view-toggle`.
- No outputs are declared.

## Invariants

The subtitle, badge, and action wrapper are conditional on their inputs. The tabs wrapper is present but hidden when empty. The header uses a wrapping flex layout.

## Side Effects

The component renders projected content and inline styles; it has no service, network, storage, or output behavior.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
