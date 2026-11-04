# Weaklings guild seasonal progression and ranking

**Status:** proposal for implementation; not yet implemented.
**Scope:** tenant-scoped guild progression, seasonal ranking, configurable XP rules, benefits, and optional Discord rank-role integration.

## Product decisions

- A Weaklings season follows the relevant official Albion season. Administrators enter and can edit its start and end dates; do not assume a fixed duration or unverified external dates.
- A player is **present if they are in the event's participant list**. No voice, combat, or officer attendance confirmation is required. For completion awards, take a consistent snapshot of the active participant list when the event is successfully stopped or auto-stopped. A player who has left the list before that snapshot does not receive that event's participation award. An event that is cancelled or never completed does not award event creation or participation XP.
- Guild rank represents a progression tier and is distinct from a numeric leaderboard position, the application's authorization roles, and Discord roles. Names are configurable and need not match Discord role names.
- In the admin panel an authorized administrator can map each configured guild rank, e.g. `Veteran`, to a Discord role selected from the connected guild's available roles. A rank may remain unmapped. Support manual Discord role assignment without requiring Discord role names to match rank names; do not infer progression rank or privileged permissions merely from a Discord role.
- Automatic Discord role assignment is an intended integration; its ownership, removals, and interaction with manually assigned roles require an explicit policy before implementation (see open decisions). Do not remove a role merely because it appears in a rank mapping.
- Leaderboard exclusion and progression exclusion are separate: hidden users may still earn XP; users with progression disabled receive no new progression XP or rank benefits. Preserve existing ledger history. Individual exceptions override role-based defaults, and changes require audit information.
- Creation XP is awarded once to the original creator **only after** the event is successfully completed. Awards are idempotent and must not be duplicated by event mirrors, restarts, retries, or multiple characters.
- Only the original guild event awards progression XP; an alliance mirror must not award it again.
- Resolve the season at the event's completion time using `[start, end)` boundaries. Persist that season with the completion record so retries cannot move the award to a later season.
- XP and thresholds are configurable; the proposed values are starting points for simulation, not validated balance. Rank alone does not guarantee economic or operational benefits when recent-activity rules are not satisfied.
- Do not land changes, push to a shared branch, or enable economic benefits solely because this document exists.

## Current implementation: verified starting points

- `apps/backend/src/modules/progression/` has season-scoped accounts, active seasons, a configurable XP curve and rates, a ledger, and `ProgressionService::award`. Ledger idempotency is per season and idempotency key; awards update account and ledger transactionally. See `apps/backend/src/modules/progression/README.md` and `entities.rs`.
- The existing event implementation currently awards `EventCreate` on creation, `EventJoin` on signup, and `EventComplete` to the roster at stop. This differs from the requested completed-event-only behavior; see `apps/backend/src/modules/events/service.rs` (`create_event`, `stop_event`, participation handling, and `try_award_event_xp`). Do not add a second awarding path without preventing double awards.
- `event_kind` already distinguishes `flash` and `organized`. Add a separate configurable event classification rather than repurposing `event_kind`; inspect current event create/edit flows, bot commands, and historical rows before designing migration defaults.
- The admin UI already has progression settings and season management at `apps/frontend/src/app/features/admin/admin-progression.ts`; the member-facing season UI is `apps/frontend/src/app/features/leaderboards/leaderboards.ts`.
- The existing ledger records source, base amount, applied amount, multiplier, actor and idempotency key. Its present schema does not by itself establish the requested rule-version, attendance-snapshot and adjustment provenance.
- This is a source-level assessment. It does not verify production settings, actual historical attendance coverage, external Albion season dates, or live Discord configuration.

## Proposed starting rules

### Guild ranks

| Rank | Season XP | Proposed benefit |
| --- | ---: | --- |
| Recruit | 0–399 | Access to progression |
| Active | 400–899 | Split bonus +5% |
| Reliable | 900–1,499 | Two T8 smallscale builds, once per season, subject to availability and delivery recording |
| Veteran | 1,500–2,199 | Split bonus **10% total**, not 5% + 10% |
| Core Member | 2,200+ | Regear and conditional content priority |

The bonus and other benefits must not be activated until their economic rules and recent-activity window are explicitly approved and tested. Keep thresholds configurable, non-overlapping, and validated as a complete ordered range.

### Initial XP rules, subject to calibration

