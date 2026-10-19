# Plan: Repair event calendars and enforce event management

**Status**: Slices 1 and 2 implemented; targeted checks passed; Slice 3 planned
**Scope**: Discord event calendars, event ownership, website permission enforcement, and actionable Discord errors

## Goal

Keep the persistent **Content Pings** calendar accurate in both the events and Call to Arms channels; provide a permission-checked Discord command to refresh it on demand; allow an event creator to manage their own event while requiring the appropriate existing permission to manage someone else’s; and replace vague Discord action failures with actionable, accurate responses.

The website’s existing role-permission system remains the source of authority. Event ownership is a narrow exception for actions on the caller’s own event, not a general ability to edit other website resources.

## Acceptance criteria

### Calendar and manual refresh

- Every non-archived event that is live or scheduled to start in the future appears in the correct calendar: standard events in the events channel, Call to Arms events in the CTA channel.
- Events are not silently omitted because stopped/cancelled/history rows filled the first 50 results or because the renderer truncated a list at 25.
- Calendar output uses as many bounded Components V2 messages as necessary without exceeding Discord’s message-wide text limit or dropping event entries.
- `/event-calendar-refresh` refreshes both configured calendars immediately, editing their existing messages or creating one if it is missing. It does not rewind event-announcement checkpoints or repost event threads.
- The command is authorized through the backend with the existing `events.edit` permission; no user-triggered bot-system credential bypass is introduced.
- If no relevant channel is configured or the bot cannot access one, the command reports that specific problem instead of claiming success.

### Event ownership and site-wide permissions

- A caller can perform event-specific management actions on an event they created.
- A caller can manage another member’s event only when they hold the matching existing permission (`events.edit` for management/edit actions and `events.delete` for archive/delete actions).
- Event creation continues to require `events.create`; owning one event never grants rights over another event or unrelated resources.
- The website shows event actions to the creator or a caller with the corresponding permission, while backend authorization remains authoritative.
- Discord event buttons may remain visible to all members because Discord components are shared per message; an unauthorized click must receive a clear ephemeral denial and must not change event or Discord state.
- Existing permissions for other domains remain enforced. In particular, split edits require `splits.edit` and bank transaction edits require `bank.transactions.edit`; participant self-service and other explicitly self-service flows are not accidentally restricted.

### Discord error messages

- A missing website account is distinguished from an unregistered Discord server, a missing Albion character link, a permission denial, and a backend/Discord outage.
- For a missing website account, the person sees: **“Yo you are not registered on the website. Click here to open the website and register.”** The response includes a link to the website login/registration flow using the same Discord account.
- Known validation, permission, missing-resource, conflict, and upstream errors include an accurate explanation and next step. Internal server details and credentials are not exposed.
- Ticket/application flows that intentionally accept people without website accounts continue to work.

## Baseline findings before Slice 1

- The Discord calendar is a persistent Components V2 message updated by `Poller.updateEventCalendars` in `apps/discord-bot/src/services/poller.ts`; it is not created by a Discord `Message.pin()` call.
- `updateEventCalendars` currently requests only page 1 with `limit: 50`, without status or future-date filters. It then groups events by channel. The renderer filters for scheduled/live events and limits output to 25 in `apps/discord-bot/src/embeds/event.embed.ts`. Old terminal events can consume API slots before filtering, and valid events can be omitted by either limit.
- The scheduled poller uses a bot-system API context. Human-triggered event actions pass the caller’s Discord ID and Discord member role IDs to the backend.
- Backend Ping, start, stop, cancel, reopen, edit, and archive routes already check `events.edit` or `events.delete`. Discord’s shared buttons are status-based, not per-viewer, so they are visible even to members whose requests the backend rejects.
- The backend already allowed the event creator or an `events.edit` holder to modify participant assignments and roster seats. Other event mutation endpoints required the permission without an owner exception.
- The event entity has `created_by`; event detail returns that user ID. The frontend initially showed most management controls based on permissions alone, but used creator-or-permission for roster participation controls.
- Existing bank transaction edit and split edit routes check their specific backend permissions. The bot’s linked-user lookup returns a 401 when a Discord ID has no website user row; the top-level Discord interaction handlers currently display `ApiError.message` or a generic fallback.
- Website-account registration, tenant registration, and Albion-character linking are separate states. Do not treat one as another.
- The poller creates private event threads without adding ordinary members. Whether event threads should be public or have an explicit membership policy is a related visibility question; this plan does not silently change it.

