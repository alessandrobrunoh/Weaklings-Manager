# Albion data services

## Overview

This directory contains root-provided services that load OpenAlbion ability and item catalog data through `ApiService`.

## Interface

- `AlbionAbilitiesService.load()` returns a readonly record of ability metadata.
- `AlbionCatalogService.load()` returns a readonly item catalog.

## Invariants

- Both services start with empty data and `loaded === false`.
- Concurrent loads share the pending promise; successful loads are cached, including an empty response.
- Failed loads clear the pending promise and may be retried.
- Catalog names are normalized only when the item has a truthy identifier.

## Side Effects

First load attempts call `api/openalbion/abilities` or `api/openalbion/catalog` and convert the observable with `firstValueFrom`. Catalog items may be passed through the equipment-name normalizer.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
