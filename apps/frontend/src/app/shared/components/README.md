# Shared components

## Overview

This intermediate directory groups reusable presentation components; each child directory owns its own Angular selector and component contract.

## Interface

Child boundaries: [ability bar](ability-bar/README.md), [Albion link gate](albion-link-gate/README.md), [avatar](avatar/README.md), [chart](chart/README.md), [data table](data-table/README.md), [Destiny Board](destiny-board/README.md), [dialog](dialog/README.md), [empty state](empty-state/README.md), [equipment grid](equipment-grid/README.md), [error state](error-state/README.md), [icon](icon/README.md), [loading](loading/README.md), [meter](meter/README.md), [ownership scope toggle](ownership-scope-toggle/README.md), [page header](page-header/README.md), [page stack](page-stack/README.md), [search dialog](search-dialog/README.md), [searchable select](searchable-select/README.md), [stat card](stat-card/README.md), [status chip](status-chip/README.md), [version diff list](version-diff-list/README.md), [version switcher](version-switcher/README.md), [view toggle](view-toggle/README.md), and [Weaklings logo](weaklings-logo/README.md).

## Invariants

No direct source or symbols are defined at this directory level. Component inputs, outputs, accessibility behavior, and rendering rules are owned by the child boundaries.

## Side Effects

This directory contains no direct implementation. Runtime effects, where present, belong to individual components.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
