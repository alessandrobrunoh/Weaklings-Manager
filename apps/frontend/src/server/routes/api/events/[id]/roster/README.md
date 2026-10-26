# Live event roster endpoint

## Overview

`live.ts` configures a WebSocket proxy for an event's live roster.

## Interface

The default export wraps `proxyHooks` in an H3 `defineWebSocketHandler`. Its upstream URL uses `backendTarget()` plus the incoming pathname and query string.

## Invariants

- `https:` is converted to `wss:`; other protocols are converted to `ws:`.
- The proxy header callback supplies only `cookie` and `origin`, using empty strings when incoming values are absent.

## Side Effects

Registering the handler configures a WebSocket proxy that upgrades and forwards the roster connection. No REST or persistence behavior is defined in this source.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
