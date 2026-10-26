# Ability bar

## Overview

`AbilityBar` renders the ability slots for one equipped item. It is read-only by default and can expose quick choices and a picker when management is enabled.

## Interface

- Selector: `app-ability-bar`.
- The bounded component/template section shows a slot display and optional picker. Input and output declarations fall beyond the 300-line source limit and are not enumerated here.

## Invariants

- The visible template omits the bar/picker when there are no slots. It distinguishes read-only display from the management picker.

## Side Effects

No event or state effects are asserted from the bounded source excerpt; interaction handlers are beyond the scan limit.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The scout read all 452 lines in error, exceeding the per-file cap; this README is limited to the component/template details visible within the first 300 lines.
