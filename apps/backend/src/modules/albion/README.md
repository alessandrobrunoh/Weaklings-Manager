# Albion module

## Overview

This directory contains the Albion client, service, router, and link-related module code. Detailed router and service behavior remains pending a compliant bounded review.

## Interface

The bounded client excerpt exposes search, player, guild, guild-member, and alliance calls. The entity excerpt defines `albion_link::Model` with Discord ID, Albion player ID/name, and link timestamp.

(Details pending/documentation failed) HTTP route mappings, authorization, and service behavior need a compliant bounded review.

## Invariants

- The bounded entity excerpt marks both Discord ID and Albion player ID unique.
- (Details pending/documentation failed) Link validation, roster selection, and role-assignment rules require a compliant bounded service/router review.

## Side Effects

The bounded client excerpt makes HTTP requests to the regional Albion game-data service with a 30-second timeout.

(Details pending/documentation failed) Database, Discord, and alliance-fanout effects require a compliant bounded service/router review.

## Verification

From the repository root, run `cargo test -p backend`.
