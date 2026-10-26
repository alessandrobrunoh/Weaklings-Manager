# API base token

## Overview

This directory provides dependency-injection tokens shared by the frontend's core services.

## Interface

- `API_BASE_URL` is a root-provided Angular `InjectionToken<string>` for the backend API base URL.
- Its factory reads `window.__API_BASE__` when available and otherwise returns an empty string.

## Invariants

The factory always returns a string. A configured string is returned unchanged, including an empty string; no trimming or URL validation is performed here.

## Side Effects

Resolving the token in a browser reads `window.__API_BASE__`. It does not mutate the global or perform I/O.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
