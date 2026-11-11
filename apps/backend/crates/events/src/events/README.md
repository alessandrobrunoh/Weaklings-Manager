# Events module

## Overview

- This directory contains the events module's router, service, data models, sync, roster-hub, and fight-grouping code.
- Events carry an `event_kind` discriminant: `organized` (default; full comp/roster/split machinery, `comp_id` required) or `flash` (binary participation, no comp, `comp_id` NULL). Flash is never inferred from a NULL comp — `event::Model::is_flash()` / `organized_comp_id()` are the only guards; comp-shaped routes (roster, signup-options, splits, regear) return `409 Conflict` for flash rather than degrading.

## Interface

OpenAPI documents routes under `/api/events`. The surface includes:

- Event list/create/detail/update/delete, calendar, revisions, archive/unarchive, Discord-role listing, and alliance fanout status.
- New events default to requesting a VOD forum post. The migration leaves existing events `not_requested`; bot delivery uses an atomic pending → attempted claim before Discord creation, and `attempted` is not automatically retried because a lost Discord response can mean the post already exists.
- To reconcile an `attempted` VOD delivery, stop **all** bot workers for the tenant and inspect the configured Discord forum, including archived posts. If the post exists, call the bot-authenticated `POST /api/events/{id}/vod-forum-post/created` with `{"thread_id":"<existing Discord thread ID>"}`. If it does not exist, call the bot-authenticated `POST /api/events/{id}/vod-forum-post/retry-after-verification` with `{"confirm_no_post":true}` and then restart the workers. Never requeue while a worker may still be creating the post: this can produce a duplicate. Provide `X-Bot-Secret` through the operator's secure environment, not a committed file. A cancelled or archived event cannot be requeued.
- Signup options, roster reads/suggestions/live stream, seat assignment/clearing, swaps, autofill, roster-role management, and party management (add, rename/change comp, remove, reorder).
- Participation and participant management.
- Remind/start/cancel/uncancel/stop lifecycle operations, and voice-channel configuration.
- Event XP is recorded only at successful completion: creator XP goes to the original creator and participation XP uses the participant list snapshotted at stop. Cancelled events and users removed before the snapshot do not receive these awards; alliance mirror events are not award authorities.
- Completion awards pin the active season satisfying `starts_at <= completion_time < ends_at` and capture configured rates at stop. Pending awards are retried from the durable tenant-local outbox; existing ledger history is preserved and historical events are not backfilled.
- Event battle list and replacement. `GET /api/events/{id}` and the battle list degrade to a read without battle classification or fight grouping when the tenant has no Albion guild configured, instead of failing.
- Automatic battle linking (`EventService::link_battles_for_event`, driven by the event-sessions worker) links guild battles that began between 30 minutes before the earliest of `started_at`/`start_time_utc`/`mass_time_utc` and 20 minutes after `stopped_at` (or now). It stops paging at the first page older than that window, keeps battles from earlier pages when a later page fails, and records `link_attempts`/`link_last_error`. A battle already assigned to another event stays there. `linker_is_done` treats `cancelled` as done, and cancelling sets `link_status = completed`.
- Creating an event in an alliance snapshots its active guild memberships into the control-plane outbox and creates tenant-local event copies with origin identity. A backend worker checks for due targets every 15 seconds and applies retry backoff; `GET /api/events/{id}/fanout-status` requires event-management authority and shows each guild's state. A membership that left before the worker links its copy is marked inactive, and the copy is archived if it already exists.
- Alliance event copies use each destination guild's `discord_event_delivery` setting; Discord channels, forum tags, and VOD forum destination remain tenant-local. The event's VOD opt-in is inherited from the alliance event. Guild-origin `ping_alliance` still uses the existing direct mirror path; a failed mirror is logged but does not yet use the new outbox.

The bounded router excerpt registers event CRUD/lifecycle, roster, participation, voice-channel, and battle-related route families. Roster write requests carry `expected_roster_version`.

(Details pending/documentation failed) Full route authorization, request/response shapes, and mount behavior require a compliant bounded review.

## Invariants

