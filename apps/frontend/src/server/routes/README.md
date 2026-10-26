# Server routes

## Overview

This directory contains server-side gateway routes for the backend API and OpenAPI documentation UI.

## Interface

- `scalar.ts` default-exports an H3 handler that proxies requests to the backend Scalar route.
- API gateway routes are documented in [api](api/README.md).

## Invariants

The Scalar handler forwards the incoming URL, falls back to `/scalar` for a nullish URL, and uses manual redirect handling.

## Side Effects

Route handlers call `proxyRequest` to forward requests; the API subroutes also proxy event roster WebSocket traffic.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
