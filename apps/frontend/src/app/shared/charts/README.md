# Guild report chart builders

## Overview

This directory contains pure `EChartsOption` builders for GuildReport time-series charts, returning both chart options and table data.

## Interface

- `ChartBuild` contains `option`, `tableHead`, and `tableRows`.
- `Translate` accepts a translation key and optional string/number parameters.
- Exported builders include `buildCombatTrendsChart`, `buildEconomyFlowChart`, and `buildLossRegearChart`.

## Invariants

- The combat and economy builders preserve input order; combat comments specify oldest week first.
- Invalid week dates display as an em dash; non-finite values format as zero.
- Tooltip header, series names, and values are escaped before inclusion in tooltip HTML.
- Chart options enable ECharts ARIA support.

## Side Effects

The module creates `Intl.NumberFormat` instances and invokes the supplied translation function while building labels. It returns options and table data without rendering or manipulating the DOM.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Only the first 300 lines of the 451-line source were scanned.
