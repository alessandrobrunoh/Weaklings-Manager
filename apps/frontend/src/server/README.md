# Frontend server runtime

## Overview

This directory contains backend-target/environment helpers, client-disconnect classification, a Nitro disconnect plugin, and server gateway routes.

## Interface

- `clientDisconnectCode(reason)` returns a recognized disconnect code or `null`.
- `backendTarget()` resolves a backend URL or throws in production when `API_REWRITE_URL` is missing.
- `plugins` registers process-level handling; route handlers proxy API, Scalar, and event roster traffic.
- See [plugins](plugins/README.md) and [routes](routes/README.md) for child boundaries.

## Invariants

- Disconnect classification accepts only the four configured string codes.
- A truthy `API_REWRITE_URL` takes precedence and has one trailing slash removed; otherwise production requires it and non-production defaults to `BACKEND_PORT` or 3000.
- Root `.env` loading is guarded by a module-local once flag.

## Side Effects

Environment loading may call `process.loadEnvFile`; the plugin registers `unhandledRejection`; route handlers forward HTTP or WebSocket traffic to the backend.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
