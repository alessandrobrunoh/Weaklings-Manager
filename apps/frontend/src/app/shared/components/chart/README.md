# Chart components

## Overview

This directory wraps ECharts in an Angular component, provides shared light/dark chart themes, and defines the browser-loaded ECharts runtime.

## Interface

- `Chart` (`app-chart`) accepts an ECharts option and accessible label, plus height, table data, and stale-state inputs; `chartClick` is typed with chart index/value and optional series/name fields.
- `ChartTableRow` describes readonly string rows. `chart-theme.ts` exports palette/chrome types and builders; `echarts-runtime.ts` exports theme names, setup, and initialization functions.

## Invariants

- The component dynamically imports the ECharts runtime during rendering; the source describes server rendering as emitting the container and table twin.
- Runtime registration is guarded by a module-level flag. Theme changes dispose and reinitialize the chart because the theme is selected at initialization.
- The palette assigns colors to semantic entities, so filtering series does not shift colors.

## Side Effects

After rendering, the component initializes a canvas chart, observes host resizing, and disposes the observer and chart on destruction. Chart options can also render as an accessible table.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. `chart.ts` was inspected through the 300-line limit; its final five lines were not reviewed.
