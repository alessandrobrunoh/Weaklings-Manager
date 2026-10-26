# Dashboard

## Overview

The dashboard is described as a personal command center for identity, bank status, season progress, pending actions, and the next mass/event. Guild-wide finance and officer queues belong elsewhere.

## Interface

This directory contains the dashboard page entry point. Its exact component and service contract is not enumerated here because the scan exceeded the per-file read cap.

## Invariants

The documented page boundary is personal/member-focused; guild-wide finance and officer queues are outside this page's stated responsibility.

## Side Effects

Not established by a compliant bounded scan. The implementation's side effects are intentionally not inferred here.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. **Scan failure:** the scout read all 813 lines of `dashboard.ts`, exceeding the 300-line cap; the page contract and effects need a compliant re-scan before being treated as complete.
