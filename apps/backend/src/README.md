# Backend source

## Overview

This directory contains the backend's library and binary entry points, shared runtime files, feature modules, and tenant/control-plane migrations. Detailed shared-runtime behavior remains pending a compliant bounded source review.

## Interface

(Details pending/documentation failed) The shared server/bootstrap symbols, response envelope, and middleware contract need a compliant bounded source review.

### Child directories

- [Event-session workers](event_sessions/README.md)
- [Feature modules and route aggregation](modules/README.md)
- [Tenant migrations](migration/README.md)
- [Control-plane migrations](control_migration/README.md)

## Invariants

(Details pending/documentation failed) Shared tenant isolation, configuration, authorization, and pagination rules need a compliant bounded source review.

## Side Effects

(Details pending/documentation failed) Startup, database migration, worker, HTTP-client, and middleware effects need a compliant bounded source review. See the linked child contracts for their separately documented behavior.

## Verification

From the repository root, run `cargo test -p backend`.
