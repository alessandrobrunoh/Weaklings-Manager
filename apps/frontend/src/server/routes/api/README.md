# API routes

## Overview

This directory contains the catch-all backend API proxy and event-specific routes.

## Interface

- The default catch-all handler proxies the incoming request to `backendTarget()` plus its request URL, with manual redirect handling.
- Event-specific routes are documented in [events](events/README.md).

## Invariants

The catch-all uses `/` when the incoming URL is nullish and delegates forwarding to `proxyRequest`. Its source comment describes forwarding method, headers, body, and response through the proxy.

## Side Effects

The handler forwards requests from the frontend server to the backend, preserving the server-side session-cookie path described in source comments. Event roster routes proxy WebSocket connections.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