## Design decisions

1. Add a backend calendar-feed endpoint for the bot. It returns all non-archived live and future-scheduled event summaries, and requires `events.edit` for human requests. The poller’s trusted system request continues to work through the existing bot-system context. This avoids page-number races, arbitrary API page limits, and a separate unverified permission check in Discord code.
2. Use the same calendar-feed and renderer for the background poll and `/event-calendar-refresh`. The command updates only the persistent summary messages; it does not replay event announcements, create duplicate threads, or mutate an event’s lifecycle.
3. Render every returned event across as many Components V2 message pages as required. Each page stays below Discord’s combined Text Display character limit; saved page IDs are migrated from the former single-message state.
4. Extend the existing creator-or-permission policy to all event-specific mutations, using the permission appropriate to each operation. Owners do not gain access to global settings or unrelated resources.
5. Keep authorization in the backend. Frontend hiding and Discord button presentation are usability aids only.
6. Use a stable problem type/code for “website account not registered” so Discord error formatting does not classify every 401 as the same problem. Keep internal failures useful to operators but sanitized for Discord users.
7. Keep event authorization parity by resolving the Discord interaction’s role snowflakes through the tenant’s current role mapping. Cookie users can carry several mapped role names; older bot builds without the role-ID header retain the persisted single-role fallback.

## Reviewable slices

### Slice 1 — Restore and refresh Content Pings calendars

**Outcome**: all live and upcoming events appear in the correct persistent calendar, and an authorized user can trigger an immediate refresh.

**Scope**:

- Add `GET /api/events/calendar`, protected by `events.edit` for user-context requests, returning all non-archived live events and future scheduled events.
- Refactor the bot poller to use the calendar feed for scheduled updates and for a new `/event-calendar-refresh` command.
- Render all returned events across Discord-safe Components V2 message pages. Preserve standard/CTA routing, migrate old single-message IDs, edit saved pages, and remove obsolete pages.
- Add bot command registration, explicit success/failure copy, and regression tests for more than 50 source events, more than 25 rendered events, filtering, routing, and edit-versus-create behavior.

**Verification**: targeted backend calendar-feed tests; `cd apps/discord-bot && npm test`; inspect the final diff and run `git status`.

**Risk / review boundary**: the calendar is an external Discord message. The command must not reset announcement cursors or replay event announcements. Stop after this slice is verified and ready for review.

**Result — Ready for review**:

- Added `GET /api/events/calendar`, which filters in the database to live/future-scheduled non-archived events and requires `events.edit` for user requests.
- The poller and `/event-calendar-refresh` now share that feed. A refresh edits saved calendar messages or creates a replacement when Discord reports the old message is missing; normal and CTA events stay in their configured channels.
- Calendar output includes every returned event across message pages, each below the message-wide text cap. The poller stores and updates each page, migrates the old single-message state, and removes obsolete pages.
- `/event-calendar-refresh` and scheduled updates now serialize their calendar writes, avoiding duplicate replacement messages when they overlap. Missing channels and Discord permission failures remain explicit.
- Checks passed: `cargo test -p backend calendar_feed` (2 tests, before Slice 2); `cd apps/discord-bot && npm test` (113 tests).
- No live Discord refresh was run. Slice 2 extends event ownership and site-wide permission enforcement; Slice 3 (specific safe Discord errors) remains planned.

### Slice 2 — Enforce creator-or-permission event management

**Outcome**: only the event owner or a caller holding the matching permission can mutate an event, through either the website or Discord.

**Scope**:

- Generalize the existing owner-or-`events.edit` helper and apply it to all event-specific management mutations.
- Use `events.delete` for non-owner archive/delete operations; allow the owner to archive their own event.
- Update website event-list/detail controls to reflect the same owner-or-permission policy.
- Audit mutation routes across the site for backend permission enforcement; preserve existing domain permissions and intentional self-service operations.
- Add authorization tests covering owner, permitted non-owner, unpermitted non-owner, delete-vs-edit grants, and caller identity through bot headers and session context. Resolve or document any cookie/bot role-resolution mismatch before calling parity complete.

