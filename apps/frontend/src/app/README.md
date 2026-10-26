# Angular application

## Overview

This directory contains the root `app-root` component, router configuration, client/server provider configuration, and the app's core, feature, layout, shared, and translation modules.

## Interface

- `App` (`app-root`) renders a `RouterOutlet`.
- `app.config.ts` exports the client `ApplicationConfig`, registering routes, HTTP, hydration, browser error listeners, and router transitions.
- `app.config.server.ts` merges server-rendering providers with client configuration.
- `app.routes.ts` is the route-table source; the 395-line file was not inspected, so route mappings and lazy-load behavior are not documented here.
- Child boundaries: [core](core/README.md), [features](features/README.md), [i18n](i18n/README.md), [layout](layout/README.md), and [shared](shared/README.md).

## Invariants

- The root component calls `AuthService.load()` only in the browser, avoiding a session probe during SSR.
- Router configuration enables component input binding and view transitions.
- App configuration separates browser bootstrap providers from server-rendering providers.

## Side Effects

Browser startup begins the auth session load and injects branding behavior. Provider setup configures the fetch-based HTTP client and interceptors, hydration with event replay, browser global error listeners, and router transitions.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
