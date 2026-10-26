# Flash Pings — Fast Announce System (Implementation in progress)

* **Author:** alessandrobrunoh
* **Date:** 2026-10-26
* **Status:** REVIEWED — 6-lens Goldfish review complete (2026-10-26).
  Deduplicated objections in "Analysis"; implementation notes revised where
  the review contradicted them (marked there).

## Overview

The guild announces content through two paths, both built on the same `Event`
entity in the backend:

- **Flash pings** (ex "content pings"): quick, spontaneous content calls.
- **Call to Arms**: urgent officer events with their own channel and role.

In practice, people announce flash content by typing a plain Discord message.
Both real creation paths are too slow for a "flash" decision:

- The website opens a large dialog (`app-dialog size="lg"`) with comps, caps,
  roles, splits, and more — fine for a planned CTA, heavy for "gank in 30m".
- The bot's `/event-create` asks for an **ISO timestamp**
  (`2026-08-15T20:00:00Z`) and a **numeric composition ID**, and is
  **Officer-only** (see `apps/discord-bot/src/commands/event-create.ts`).

A plain message loses what the system actually adds: the role ping, the
signup thread with Join/Leave buttons, the calendar entry, and the pre-event
mass/start reminders.

**Working hypothesis:** make launching a flash ping take seconds from Discord
(mobile included) by reusing the existing announcement/thread pipeline with
sane defaults. The current event system (comps, builds, splits, regear)
stays and gets consolidated into a single `#call-to-arms` channel.

## Target structure: 2 channels, 2 systems (direction chosen)

```
Discord server
├── #flash-mass                 NEW channel — flash masses only
│   ├── ⚡ ping: text + role + thread
│   │      └─ [✅ Join] [🚪 Leave] [🔔 Ping] [▶️ Start] [⏹️]
│   └── 📅 Flash calendar (persistent, self-updating)
│
└── #call-to-arms               CURRENT system, merged into ONE channel
    ├── 📌 normal events   (comp, builds, splits, regear)
    ├── 🚨 CTA events      (same channel — the flag is importance, not place)
    └── 📅 ONE Call to Arms calendar (persistent)
```

Rules:

1. **`/flash` works from any channel.** The ping is always created in
   `#flash-mass`, whatever channel it is launched from.
2. **Flash ping from an existing message** — one correction: Discord does
   not support "reply + slash command" (the reply is dropped when a slash
   command is typed). The native equivalent is the message context menu
   (long-press / right-click → Apps → ⚡ Flash mass — concept B), or
   `/flash` with a message-link option. Same UX, supported mechanics.
3. **`call_to_arms` stays a flag on the current system**: importance
   (urgent styling), not a separate channel anymore. All organized events,
   CTA or not, live in `#call-to-arms` with one calendar.
4. **Voice channels: mostly already built.** Today the bot creates the
   voice channel at Mass or Start (`SetEventVoiceChannelRequest`), deletes
   it on Stop/Cancel when empty, and keeps it while occupied; the category
   is configured (`discord_event_voice_category_id`). New requirement:
   a periodic sweep that deletes orphaned/empty event voice channels so
   stale ones never pile up between masses.

Migration: the Admin → Discord "CTA channel" setting is retired; the
"events channel" becomes `#call-to-arms`; a new `#flash-mass` channel
setting is added. Both channels get their own persistent calendar.

## What exists today (evidence from the code)

| Piece | Where | Friction point |
|---|---|---|
| Site create form | `apps/frontend/.../events/events.ts` | Large dialog; full event ceremony |
| Bot create | `/event-create` | ISO date + `comp_id` number; Officer-only |
| Announcement | `buildEventAnnouncementMessage` | Parent = text + role ping; thread holds the signup card |
| Signup thread | `buildEventThreadActionRows` | Join / Leave / Ping / Start / Stop / Cancel buttons |
| Calendar panel | `buildEventCalendarMessages` | Persistent "Content Pings" index in the channel |
| Delivery | poller (`pollNow`) | Announce happens via poll; direct path must update the poller checkpoint or events get announced twice |

