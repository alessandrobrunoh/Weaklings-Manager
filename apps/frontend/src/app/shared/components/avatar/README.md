# Avatar

## Overview

`Avatar` displays a resolved avatar image or falls back to initials.

## Interface

- Selector: `app-avatar`.
- Inputs: `userId`, `avatar`, `username`, `size`, and `shape`. Size presets are `xs`, `sm`, `md`, `lg`, and `xl`; shape is `circle` or `rounded`.
- The component declares no outputs and injects no services.

## Invariants

- Avatar hashes are resolved against the Discord CDN when a valid user ID is present; animated hashes use GIF and other hashes use WebP.
- If an image URL is absent or has failed, initials are shown. Blank usernames yield `?` and the accessible label `User`.
- Custom dimensions matching the component's accepted length pattern set inline width and height.

## Side Effects

An image error updates local failed-URL state. Rendering a resolved image can request an external image; images are lazy-loaded.

## Verification

Run `npm test --prefix apps/frontend` from the repository root.
