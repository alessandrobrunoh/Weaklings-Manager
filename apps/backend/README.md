# Backend service

## Overview

The `backend` Rust package builds the Axum service and exposes a library plus server binary. Runtime composition and tenant boundaries are documented in [the source overview](src/README.md).

## Interface

The container image uses the release executable at `/app/backend` and declares port `3000` as image metadata. The package manifest enables the dependencies used by the service; available dependency features do not by themselves define runtime endpoints.

## Invariants

- Cargo package name is `backend`, version `0.0.3`, edition 2024.
- The manifest forbids unsafe code and denies Clippy's `all` lint group; the image build requests a release build of package `backend`.
- Docker `EXPOSE 3000` is metadata; it does not publish a host port or prove the application binds that port.

## Side Effects

The Dockerfile builds the package in a Rust 1.88 builder stage and copies `target/release/backend` into a Distroless Debian 12 runtime image. It declares Cargo registry and target cache mounts; it does not declare a health check or runtime environment variables.

## Verification

From the repository root, run `cargo test -p backend`.
