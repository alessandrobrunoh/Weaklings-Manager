# Summary band

## Overview

`app-summary-band` with `app-stat` is the compact replacement for rows of big KPI cards: 3-6 key figures in one hairline-divided strip, label above, value, optional hint. `app-stat-card` keeps working but new and migrated pages use the band.

## Interface

- `app-stat`: required `label` and `value` (`string | number | null`, null shows an em dash); optional `hint` (unit, period or the state in words), `tone: 'default' | 'success' | 'warning' | 'danger' | 'primary'`, `delta` and `deltaDirection: 'up' | 'down' | 'neutral'`. Exposes `data-tone` on the host.
- `app-summary-band`: optional `ariaLabel` (names the `role="group"`) and `items: readonly SummaryItem[]` (`{ label, value, hint?, tone? }`) for the plain case. Project `app-stat` children for anything richer; `items` render first.

## Invariants

- Colour is state only and never alone: a toned value must carry the state in its label or hint, and a delta shows an arrow glyph with its figure.
- The band is one bordered surface with `--radius-smallcards`; cells wrap with `repeat(auto-fit, minmax(9.5rem, 1fr))`, so there is no horizontal scroll at 390px and a hairline always separates cells.
- Values use tabular numerals; label and hint are 12px and truncate with an ellipsis instead of wrapping.

## Side Effects

None.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