## The core fork: what IS a flash ping?

Every concept below has to answer this first.

1. **A flash ping is a full `Event` with defaults** (recommended).
   Calendar, roster, reminders, stats, splits keep working unchanged.
   Cost: `Event` currently requires a comp — comp must become optional or
   defaulted for this path.
2. **A flash ping is a new lightweight entity.**
   Fast to create, but now there are two announcement systems, two calendars,
   two sets of stats. Higher long-term cost for a small win.
3. **A flash ping is a pure announcement** (no event at all).
   Fastest to build, loses everything the system is for. Probably a non-goal.

## Concepts

All concepts reuse the same output: the existing parent announcement +
thread + signup card. They differ only in **how you launch it**.

Shared result (existing pipeline, unchanged shape):

```
#content-pings

📌 Castle dive @ Mercer - Mass 21:15 | Start 21:45 | 26/10
meet Caerleon gate, bring escape
|| @Content Ping ||
---
└─ 💬 thread:  ⚡ Flash Ping #123 · by @alessandro · 2m ago
              [✅ Join] [🚪 Leave] [🔔 Ping] [▶️ Start] [⏹️]
```

---

### A. `/flash` command + modal  (typing-first)

One slash command. A modal with **two required fields**, everything else
defaulted from channel settings (roles) and sensible values (mass = when you
say, start = +30m, comp = none or default).

```
  user types:  /flash

┌──────────────────────────────────────────────────┐
│ ⚡ Flash ping                                     │
│                                                  │
│ What            [ Castle dive @ Mercer        ]  │
│ When            [ 30m            ]  ← or 21:00    │
│ Notes (opt.)    [ meet Caerleon gate           ]  │
│                                                  │
│                       [ Cancel ]  [ Send ping ]  │
└──────────────────────────────────────────────────┘
```

- Fixes the two real blockers: accepts `30m` / `21:00` / `in 1h`, never asks
  for a comp ID.
- Build cost: M (new command, modal, time parser, direct announce path).
- Risk: still 6–10 taps on mobile; typing a title on phone is the slow part.

---

### B. Promote an existing message  (context menu)

People already type the plain message. Make that message the input:
long-press / right-click → Apps → "Flash-ping this".

```
 (in any channel)
  alessandro: castle dive @ mercer, 21:15, meet caerleon gate
        │  right-click / long-press
        ▼
 ┌───────────────────────────┐
 │ Apps ▸                    │
 │  ⚡ Flash-ping this message │
 └───────────────────────────┘
        │  ephemeral confirm, prefilled
        ▼
 ┌──────────────────────────────────────────┐
 │ ⚡ Turn this into a flash ping?           │
 │  What:  castle dive @ mercer             │
 │  When:  [ 21:15 ▾ ]  Roles: [Content ▾]  │
 │             [ Cancel ]  [ Send ping ]    │
 └──────────────────────────────────────────┘

 original message gets a bot reply:
 ⚡ promoted to Flash Ping #123 → thread link
```

- First line becomes the title, the rest the description; a time found in
  the text pre-fills When.
- Zero new typing habit needed — matches what people already do.
- Build cost: M (context menu entry + confirm card + parser reuse).
- Risk: title/description split can guess wrong; the confirm card must let
  you edit, not just send.

---

### C. Flash Hub panel  (tap-first, zero typing)

A persistent pinned panel in `#content-pings` (Components V2, like the
current calendar). Officers configure presets: label, delay, roles,
description template, optional comp. Members see buttons; **one tap = one
ping**, no modal.

```
#content-pings                          (pinned)
┌────────────────────────────────────────────────┐
│ # ⚡ FLASH PINGS                                │
│ ────────────────────────────────────────────── │
│  One tap. Default mass +15m · @Content Ping    │
│                                                │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────┐ │
│ │ ⚡ Open world │ │ 🗡️ Gank now  │ │ 🏰 Castle │ │
│ │    in 15m    │ │    in 15m    │ │  in 2h   │ │
│ └──────────────┘ └──────────────┘ └──────────┘ │
│ ┌──────────────┐ ┌──────────────┐              │
│ │ 🕳️ Avalon    │ │ ⚙️ Custom…   │  → modal A   │
│ └──────────────┘ └──────────────┘              │
└────────────────────────────────────────────────┘
```

