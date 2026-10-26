# Health module

## Overview

The health module returns a fixed status and configured application version; it does not perform a dependency/readiness check.

## Interface

`router()` registers module-local `GET /`, returning JSON `HealthResponse` with `status` and `version`. `HealthService::check` sets the status to `"OK"` and reads `config::VERSION`.

## Invariants

The response has only the two `HealthResponse` fields. `HealthService` is stateless.

## Side Effects

The handler constructs the stateless service and returns its response. The module performs no storage, network calls, logging, or mutations.

## Verification

From the repository root, run `cargo test -p backend`.
