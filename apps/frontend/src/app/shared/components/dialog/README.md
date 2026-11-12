# Dialog

## Overview

`Dialog` is a shared modal component built on the native `dialog` element.

## Interface

- Selector: `app-dialog`; `DialogSize` is `sm`, `md`, `lg`, or `xl`.
- Inputs: `open` (default `true`), required `title`, optional `subtitle` and `icon`, and `size` (default `md`).
- `closed` emits on the native close event. Body and `[dialogFooter]` content are projected into separate slots.

## Invariants

- The title receives a per-instance generated ID and labels the dialog; `aria-describedby` is set only when a subtitle exists.
- The open-state effect acts only in a browser after the dialog element exists, and calls `showModal()` or `close()` only when needed.
- Where `closedby` is unavailable, backdrop fallback closes only for clicks outside the dialog rectangle.

- Look: header (icon, 16px title, 13px subtitle, close button), scrolling body, and a footer separated by a hairline; footer buttons right-aligned and wrapping on a phone. Put the primary action last (`btn btn--primary`), the cancel before it (`btn btn--outline`); destructive confirmations use `btn btn--danger`. Motion stops under `prefers-reduced-motion`.

## Side Effects

Opening and closing calls native dialog methods. The close button and native close event emit `closed`; the component uses translation for the close button's accessible label.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