**Verification**: backend event/router tests, relevant frontend event specs, bot action tests, permission audit, and applicable workspace checks.

**Risk / review boundary**: account for separate `events.edit` and `events.delete` grants. Do not convert a UI-only guard into the security boundary.

**Result — Verified for review**:

- A shared backend authorization helper now allows the creator to manage their own event and requires the action’s matching permission for other events. This covers event details, roster roles/seats, participant assignments, reminders, voice-channel bindings, lifecycle actions, linked battles, and archive/delete/restore. Creation remains `events.create`; self-join/leave remains self-service.
- The event list/detail pages show management controls to creators or users with the matching grant. Archived-event navigation is available so a creator can restore an event they archived; their row controls still require ownership or `events.delete` for anyone else’s event.
- The Discord bot now includes trusted member role snowflakes on actor-authenticated requests, and backend `UserContext` maps them through the current tenant’s role mapping. It preserves the older single-role fallback if the header is absent and leaves `bot_system` requests and `BotDiscordUser` ticket/application behavior unchanged.
- Legacy `events.manage` grants still satisfy the granular event permissions, avoiding a silent downgrade for roles created before the permission split.
- Listing selectable Discord roles for the create form now requires `events.create`, matching the action that uses those options.
- The site-wide mutation audit found the other domains continue to use their own permissions (including `splits.edit` and `bank.transactions.edit`); no cross-domain creator bypass was introduced.
- Checks passed: `cd apps/discord-bot && npm test` (113 tests); `cd apps/frontend && npm test -- src/app/features/events/events.spec.ts src/app/features/events/event-detail.spec.ts` (19 tests).
- Backend tests passed: `cargo test -p backend event_management_allows_owners_and_requires_matching_permission_for_other_events` (1); `cargo test -p backend calendar_feed` (2); `cargo test -p backend legacy_events_manage_grant_covers_granular_event_permissions` (1); `cargo test -p backend parses_and_deduplicates_bot_role_id_header` (1); and `cargo test -p backend rbac::tests` (6, including malformed role-header rejection).
- `rustfmt --edition 2024 --check` passed for the changed backend Rust files. The CRLF-aware check `git -c core.whitespace=cr-at-eol diff --check` passed; plain `git diff --check` treats the repository’s CRLF line endings as trailing whitespace.
- The full `cargo test -p backend` run timed out after 15 minutes and reported `a_build_detail_lists_every_version_in_its_group` failing in the unmodified `apps/backend/src/modules/comps/service.rs`; an isolated rerun reproduced the version-list assertion mismatch. This test failure is a landing blocker until it is addressed or confirmed as an accepted baseline.
- The full frontend `npm test` could not start because `vitest` was unavailable after the user’s dependency cleanup. The targeted event specs passed earlier (19 tests). The frontend build timed out during Vite’s client/SSR transform without reporting a build error.
- No live Discord refresh or remote CI run was performed.

### Slice 3 — Give Discord users specific, safe action errors

**Outcome**: missing site accounts get the requested registration link; permission, validation, state, and service failures say what failed and what to do next.

**Scope**:

- Add a typed backend problem for an unregistered website account, without including the user’s Discord snowflake.
- Add a shared Discord interaction error formatter for slash commands, buttons, selects, and modals; distinguish the typed account problem, forbidden, validation, not-found, conflict, upstream, and internal errors.
- Use status-specific safe guidance for 5xx and Discord permission/configuration failures; retain diagnostic detail in logs.
- Fix bot lookup paths that currently collapse failed account/network checks into “no Albion character” or “account not found”, including `/me`, `/register`, and target-user resolution where feasible.
- Preserve unregistered-tenant onboarding and website-independent application/ticket flows.

**Verification**: formatter table tests, linked-account and Albion-link tests, slash/button/modal/select response tests, and `cd apps/discord-bot && npm test`.

**Risk / review boundary**: only map the explicit website-account problem to the registration link; do not treat every 401 or network failure as an unregistered account.

## Open follow-up

The calendar links to private Discord threads, but the current thread path does not add ordinary members. Confirm whether the intended policy is public event threads or private threads with an explicit member-invite flow before changing thread visibility.