- Event timestamps are RFC3339; mass time cannot be later than start. The comp expansion threshold is floor-based at 75% of capacity.
- `Fill` is a virtual roster role; roster writes carry `expected_roster_version`.
- Every organized event has an ordered list of parties (`event_parties`: `position`, optional `name`, one `comp_id` each); creating the event creates party 1 with the chosen comp, and `events.comp_id` always equals party 1's stored comp. Flash events have no parties.
- Seats come from one derivation, `EventService::seat_plan` (`parties.rs`): parties in `position` order, each contributing its comp's seats then its own extra roster roles. A seat key is `party:{party_id}:build:{build_id}:{n}` with `n` counting that build's seats inside the party, so keys survive reordering and renaming parties and changing a party's comp whenever the build and ordinal still exist. Every roster read and write, signup capacity, auto-fill and suggestions use it; removing an extra role or a party deletes the assignments of the seats that disappear.
- Board party numbers are derived: each event party starts on a new board number and spans `ceil(seats / 20)` of them; `position` restarts at 1 inside each board party.
- The 75% comp-variant auto-resolution applies only to an event with exactly one party (that party's effective comp is the variant). With two or more parties every party uses its stored comp, so adding a second party can unseat members who sat on variant-only seats.
- Party writes (`POST /{id}/parties`, `PATCH|DELETE /{id}/parties/{party_id}`, `POST /{id}/parties/order`) carry `expected_roster_version`, bump it, and broadcast `parties_changed` on the live roster socket. Changing a comp or removing a party reports `unseated_count`; the last party cannot be removed (409). Extra roster roles take an optional `party_id` (default: the last party). Editing an event's `comp_id` changes party 1's comp under the same keep-or-unseat rule.
- Signup options keep the flat, summed `builds` list (the bot reads it) and add `parties` with each party's own builds.
- Alliance copies and guild-to-alliance mirrors are single-party: they copy party 1's comp and its extra roles only, and officer seat/role forwarding maps parties by position, so seats and roles of parties 2+ have no counterpart on copies. Party structure changes are not forwarded.
- (Details pending/documentation failed) Remaining validation and fight-grouping invariants require a compliant bounded review.

## Side Effects

Alliance event copies are linked through the control-plane `event_sync_links` table. A source event can have several active destination copies; participation updates resolve the canonical event and all siblings. Creating an alliance event queues target work after the canonical event commits; tenant databases are not part of a shared transaction.

(Details pending/documentation failed) Other database, notification, live-roster, and synchronization effects require a compliant bounded review.

## Fight grouping and battle statistics

- `fight_grouping::score_fight_grouping` is pure. `AutoMerge` needs independent evidence (a shared opposing guild or a shared player); the event, a short gap and our own guild being on both sides only reach `NeedsReview`, and fully disjoint opposing guilds cap the pair at `NeedsReview`. Evidence keys are never blank: guilds fall back to their name, players to `name|guild` (the same rule as the fights module's `player_rollup_key`), and a player is friendly through the battle's own guild rows (`FriendlySide::for_battle`).
- Grouping (`group_fights_by_adjacent_evidence`) never touches fights with `grouping_method = "manual"`, merges inside one transaction (`auto_merge_fights`; a vanished fight is a logged skip) and clears a stale `needs_review` on non-manual fights that every comparison in the pass settled as `Separate`.
- `group_orphan_fights` only merges orphans of the same event scope: linked in `event_battles` to the same event, or inside the same event's Start..Stop window, or outside every event. `ensure_seed_fights_for_event` attaches an orphan fight only when all its segments belong to the event; the others are split into a new orphan fight first (`attach_orphan_fight_to_event`). A battle whose fight belongs to another event is a logged skip, never a 409.
- The event page still seeds and groups on read (`sync_event_fights`), because event-scoped grouping has no other caller; it logs and skips failures instead of failing the read. A worker may call the same function.
- Event statistics count per Fight: `total_battles`, `wins`, `losses` and each `top_opponents` row's `battles`/`wins`/`losses`. "Our side" is every friendly `battle_guild_stats` row summed (own guild plus allies), for kills, deaths, kill fame and player counts, in `EventBattleView`, the opponent rollups and `fight_stats`.
- `EventFightView` carries the Fight's stored `outcome` (`FightOutcomeView`, same shape as `GET /api/fights`), `segment_count`, and, once `fight_stats` exists, `stats` (`FightAggregateStats`) plus `total_players`/`total_kills`/`total_fame` (friendly side). Every `win_rate` in the API is a percentage in `0..=100`.

## Verification

From the repository root, run `cargo test -p backend-events`.
