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
- The thread is verified with the bot token (`GET /channels/{id}`), never trusted from the body: it must be a public thread whose `guild_id` is the current tenant (the tenant id is the Discord guild id), whose `parent_id` is the configured forum and whose `owner_id` is the claimer. Thread/message ids must be digits only. With no bot token the claim fails closed (`502`).
- The normalized URL (fragment dropped) must be on `VOD_HOST_ALLOWLIST` (the host or a subdomain; userinfo, backslashes and other host tricks are refused).
- A member can make at most `DAILY_VOD_CAP` claims per rolling 24 hours (`429`). The cap is checked before the Discord call and again after the insert (counting only rows up to the new one) so concurrent requests cannot all slip past it; an over-cap row is deleted.
- A covering season is required. Before insertion, the service checks for an existing claim with the same season and normalized URL and returns a conflict if found.
- URL normalization trims input, accepts only `http` or `https`, lowercases the scheme and host portion, and removes trailing slashes from the remainder.
- The duplicate check is read-then-insert without an explicit transaction here; this module does not establish a database uniqueness guarantee.
- (Details pending/documentation failed) Any database-level uniqueness guarantee and service behavior beyond the inspected excerpt require review.

## Side Effects

A successful submission inserts a `vod_reviews` row and requests an XP award with `XpSource::Vod` and idempotency key `vod:{normalized_url}`. Award failures are logged but do not fail the claim response. Listing reads rows filtered by caller user ID.

(Details pending/documentation failed) Service side effects outside the bounded excerpt require review.

## Verification

From the repository root, run `cargo test -p backend`.