| Event classification | Original creator, on completion | Participant in final list |
| --- | ---: | ---: |
| Flash Mass | +5 | +10 |
| CTA Non Mandatory | +10 | +25 |
| CTA Mandatory | +15 | +40 |

Optional rules for punctuality, organizer work, needed roles, and exceptional contributions start disabled. XP from Discord messages must not affect economic rank unless explicitly enabled by a separately approved policy.

For Core Member at mid-season, 2,200 XP in 29 days is about 531 XP/week; at 40 XP per mandatory CTA this takes 55 participations without other awards. Simulate on actual guild event volumes before enabling benefits.

## Proposed UX

### Admin: ranks and Discord mappings

```text
Admin / Progression / Guild ranks

Rank name          Minimum XP     Discord role               Assignment
Recruit                    0     [ Select role         v ]  [ Manual / Auto v ]
Active                   400     [ Select role         v ]  [ Manual / Auto v ]
Reliable                 900     [ Select role         v ]  [ Manual / Auto v ]
Veteran                1,500     [ Custom guild role   v ]  [ Manual / Auto v ]
Core Member            2,200     [ Select role         v ]  [ Manual / Auto v ]

Guild rank names and Discord role names can differ.
Discord role mapping does not grant management permissions.
                                              [Save changes]
```

This is a proposed layout. The selector uses the existing Discord role lookup; show unavailable/deleted roles and bot hierarchy/permission failures rather than silently dropping a mapping. `Manual / Auto` is a design proposal, not a settled role-ownership policy.

### Member: rank and evidence

```text
Season 35                                [View XP history]

Guild rank: Veteran                  Leaderboard position: #12
1,860 / 2,200 XP  [======================------]  Core Member

Benefits: split +10% · recent activity: eligible / not eligible
XP sources: earned 1,560 · Legacy 300

Recent XP
+40  CTA Mandatory · event #123 · listed at completion
+25  CTA Non Mandatory · event #117 · listed at completion
```

Show unavailable/loading states distinctly; do not present an unconfigured or unearned benefit as available.

## XP rules, exclusions, and season history

### Rules and audit

Each versioned rule identifies event classification, action, amount, enabled state, completion requirement, optional attendance constraint, maximum awards, and effective time. Record which immutable version, participant-list snapshot, season, source event, base amount, multiplier, and idempotency key were used for each award. Do not automatically recalculate previously granted XP after a rule or category change.

Stopping an event must not make XP loss permanent if an asynchronous award fails: use a durable, retryable completion record or equivalent transactional boundary, and make failures visible. A repeated completion or concurrent retry must not duplicate awards. Keep corrections as auditable compensating ledger entries with actor and required reason, not silent history rewrites.

### Eligibility and exclusions

- Evaluate individual and Discord-role exclusions separately for leaderboard visibility and progression/benefits.
- Individual explicit overrides take precedence over role defaults. Define the multi-role combination and unknown/stale Discord role behavior before launch; fail safely for benefits, with a visible explanation.
- Recalculate public leaderboard positions among visible members. Preserve the underlying XP ledger and optionally show authorized administrators why a member is hidden.
- Resolve participants to stable account identities; do not award twice for multiple linked characters.

### Season lifecycle and Legacy

- Seasons have guild/server-specific start and end timestamps with a clearly displayed timezone; support gaps between seasons. No ordinary XP in an off-season by default. Completion awards use `[start, end)` and the season fixed at event completion, not the retry time.
- Finish and archive results using an idempotent per-season snapshot before starting the next season's Legacy. Use the immediately previous season only.
- Proposed Legacy: Recruit 0/no boost; Active 100 and ×1.05; Reliable 200 and ×1.10; Veteran 300 and ×1.15; Core Member 400 and ×1.20. Boost expires 14 days after the new season starts and applies only to eligible completed activities.
- Keep Legacy starting XP separate from earned activity XP. Specify rounding, caps, late events, corrections, overlapping seasons, and reruns before implementation; existing season date boundaries are inclusive and require careful transition handling.

### Benefits and economy

- Rank thresholds and active eligibility are distinct. Define recent activity, exceptions, and timezone explicitly.
- Percentage bonuses are **tiers, not additive**. Before implementation decide the funding source, calculation base, rounding, caps, and whether eligibility is captured at split creation or completion. Persist the applied tier/rule with the transaction so future rank changes do not silently rewrite payments.
- Track the two-build benefit as an auditable, once-per-season entitlement with availability and delivery records; do not automatically create an item grant.
- Regear and content-priority eligibility require explicit policy and permissions. Existing transaction and regear behavior must not be weakened.

