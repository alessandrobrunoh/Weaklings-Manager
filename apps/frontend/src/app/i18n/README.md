# Translation dictionaries

## Overview

This directory contains flat translation dictionaries for English, Spanish, French, Italian, and Ukrainian. English is the source dictionary.

## Interface

- Each locale module exports a named dictionary: `en`, `es`, `fr`, `it`, or `uk`.
- The English dictionary defines `TranslationKey` and `TranslationDict`; the other dictionaries are checked against that contract.

## Invariants

The locale objects use the English key set and string values, checked at compile time. Translation modules declare data rather than providing runtime lookup or I/O.

## Side Effects

The dictionary modules export static translation values. Non-English modules import the dictionary type with `import type`, so those imports are compile-time-only.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. Translation key completeness is also enforced by TypeScript compilation.
