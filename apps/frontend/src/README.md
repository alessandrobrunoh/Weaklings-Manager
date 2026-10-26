# Frontend source

## Overview

This directory contains browser/server bootstrap entry points, global styles, the Angular application, and the Analog server runtime.

## Interface

- `main.ts` imports the global stylesheet and bootstraps `App` with the client config.
- `main.server.ts` exports `render(url, document)`, which invokes Angular server rendering with the supplied bootstrap context.
- See [app](app/README.md) and [server](server/README.md) for child boundaries.

## Invariants

Both entry points bootstrap the same `App`, using separate browser and server configurations. The global stylesheet was not inspected because it exceeds the 300-line source cap.

## Side Effects

Browser entry starts Angular bootstrap and logs rejected bootstrap promises. Server entry invokes `renderApplication` and returns its promise.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. `test-setup.ts` is test-only and excluded from this source overview.