- Fastest possible path for recurring content; "Custom…" falls back to the
  modal (Concept A).
- Build cost: M (panel + preset admin UI + handler + undo).
- Risks:
  - One accidental tap pings the whole role → needs a short **undo window**
    (e.g. the ping's thread shows "Undo" to its author for 60s) and
    per-preset permission config.
  - Presets go stale when the meta changes; someone must own them.

---

### D. Free-text trigger  (fastest to type, riskiest)

`!flash castle dive @ mercer in 30m` — or reply to a message with `!flash`.
The bot parses it and answers **ephemerally** with a confirm card, so a bad
parse can never ping the role by itself.

```
  alessandro: !flash castle dive @ mercer in 30m
                       │
                       ▼  (visible only to alessandro)
 ┌──────────────────────────────────────────┐
 │ ⚡ I read this as:                        │
 │    What:  castle dive @ mercer           │
 │    When:  in 30m (today 21:15)           │
 │    Roles: @Content Ping                  │
 │                                          │
 │   [ ✅ Send ping ]   [ ✏️ Fix it ]        │
 └──────────────────────────────────────────┘
```

- Lowest friction after B; works from mobile with zero menus.
- Build cost: M–L (time/role grammar; multilingual: `30m`, `tra 30m`,
  `21:00`, `stasera`, …). Every added language is more parser surface.
- Risk: parsing is an endless edge-case factory. The ephemeral confirm is
  mandatory, not optional — which costs back some of the speed.

---

### E. Site one-row composer  (keep the site honest)

For whoever is already on the site. A single row at the top of the Events
page replaces "open the big dialog" for the flash case; the full dialog
stays for planned events and CTAs.

```
┌ Events ──────────────────────────────────────────────┐
│ ┌────────────────────────────┐ ┌───────┐ ┌─────────┐ │
│ │ Title…                     │ │ in 30m▾│ │ ⚡ Flash │ │
│ └────────────────────────────┘ └───────┘ └─────────┘ │
│   Full form still here for CTA / comps / splits       │
└──────────────────────────────────────────────────────┘
```

- Build cost: S (frontend row + existing create API with defaults).
- Risk: does not fix the main problem (people are on Discord, not the site).
  Worth doing only as a companion to A–D, not instead of them.

## Flash mass: binary participation — no comp, no builds (direction chosen)

Decision (author): a flash ping is a **flash mass** — participation is
binary. You are in or you are out. No comp, no builds, no primary or
secondary, no Fill. The roster is a plain list of names.

Why this is the right cut:

- It deletes the whole dependency chain above (catalog sources, last-used
  defaults, search modals, "who decides the weapons"). The question stops
  existing.
- It matches the real decision a member makes for spontaneous content:
  "can I come or not", not "which of my 30 weapons".
- Join is one tap with no ephemeral select at all; Leave is one tap.

Costs accepted (with mitigations):
1. **A flash mass that turns serious has no seat/build data.** Mitigation:
   no in-place promotion is planned. If it becomes an organized event, create
   a separate organized event and link it to the flash thread.
2. **The combat pipeline loses expected-figure data for these fights**
   (`combat/service.rs` reads `primary_build_id` from signups). If regear
   policy covers only Call to Arms, the cost is zero; if it must cover
   flash masses too, those deaths need a flat or manual path.
3. **The roster says WHO comes, not WHAT they play.** For spontaneous
   content, chat and voice cover that; the shotcaller eyeballs it.

Implementation note (revised after review): keep the `Event` entity, but
add an explicit `event_kind` (`flash` | `organized`) BEFORE making
`comp_id` nullable — never infer flash from NULL comp or NULL build
(NULL build already means "Fill inside a comp"). Flash events never enter
comp-shaped routes: roster / signup-options / splits / regear answer an
explicit 409, and the card renders a plain name list. See Analysis #1 and
open question 8.

What the thread looks like now — Join is one tap, no menus, and the roster
is just names:

```
💬 Thread: Flash Mass #123 — Castle dive @ Mercer

┌─ GUILD EVENT ─────────────────────────────┐
│ 📌 Castle dive @ Mercer                   │
│ meet Caerleon gate, bring escape          │
│                                           │
│ 🗓️ 26/10 · ⚡ SCHEDULED · 👑 alessandro    │
│ 📣 Mass 21:15 (in 30 min)                 │
│ ▶️ Start 21:45                            │
│                                           │
│ 📋 Coming (3)                             │
│  @alessandro @mirko @giulia               │
└───────────────────────────────────────────┘
[✅ Join] [🚪 Leave] [🔔 Ping] [▶️ Start] [⏹️]
```

Click **Join** → instant `✅ You're in. See you at mass 21:15.` and the
card updates for everyone. No select, no build question. The existing
Start button already mass-pings the participant list into voice.
Pinged Discord role: the configured default event-ping role from Admin →
Discord. Per-ping role selection is not part of this version.

## Comparison

| | Time to ping (mobile) | New habit? | Misclick risk | Build | Notes |
|---|---|---|---|---|---|
| A `/flash` modal | ~10 s | small | low | M | baseline everything else builds on |
| B promote message | ~5 s | none (uses existing behavior) | low | M | strongest fit with observed behavior |
| C hub panel | ~2 s | small | **high w/o undo** | M | best for recurring content |
| D `!flash` text | ~6 s incl. confirm | small | low (ephemeral confirm) | M–L | parser is permanent maintenance |
| E site row | n/a | — | low | S | companion only |

## Fix regardless of chosen concept

These are the actual causes of "people just send a message"; any concept
without them is cosmetics:

1. **Relative time everywhere** — `30m`, `21:00`, `in 1h`; ISO only as a
   hidden fallback. Applies to site and bot.
2. **Flash masses carry no comp at all**; `comp_id` becomes optional on
   the `Event` entity (decision section above).
3. **Permissions configurable** — who may flash-ping is an Admin setting
   (role list), not hardcoded Officer-only.
4. **Durable announce ownership** — per-event announce state
   (status plus parent/thread/signup message ids) stored in the per-guild
   poller checkpoint, instead of "post then bump lastEventId" (Analysis #2).
   Success is logged only when Discord delivery is recorded.
5. **Undo window** — the author can cancel the ping for 30 seconds. The
   existing event `created_at` timestamp is the durable deadline; the poller
   holds both the public ping and calendar row until it expires.

## Analysis (Goldfish multi-lens review — 2026-10-26)

Six independent reviewers (YAGNI, rate limits, UX, migration, SRE, tech
debt) stress-tested this brief against the codebase. Deduplicated
findings, most severe first. Convergence across independent lenses is
marked — treat those as near-certain.

**What survived:** binary Join/Leave with a name roster; reusing the
announce + thread + signup-card pipeline; relative-time creation from
Discord; the voice orphan sweep (as independent ops hygiene, decoupled
from flash scope).

### Near-certain (multiple lenses, blocker-level)

1. **Never infer "flash" from `comp_id IS NULL` or NULL builds.**
   (YAGNI, tech debt, migration) `comp_id` is required end-to-end today:
   `to_event_views` fails without it, `resolve_active_comp_*` feeds
   roster, signup-options, embeds, and combat. NULL `primary_build_id`
   already means "Fill inside a comp" — reusing it for "no comp at all"
   collides with real Fill signups. Fix: an explicit `event_kind`
   (`flash` | `organized`) column shipped BEFORE nullable comp; comp-shaped
   routes (roster, signup-options, splits, regear) return an explicit 409
   for flash; calendars filter by `event_kind`, never by nullable FK.
   Alternative (YAGNI only): a real default "Open/Flex" comp avoids the
   schema change but makes every flash event carry a fake comp forever.
2. **Announce ownership must be durable, not "post then bump
   lastEventId".** (YAGNI, tech debt, migration, SRE) Bump-then-post
   loses pings; post-then-bump can duplicate them — and the checkpoint
   has no field to tell which happened. Fix: per-event announce state
   (`announceStatus` + parent/thread/signup message ids) with idempotent
   claiming; the poller only announces events whose status ≠ posted.
   This bug shape exists TODAY: the poller advances `lastEventId` and
   logs "Announced" even when thread creation failed. Never advance or
   log success without a parent message id.
3. **Decide launch permissions before writing code.** (YAGNI, UX) If it
   stays officer-only, most of this plan reduces to a UX fix on
   `/event-create`; if members can launch, accidental role pings become
   the dominant risk and require undo + per-author rate limits. Still
   open question 1.
4. **Undo as Discord teardown is the expensive way.** (UX, rate limits,
   tech debt) Cancel today means thread close + calendar rewrite +
   checkpoint churn. Fix: `undo_until` timestamp on the event; undo is a
   DB cancel; optionally hold the role ping until the window expires
   (soft-hold) so undo costs zero Discord calls.

### Major (single lens, well-evidenced)

5. **Calendar rewrite tax.** The poller re-edits every calendar page every
   ~60s per guild even when identical; two calendars ≈ 2N edits/min
   baseline on one shared bot token. Add payload hashing / change
   detection, keep ONE calendar writer (poller queue; interactions only
   mark dirty). Join/Leave never touches calendars — the calendar text
   carries no headcounts.
6. **Join/Leave stampede.** One-tap binary signups on a hot flash card need
   coalesced refreshes (debounce per event, single in-flight edit) or
   same-message 429s make the card lag behind reality.
7. **Time input needs a hard contract.** `21:15` has no day; `30m` depends
   on send time; wall-clock resolves per device locale today. One guild
   timezone setting, explicit accepted forms, "did you mean today 21:15?"
   recovery. A wrong mass time is a role-wide false alarm.
8. **Channel routing must become one function.** Today
   `call_to_arms ⇒ channel` is scattered (poller announce, calendars,
   command docs); after the reorg, any leftover condition silently
   misroutes. One `destinationChannel(event, settings)` keyed only by
   `event_kind`; retire the CTA column only after no bot build reads it;
   migrate per-guild checkpoint calendar message ids when channels
   repoint.
9. **Rollout and rollback ordering.** Additive columns first (`event_kind`,
   nullable comp, flash channel setting, keep CTA column); gate flash
   creates behind a flag; enable per guild only once its flash channel is
   set — a missing channel must fail loudly (and the announce loop must
   `continue` per event, not `return`: today a missing channel aborts the
   whole batch). After nullable rows exist, rollback = forward fix.
10. **Bot strings are English-only.** Flash is the highest-frequency,
    lowest-patience path and the guild runs Italian. Localize at least the
    flash launch errors, modal, undo, and Join/Leave labels (it + en
    first); do not wait for full bot i18n.
11. **Observability floor.** One structured line per announce attempt
    (guild_id, event_id, correlation id, source, stage, result, parent
    message id, discord error code); guild attribution on every hot-path
    log (multi-tenant process); checkpoint corruption must quarantine the
    file, not silently reseed (reseed swallows in-flight pings); counters
    to alert on "announced 0 times" / "duplicate blocked".
12. **The site must handle flash or hide it.** The ~6k-line event detail
    centers comps/builds/Fill; a flash mass opened there trains distrust.
    Either a thin flash presentation (name list, no comp columns) or
    exclusion from the full events UI until promote exists.

### Scope pushback (author to decide)

13. **YAGNI lens: ship less first.** Its position: the root cause is a
    command UX bug (ISO time + numeric comp + officer gate), so v1 should
    be `/flash` + modal + permissions fix, then measure whether plain
    messages actually stop before committing to the channel reorg,
    context menu, promote path, and hub presets; the voice sweep is
    separate ops work either way. This is a sequencing argument, not a
    design flaw — the two-channel structure above remains valid if it
    lands incrementally.

## Open questions

1. Who should be able to launch a flash mass — officers only, or (some)
  members? Is the current Officer-only gate part of why people fall back
  to plain messages? **Still the main open question.**
2. RESOLVED — minimum contract: binary participation, roster of names,
   signup thread stays, no comp/builds.
3. RESOLVED — comp: none at all for flash masses.
4. How far ahead is a flash mass — minutes ("happening now") up to a few
  hours ("tonight 21:00")? Never days?
5. Promote path (now required by the binary decision): flash mass → full
  event / CTA where participants pick builds once. Confirm shape.
6. Primary surface: mobile Discord, desktop Discord, or site?
7. Inside `#call-to-arms`, does a CTA event ping anything differently from
  a normal event (extra role, @here), or is the flag purely visual weight?
8. Implementation discriminant (from Analysis #1): `event_kind` column
  (recommended by three lenses) vs a default "Open/Flex" comp (no schema
  change, fake comp forever).
9. Sequencing (from Analysis #13): land `/flash` + modal + permissions
  first and measure, or ship the full two-channel structure in one go?

## Goals vs. Non-Goals (draft)

* **In-Scope Goals:** flash mass system in `#flash-mass` (binary
  participation, `/flash` from anywhere, message context action, own
  calendar, short private undo window); the current event system consolidated
  into a single `#call-to-arms` channel with one calendar; launch access
  controlled by the existing `events.create` role permissions; periodic
  cleanup of old, empty event voice channels.
* **Out-of-Scope Non-Goals:** a new event entity type (flash mass stays an
  `Event`); replacing the announcement/thread pipeline; analytics on ping
  engagement; comp/build/split data on flash masses; mutating a flash mass
  into an organized event in place.

## Key Decisions & Staging for Next Steps (implementation)

Decisions taken going into implementation (follow the review's convergent
recommendations):

1. **`event_kind` column** (`flash` | `organized`) — no fake default comp.
   Flash is never inferred from NULL comp or NULL build.
2. **Launch permissions use the existing `events.create` role grants.**
   The bot passes the creator's Discord role IDs to the backend. This release
   does not add a separate flash-only role list.
3. **Incremental staging** toward the two-channel target:
   - **Stage 1 — backend foundation: implemented in this worktree (2026-10-26).** Migration
     `m20261026_000001` adds `event_kind` and makes `comp_id` nullable
     (SQLite-safe table rebuild, Postgres `DROP NOT NULL`; `down()` refuses
     — roll forward). Create validates kind (flash rejects comp/split/
     cap/regear/CTA/alliance options; organized still requires `comp_id`, so
     old clients observe the old contract). Comp-shaped routes answer 409
     for flash via `organized_comp_id()`. `participate` is binary on flash
     (build choices rejected). Detail returns comp-less "Coming" data.
     Fights/intel/regear consumers skip flash rows.
   - **Stage 2 — bot: implemented in this worktree.** `/flash` and the
     `Apps → Flash mass` context action open an editable modal; relative and
     guild-timezone scheduling; binary Join/Leave; one flash route and one
     organized route; separate calendars with unchanged-payload edit checks;
     persisted announce retries and a 30-second private undo window.
   - **Stage 3 — admin/site/operations: implemented in this worktree.** Admin
     settings include the flash channel and IANA timezone; the site shows a
     comp-free flash detail; the bot sweeps old empty event voice channels
     every 15 minutes (only after they are at least 30 minutes old). Bot copy
     for flash launch, cards, calendar, Join/Leave and Undo supports Italian
     and English; unrelated bot features keep their existing copy.

Deployment before enabling: migrate the backend, set the events channel to
`#call-to-arms`, set a different flash channel, choose the event ping role,
timezone, and voice category, and ensure the bot can create/delete channels
in that category. The old CTA channel setting is retained for compatibility
but no longer controls event routing.
