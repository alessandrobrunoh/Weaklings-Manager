# VODs module

## Overview

This module accepts VOD review claims and lists the current caller's claims.

## Interface

`router()` provides local `POST /` and `GET /me` operations (documented in OpenAPI as `POST /api/vods` and `GET /api/vods/me`). Both require `Permission::VodSubmit`.

- Submission accepts `SubmitVodRequest` and returns a `VodReviewView`.
- Listing returns the caller's claims, newest first.
- The persisted entity maps to `vod_reviews`; the module's router mount point is owned elsewhere.
- (Details pending/documentation failed) Other route-mount and service behavior beyond the bounded excerpt requires review.

## Invariants

- Submission requires a configured, non-empty VOD forum channel. The request channel must match it after trimming, and the thread owner ID must match the claimer ID supplied by the route.
- A covering season is required. Before insertion, the service checks for an existing claim with the same season and normalized URL and returns a conflict if found.
- URL normalization trims input, accepts only `http` or `https`, lowercases the scheme and host portion, and removes trailing slashes from the remainder.
- The duplicate check is read-then-insert without an explicit transaction here; this module does not establish a database uniqueness guarantee.
- (Details pending/documentation failed) Any database-level uniqueness guarantee and service behavior beyond the inspected excerpt require review.

## Side Effects

A successful submission inserts a `vod_reviews` row and requests an XP award with `XpSource::Vod` and idempotency key `vod:{normalized_url}`. Award failures are logged but do not fail the claim response. Listing reads rows filtered by caller user ID.

(Details pending/documentation failed) Service side effects outside the bounded excerpt require review.

## Verification

From the repository root, run `cargo test -p backend`.
