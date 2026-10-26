# Core frontend infrastructure

## Overview

This directory groups route access control, API contract types, singleton services, and dependency-injection tokens.

## Interface

- [Guards](guards/README.md) define authentication, tenant, permission, guild-only, and platform route access.
- [Models](models/README.md) describe API payload and request types.
- [Services](services/README.md) centralize transport, auth, domain, realtime, and presentation state.
- [Tokens](tokens/README.md) expose shared injection configuration.

## Invariants

This directory is an aggregation boundary; each linked child owns its specific contracts and rules. Types in `models` are compile-time contracts, while services and guards provide runtime behavior.

## Side Effects

There are no direct implementation files at this directory level. Runtime effects belong to the service and guard children.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
