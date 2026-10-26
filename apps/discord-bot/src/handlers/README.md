# Interaction handlers

## Overview

This directory routes Discord button, modal-submit, and string-select interactions to their bot workflows.

## Interface

- `handleButton(interaction, api)` dispatches button custom IDs by namespace, including event, giveaway, navigation, bank, application, and ticket actions.
- `handleModal(interaction, api)` accepts the application modal ID and rejects unknown forms.
- `handleSelectMenu(interaction, api)` handles the `event:join_role` and `event:join_build` menu actions.

## Invariants

- Each handler receives the typed Discord interaction and an `ApiClient`.
- Unknown button, modal, and select IDs receive an ephemeral response rather than being treated as a supported action.
- Ticket and application creation require a guild and usable configured parent channel; newly created Discord resources are cleaned up if backend persistence fails.
- Event signup selections require a registered website account before participation is submitted.

## Side Effects

- Handlers reply to or update Discord interactions and call backend API endpoints.
- Ticket and application flows create private Discord threads and persist their IDs through the API; cleanup may delete a thread when persistence fails.
- Signup flows submit event participation and may refresh the interaction's message. Error and cleanup paths use best-effort Discord updates where noted in the implementation.

## Verification

From the repository root, run `npm test --prefix apps/discord-bot`. This builds the bot and runs its configured test suite.