### Discord

- Store rank-to-role mappings by stable Discord role ID per guild, not role name. Support the admin selecting any permitted Discord role and leaving a mapping empty.
- Manual Discord assignments must remain possible. Before enabling automated mutation, agree on whether mapped roles are bot-exclusive or how bot-managed grants are tracked separately; otherwise automatic demotion can remove an independently assigned role.
- Sync operations need idempotent/retryable jobs, rate-limit handling, role hierarchy/permission diagnostics, and a manual repair path. A bot outage must not corrupt authoritative XP or fabricate successful role changes.
- `/rank`, `/progress`, promotion notifications and season announcements are later integrations; do not let Discord role changes become the authority for XP or backend permissions.

## Proposed implementation slices

Each slice ends with focused tests and a reviewable handoff. Do not enable financial rewards during the early slices.

1. **Attendance and XP foundation:** inspect actual participant-list semantics and event mirror identity; version classification/rules; snapshot participants at successful completion; make completed-event awards durable/idempotent, and prevent old create/join awarding paths from double-paying. Explicit migration/backfill policy required.
2. **Rank configuration and Discord mapping:** persist configurable thresholds, rank names and optional Discord role IDs; admin editor and member rank view. Mapping can be configured without enabling automatic Discord mutations.
3. **Simulation and exclusions:** simulate rules on available history with coverage warnings; individual/role exclusions, override precedence, audit and visible leaderboard ranks.
4. **Season closure and Legacy:** snapshot, rollover, off-season and previous-season-only boosts, with idempotency and recovery.
5. **Benefits and Discord automation:** only after approval of economy/activity and role-removal policies; implement split/regear entitlements, one-time delivery, reliable role sync and notifications.

## Acceptance and verification

- Event list membership at completion is the attendance source; cancelled events and removed participants do not receive completion awards. Creator gets creation award once only after completion.
- Repeated stop, concurrent worker, retry, mirrored event, and multi-character cases do not double-award. Failure after event stop remains discoverable and recoverable.
- Existing seasons and ledger history remain intact. Migration/replay policy is explicit; do not silently reclassify or retroactively award old events.
- Rank thresholds are validated; leaderboard hiding does not erase XP; progression exclusion disables XP/benefits according to the effective policy.
- Rank-to-role mapping accepts different names, unmapped ranks and missing Discord roles; manual assignment remains supported without unintended role removal.
- Snapshots and Legacy remain stable across repeated rollover, failure and retry. No out-of-season XP unless explicitly configured.
- Benefits respect non-additive split percentages, eligibility and auditable once-per-season grants; verify exact totals and rounding before enablement.
- Test API authorization, per-tenant isolation, database migration/rollback where supported, idempotency, concurrent requests, audit, role outages, and real Discord retry behavior. Add UI keyboard, responsive and accessibility checks, plus simulator coverage-quality tests.

## Open decisions before affected slices

1. Should Discord rank roles be **display-only/manual** by default, or should auto-sync be enabled by default? If automatic, how are independently assigned roles protected from removal?
2. What is the exact recent-activity threshold for split, regear and priority, and are they the same?
3. Who funds split bonuses and which amount/rounding rule applies? When is eligibility snapshotted?
4. How should individual overrides combine with multiple excluded Discord roles, stale role data, and unknown users?
5. Which existing event records, if any, can be included in historical simulation or migration? Participant lists are not necessarily historical snapshots.
6. How are modified events, cancelled-after-stop events, delayed completion, and end-of-season races handled without double-awarding?
7. For an original guild event, how are participant identities mapped across guild and alliance tenants without awarding the same account twice? The alliance mirror itself must not award XP.
8. Is a manually configured Discord role assignment independent of guild rank, or should an officer also be able to manually override a member's **progression rank**? These are different privileges.

## Handoff to the main thread

This document was prepared in an isolated Delta subthread. The parent must pull this subthread's worktree changes before the file exists in the parent workspace. The user's request is for the parent to start an implementation subthread; the first assignment should be the attendance/XP foundation and a reviewable slice, not the entire economy at once.
