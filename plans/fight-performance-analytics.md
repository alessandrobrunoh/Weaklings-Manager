# Plan: Canonical Fights and Guild Performance Analytics

**Branch**: `feat/fight-performance-analytics`
**Status**: Slice 1 in progress — canonical Fight persistence and Event snapshot reconciliation implemented; final API/UI projection and validation remain.

## Goal

Make a canonical **Fight** the single statistical unit shared by Events, Battles and Intel, grouping one or more AlbionBB battle segments and providing trustworthy, coverage-aware analytics for guild performance, players, observed builds, planned compositions, opponents and trends over time.

## Outcome

An officer can open an Event, Fight, player, build, composition or Intel report and see consistent numbers derived from the same persisted battle evidence. Long fights split by AlbionBB count once, raw battle links remain traceable, estimates disclose their coverage, and trends distinguish observed facts from derived or inferred conclusions.

## Research Findings (verified 2026-09-01)

### The zero-stat bug has a structural cause

`apps/backend/src/modules/events/service.rs` builds event performance from denormalized columns in `event_battles`. `linked_battle_snapshot()` resolves our guild by exact guild ID against the AlbionBB list payload; that payload can be less complete than the detail payload. When the guild is not resolved, the stored player, kill, death and fame values default to zero.

`/battles/:battleId` follows a different path: it hydrates full detail, estimates equipment losses and persists it in `guild_battle_snapshots`. The two pages can therefore show different values for the same AlbionBB battle.

The migration must remove the duplicated analytical authority from `event_battles`; merely patching the UI would leave Events, Battles and Intel inconsistent.

### A temporary client-side battle group already exists

`apps/frontend/src/app/features/battles/battle-group.ts` accepts `?ids=...`, requests every battle separately, then sums values in the browser. The selection flow is exposed from `apps/frontend/src/app/features/battles/battles.ts`.

It is useful as a UI prototype but is not a domain model:

- the grouping is not persisted;
- other pages cannot reuse it;
- it sums player counts instead of counting unique participants;
- it has no authoritative outcome, confidence or event association;
- N battle requests are issued for one page;
- Intel continues counting the raw battle IDs separately.

This route will become a compatibility redirect or be replaced by the persisted Fight detail after Slice 4.

### The detailed snapshot is JSON-heavy

`guild_battle_snapshots` stores guilds, players, kills and losses as JSON text. That is enough to reconstruct current battle details but not efficient for cross-fight player/build/timeline queries. The plan first establishes canonical Fights using the existing snapshots, then normalizes only the evidence needed by real analytics queries.

### Intel currently counts technical battles

`scouted_comp_battles` links directly to an AlbionBB `battle_id`, and `intel/matchups.rs` increments matchups per link. A three-segment fight can therefore become three matchups. Intel must retain raw battle provenance but count distinct canonical Fight observations.

### Existing data already supports useful analytics

Persisted data can support kills, deaths, fame, IP, rosters, guild/alliance participation, timestamps, equipment observed in kill events and market-based estimates. It cannot honestly provide damage, healing, positioning, ability casts or shot-caller compliance unless another source is added later.

Every response and chart must classify metrics as:

- `observed`: directly present in source evidence;
- `derived`: deterministic calculation from observed evidence;
- `inferred`: role, build or composition classification;
- `unavailable`: not present or not sufficiently covered.

### Build versioning is planned separately

`plans/build-swaps-and-abilities.md` introduces build versions, swaps and exact ability choices. Fight analytics must integrate without blocking on that plan:

- `build_fingerprints.matched_build_id` is nullable;
- when versioned builds exist, the match points to the exact build version row;
- historical observed fingerprints remain immutable if an internal build is later edited;
- no analytics migration may reinterpret old evidence silently.

### Frontend constraints

The frontend is Angular 21 with signals, standalone components, native template control flow and lazy routes. Heavy below-the-fold analytical sections should use progressive rendering and, where appropriate, `content-visibility: auto` paired with `contain-intrinsic-size`. Accessibility must remain WCAG 2.2 AA, including keyboard reachability through deferred sections.

### Tooling gap

The planning workflow calls for mutation testing, but no Rust or TypeScript mutation tool is currently configured. Before Slice 1, choose either:

1. add `cargo-mutants` and Stryker in a dedicated tooling change; or
2. record a manual mutator-aware test adequacy review for each slice.

The plan assumes option 2 until explicitly changed.

## Canonical Domain Glossary

- **Battle**: one technical AlbionBB record, identified by the AlbionBB `battle_id`.
- **Fight**: one real combat engagement, composed of one or more Battles.
- **Segment**: UI name for a Battle when displayed inside a Fight.
- **Event**: a guild-organized session that can contain zero or more Fights.
- **Observed build**: equipment actually visible in source evidence for a player.
- **Planned build**: internal build assigned through an event signup or composition slot.
- **Build fingerprint**: immutable normalized equipment identity, excluding mutable market values and optionally excluding tier/enchantment according to the matching mode.
- **Planned composition**: the comp and slot quantities configured for the Event.
- **Observed composition**: roles/builds inferred from players actually observed in the Fight.
- **Coverage**: fraction of the expected evidence that was available for a metric.
- **Confidence**: quality classification derived from coverage, sample size and inference ambiguity; never a substitute for showing those inputs.
- **Player-fight**: one player's aggregated participation in one canonical Fight.

## Product and Domain Decisions

These defaults are proposed by the agreed direction. Confirm them before Slice 1; changing them later requires an explicit plan update.

1. **One Battle belongs to exactly one Fight.** A unique constraint on `fight_battles.battle_id` enforces this globally.
2. **One Fight belongs to zero or one Event.** Unattributed background-sync fights remain valid and can be linked later.
3. **Events count Fights, not Battles.** The UI still reports the raw segment count separately.
4. **Intel matchups count distinct Fights.** Raw source battle IDs remain visible for provenance.
5. **Automatic grouping is conservative.** Ambiguous candidates remain separate and are marked for review rather than silently merged.
6. **Manual grouping wins over automation.** A manual merge/split cannot be reverted by a later sync pass.
7. **Outcome is Fight-level.** Segment winner flags are evidence, not separate wins/losses.
8. **No opaque universal player score.** Show role-aware metric trends and their sample sizes instead of ranking unlike roles by one number.
9. **Individual detailed analytics are officer/admin-only by default.** Members may see their own detail if a self-view permission policy is approved.
10. **Minimum sample defaults**: trend badge at 5 Fights, comparative recommendation at 8 Fights; below the threshold the value remains visible with `low confidence` and cannot drive an alert.
11. **Default comparisons**: last 30 days versus previous 30 days, plus rolling 5-Fight and 10-Fight series.
12. **Market estimates are snapshots, not facts.** Every estimate exposes price timestamp, location/method and item coverage.

## Target Data Model

The exact migration names are assigned when implementation starts, after checking the latest migration sequence.

### Canonical source tables

#### `battles`

- `id BIGINT PRIMARY KEY`: AlbionBB battle ID;
- `started_at`, `ended_at`;
- `total_players`, `total_kills`, `total_fame`;
- `hydration_status`: `pending | complete | failed`;
- `source_updated_at`, `fetched_at`;
- `raw_payload_json TEXT` for forward compatibility;
- `analytics_revision` for invalidation.

`guild_battle_snapshots` is migrated/backfilled into this shape. It may remain as a compatibility table/view until Slice 12.

#### `battle_guild_stats`

One row per Battle and guild with guild/alliance identity, player count, kills, deaths, kill fame, average IP and upstream winner evidence.

#### `battle_player_stats`

One row per Battle and player with stable Albion player identity when available, guild/alliance, kills, deaths, kill/death fame and average IP.

#### `battle_kills`

One row per Albion kill event with Battle, timestamp, killer/victim identity, guild/alliance, IP and fame. Preserve source JSON for unmodelled fields.

#### `battle_kill_items`

One row per observed victim item stack with slot, type ID, quantity, quality/enchantment and source references. Market price fields must be stored in a separate versioned estimate record or carry explicit `priced_at`, location and method metadata.

### Fight tables

#### `fights`

- `id BIGINT PRIMARY KEY`;
- `event_id BIGINT NULL REFERENCES events(id)`;
- `started_at`, `ended_at`;
- `outcome`: `victory | defeat | draw | unknown`;
- `outcome_method`: `derived | manual`;
- `grouping_method`: `automatic | manual`;
- `grouping_confidence` and `grouping_version`;
- `needs_review BOOLEAN`;
- optional officer title/notes;
- `analytics_revision`, `computed_at`, timestamps.

#### `fight_battles`

- `fight_id`;
- `battle_id UNIQUE`;
- `sequence_number`;
- timestamps copied only when they support ordering/indexing;
- primary key `(fight_id, battle_id)`.

### Derived analytical facts

These are rebuildable projections, not independent sources of truth:

- `fight_guild_stats`;
- `fight_player_stats`;
- `fight_build_stats`;
- `fight_comp_stats`;
- `fight_opponent_stats`;
- `fight_timeline_buckets`;
- `build_fingerprints`;
- `analytics_recompute_queue` or equivalent invalidation mechanism.

Every derived row stores `analytics_version`, `computed_at` and the source revision used. A source refresh, Fight merge/split or algorithm version change invalidates and deterministically rebuilds affected projections.

### Intel provenance

Introduce a Fight-level observation link, such as `scouted_comp_fights`, while retaining Battle-level provenance where useful. Matchups and trends query distinct `fight_id`; dossier detail can still list every contributing segment.

## Automatic Grouping Policy

The grouping implementation is a pure, versioned domain function with explainable evidence.

### Hard boundaries

Never auto-merge when:

- two Battles are manually locked to different Fights;
- they are linked to different Events;
- the time gap exceeds the configured maximum;
- source timestamps are invalid or missing enough to make ordering unsafe.

### Positive evidence

Score candidates from:

- same Event;
- overlapping or near-contiguous time range;
- overlap of our observed player IDs;
- overlap of friendly guild/alliance IDs;
- overlap of opponent guild/alliance IDs;
- overlap of opponent player IDs;
- consistent fight-size bracket.

### Proposed conservative defaults

- auto-merge threshold: score at or above 0.80;
- review threshold: 0.55 to 0.79;
- maximum non-overlapping gap: 20 minutes;
- same Event alone is not sufficient when opponent and participant evidence contradicts it;
- missing evidence reduces confidence, not similarity by pretending absence means mismatch.

Thresholds live in one configuration/value object and are persisted through `grouping_version`. Before shipping auto-merge, validate defaults against a production-like sample and record false merges/splits.

### Manual operations

- merge selected Fights/Battles;
- split selected segments into a new Fight;
- move a segment between Fights;
- link/unlink a Fight from an Event;
- set manual outcome and notes;
- audit before/after membership and actor.

Operations are transactional, idempotent where requests can be retried, and trigger projection invalidation.

## Global Acceptance Criteria

### Consistency

- [ ] The same Fight reports identical core totals from `/events/:id`, `/battles`, Fight detail and Intel.
- [ ] A Fight containing three AlbionBB Battles counts as one Fight and three segments everywhere.
- [ ] Raw Battle IDs remain visible and individually traceable.
- [ ] Event statistics no longer depend on denormalized zero-prone columns in `event_battles`.
- [ ] Existing `/battles/:battleId` links continue to open the containing Fight.

### Grouping

- [ ] Every canonical Battle belongs to exactly one Fight after migration.
- [ ] Automatic grouping is deterministic and versioned.
- [ ] Ambiguous grouping is visible as `needs review`, not silently treated as certain.
- [ ] Manual merge/split/move changes persist and are never overwritten by sync.
- [ ] All grouping changes are audit logged.

### Fight analytics

- [ ] Fight detail provides overview, timeline, guild, player, build, composition, opponent and economy sections.
- [ ] Unique player counts are deduplicated across segments.
- [ ] Fight outcome is counted once.
- [ ] Estimates expose priced item count, total item count, percentage, market timestamp and pricing method/location.
- [ ] Heavy sections load progressively without blocking initial Fight summary.

### Player analytics

- [ ] Officers can inspect player-fight history, survival, deaths, fame, kill participation where derivable, IP, estimate and observed builds.
- [ ] Trends compare equivalent periods and show raw sample sizes.
- [ ] Role-specific metrics are not collapsed into a universal ranking.
- [ ] A metric with insufficient evidence is `unavailable` or `low confidence`, never silently zero.

### Build and composition analytics

- [ ] Observed builds use immutable fingerprints and can optionally match an internal build version.
- [ ] Reports distinguish planned build from observed build.
- [ ] Build performance shows player-fights, unique players, Fight record, survival, deaths, economy, IP, matchup and coverage.
- [ ] Planned versus observed composition shows role/build deltas and evidence coverage.
- [ ] A build or Comp with a tiny sample cannot be presented as a confident recommendation.

### Intel

- [ ] Intel matchup totals count Fights, not technical Battles.
- [ ] Officers can compare current and previous periods for guild, opponent, Comp, build and player metrics.
- [ ] Intel identifies strong/weak opponents and matchups with sample size and confidence.
- [ ] Improvement/regression lists explain the changed metrics instead of emitting an opaque score.
- [ ] Every recommendation links to the underlying Fights and source segments.

### Quality, privacy and operations

- [ ] Permissions distinguish general battle viewing, Fight management and detailed player analytics.
- [ ] Migration has pre-flight counts, conflict reporting, dry-run validation and rollback/forward-fix documentation.
- [ ] PostgreSQL production and SQLite tests use portable queries and types.
- [ ] Analytics recomputation is observable, retryable and does not block battle ingestion.
- [ ] WCAG 2.2 AA, keyboard navigation and reduced-motion requirements are verified.

## Slices

Every slice follows RED-GREEN-MUTATE-KILL MUTANTS-REFACTOR. Before production code, load the relevant testing/refactoring guidance and present that slice's acceptance criteria for human confirmation. One slice is one independently reviewable PR and must leave tests green.

### Slice 1: An Event reads one canonical Fight with the same non-zero statistics as its Battle detail

**Value**: Officers stop seeing zero statistics for linked Battles, and the first real production path proves one shared analytical source.

**Path**: persisted `guild_battle_snapshots` and `event_battles` evidence → migration creates `fights`/`fight_battles` and one Fight per existing Battle → event detail resolves canonical snapshot → Fight summary DTO → `/events/:id` overview and Battles tab.

**Intentionally deferred**: no automatic multi-segment merge, normalized kill tables or advanced charts yet.

**Required implementation skills**: `rust-guidelines`, `tdd`, `testing`, `mutation-testing` or approved manual substitute, `refactoring`, `modern-web-guidance` and Angular project rules.

**Acceptance criteria**:

- a linked Battle with non-zero detail returns the same guild kills, deaths, fame, player count and estimate in Event detail;
- missing/partial list payload fields cannot overwrite a complete canonical snapshot with zeros;
- every migrated canonical Battle has one generated Fight and `fight_battles` membership;
- a Battle linked to multiple existing Events is reported by the migration pre-flight and handled by an explicitly approved conflict policy, never assigned arbitrarily;
- events with no linked Battles remain valid and return zero Fights with `no data`, not a failed request;
- current response fields remain available during compatibility rollout.

**RED**: backend integration fixture with a poor AlbionBB summary and rich persisted detail; assert Event and Battle detail totals match. Migration fixture covers zero Battles, one Battle, duplicate Event links and malformed string IDs. Frontend test distinguishes `no data` from an actual zero metric.

**GREEN**: minimal Fight entities/migration/backfill, canonical read service and compatibility mapping in Event detail. Do not normalize JSON yet.

**MUTATE**: target fallback order, `complete` versus `pending` source preference, duplicate-event conflict branch and empty scope.

**KILL MUTANTS**: tests must fail if the poor summary is allowed to replace rich detail or if an unlinked Event receives another Event's Fight.

**REFACTOR**: extract a canonical battle reader only after both Battle and Event paths use it.

**Done when**: Event and Battle detail agree for the fixture, migration checks pass on SQLite and PostgreSQL-compatible SQL, tests/static analysis are green, human approves commit.

### Slice 2: A long engagement is automatically shown as one Fight with several segments

**Value**: Officers see real Fight counts instead of AlbionBB segmentation counts.

**Path**: newly hydrated Battle → pure grouping candidate scorer → transaction creates/joins Fight → recompute summary → Event and Battles list display `1 Fight · N segments` and grouping confidence.

**Acceptance criteria**:

- fixture Battles representing one continuous engagement group into one Fight;
- separate engagements on the same Event remain separate when hard boundaries or low score apply;
- candidate order does not change the grouping result;
- ambiguous candidates remain separate and set `needs_review`;
- grouping evidence and algorithm version are inspectable;
- rerunning sync is idempotent;
- Event record counts one win/loss for the grouped Fight.

**RED**: table-driven domain tests for overlap, short gap, long gap, player/guild overlap, missing evidence, different Event, input reordering and idempotent rerun. Include a chain case A↔B↔C that prevents accidental non-transitive over-merging.

**GREEN**: versioned pure scorer plus conservative grouping orchestration and Fight-level outcome derivation.

**MUTATE**: threshold boundaries, time-gap comparison, set-overlap denominator, hard-boundary precedence and confidence band.

**KILL MUTANTS**: exact tests at threshold minus epsilon, threshold and maximum-gap boundary.

**REFACTOR**: keep scoring evidence typed and serializable; no magic tuple or anonymous numeric array.

**Done when**: deterministic grouping is proven and `/events/:id` plus `/battles` show Fight/segment counts consistently.

### Slice 3: An officer can persistently merge, split and move Fight segments

**Value**: Officers can correct automatic grouping once, and every area respects the correction.

**Path**: Battles/Event Fight management mode → merge/split/move request → permission check → transactional `fights`/`fight_battles` update + audit → invalidation/recompute → updated UI.

**Acceptance criteria**:

- merge combines selected Fights and preserves every segment exactly once;
- split creates a new Fight from selected segments;
- move transfers a segment without duplication;
- empty Fight rows are removed or retained according to one documented rule (proposed: remove unless they carry manual notes);
- Event mismatch, duplicate membership and stale revision return a conflict without partial writes;
- manual grouping is locked against automatic regrouping;
- audit records actor, before/after Fight membership, reason and timestamp;
- controls are keyboard accessible and unavailable without management permission.

**RED**: service tests for each operation, rollback on mid-operation error, stale revision, cross-Event merge and sync-after-manual-edit. Angular tests for selection, confirmation, errors and focus return.

**GREEN**: minimal management endpoints and replace temporary group selection action with persistent merge flow.

**MUTATE**: transaction boundaries, authorization, uniqueness, stale revision and manual-lock checks.

**KILL MUTANTS**: concurrent requests and repeated-submit tests.

**REFACTOR**: share one membership mutation service; do not duplicate logic across Event and Battles handlers.

**Done when**: a correction made from either Events or Battles is immediately visible in Events, Battles and Fight detail.

### Slice 4: A user opens one rich server-aggregated Fight detail while old Battle URLs remain valid

**Value**: The temporary client-side group becomes an authoritative analytical page with one request and stable links.

**Path**: `/battles/:id` → backend resolves Fight ID or containing raw Battle ID → Fight aggregate service → initial summary plus segment list → progressive Angular tabs.

**Acceptance criteria**:

- a raw Battle URL resolves the containing Fight without breaking bookmarks;
- Fight detail returns unique players, guild/alliance totals, K/D, fame, duration, outcome, segments, estimate and data-quality summary;
- player counts are unique across segments rather than summed;
- duplicate kill events present in overlapping source payloads are deduplicated by source event ID;
- segment boundaries appear on the timeline;
- core summary renders before heavy tabs;
- `/battles/group?ids=...` redirects to a persisted Fight where possible or to a management confirmation flow, never silently computes another truth in the browser.

**RED**: aggregate fixture with duplicate players and overlapping kill IDs across three segments; route compatibility tests for Fight ID, Battle ID and unknown ID; frontend loading/error/keyboard tab tests.

**GREEN**: Fight detail endpoint, aggregate DTOs, route resolver and refactored Fight detail shell reusing battle-detail components where sensible.

**MUTATE**: unique-key selection, duration min/max, outcome count-once logic and route resolution precedence.

**KILL MUTANTS**: fixture where Fight ID numerically matches another raw Battle ID must follow an explicit route namespace/precedence decision; prefer an unambiguous `/fights/:fightId` canonical route with `/battles/:battleId` compatibility redirect.

**REFACTOR**: split the current very large battle detail component into focused overview, timeline, roster and economy components only as each is reused.

**Done when**: one canonical Fight page replaces client-side aggregation and existing Battle links still work.

### Slice 5: Fight player, guild and timeline analytics are queryable from normalized evidence

**Value**: Officers can filter and compare many Fights without repeatedly parsing large JSON blobs.

**Path**: Battle hydration → transactional upsert into normalized guild/player/kill facts → projection recompute → Fight detail Players/Guilds/Timeline tabs and API filters.

**Acceptance criteria**:

- normalized rows reproduce snapshot totals for a verified fixture set;
- ingestion is idempotent and updates changed upstream records without duplicates;
- kill timeline supports deterministic minute buckets, cumulative lead, combat intensity and segment boundaries;
- player/guild tables support sorting/filtering/pagination without loading the full JSON payload;
- missing IDs use a documented fallback identity key and expose ambiguity;
- raw JSON remains available for fields not yet normalized;
- a reconciliation report lists mismatches instead of hiding them.

**RED**: ingestion/update/idempotency tests, cross-segment dedupe tests, timeline bucket boundary tests and reconciliation tests with intentionally malformed data.

**GREEN**: normalized migrations/entities, one hydration writer and Fight projection builder.

**MUTATE**: upsert conflict keys, bucket rounding, cumulative sign, identity fallback and reconciliation tolerance.

**KILL MUTANTS**: timestamps exactly on minute/segment boundaries and same-name players in different guilds.

**REFACTOR**: source parsing, identity resolution and projection calculation stay pure where possible; database orchestration stays separate.

**Done when**: Fight detail reads normalized projections and verified totals match the canonical snapshot corpus.

### Slice 6: Officers can evaluate Fight economy with transparent market estimates

**Value**: The guild can understand equipment cost and economic trade without mistaking incomplete prices for exact silver values.

**Path**: observed victim equipment → versioned market-price snapshot → item/player/guild/Fight estimate facts → Economy tab and timeline.

**Acceptance criteria**:

- estimates exist for our guild, friendly side, enemy side and total where evidence permits;
- every estimate exposes priced/total items, coverage percentage, market timestamp, cities/method and status;
- economy tab shows total loss, loss per death, loss per player-fight, largest losses and net economic trade;
- price refresh creates a new estimate revision or an auditable replacement policy; historical report semantics are documented;
- unavailable prices do not become zero-value equipment;
- timeline can plot estimated loss over time;
- Event economy totals equal the sum of its Fight estimates at the selected revision.

**RED**: unpriced item, partial coverage, quantity, duplicate item event, own/enemy scope and price-revision tests. Frontend tests for incomplete-estimate disclosure.

**GREEN**: normalized loss items, price metadata, estimate projection and Economy UI.

**MUTATE**: quantity multiplication, side classification, coverage denominator, revision selection and net-trade sign.

**KILL MUTANTS**: all-unpriced, exactly-one-priced and stale-price fixtures.

**REFACTOR**: one price index and one side-classification policy shared by Fight, Event, regear and Intel where semantics match.

**Done when**: estimates are useful, reproducible and never displayed without quality metadata.

### Slice 7: An officer can inspect role-aware player performance and improvement over time

**Value**: Officers can see who is improving, where a player struggles and whether the conclusion has enough evidence.

**Path**: normalized Fight evidence + Albion account link → `fight_player_stats` → player performance API → `/players/:id/performance` overview, trends, builds, matchups, economy and Fight history.

**Acceptance criteria**:

- player-fight facts aggregate segments once and include observed role/build, kills, deaths, fame, IP, survival, first death, estimate and evidence coverage;
- profile compares last 30 days to the previous 30 and exposes rolling 5/10-Fight series;
- reports include Fight count, observed minutes/evidence count and coverage;
- improvement/regression is expressed per metric, not through a universal score;
- role filter prevents unlike roles being presented as directly comparable;
- unlinked/ambiguous Albion identities are listed in data quality and never merged by display name alone;
- detailed player data follows the approved permissions, including optional self-view behavior;
- metrics not supported by source data are omitted or labelled unavailable.

**RED**: duplicate player across segments, changed guild, linked/unlinked identity, period boundary, five-Fight threshold, role change and missing-build coverage tests. Angular tests for empty/low-confidence/full-data states.

**GREEN**: player projection, trend query and performance page with server-side ranges.

**MUTATE**: period inclusivity, trend delta sign, survival definition, minimum sample and identity join.

**KILL MUTANTS**: same player name with two source IDs and same ID with renamed display name.

**REFACTOR**: create reusable period comparison and confidence types used later by build/Comp/Intel.

**Done when**: an officer can explain a player's trend from underlying Fight rows without unsupported claims.

### Slice 8: Officers can compare observed build performance and match it to internal build versions

**Value**: The guild can distinguish builds that work, builds used in bad matchups and builds that only look poor because of incomplete evidence.

**Path**: observed equipment → immutable normalized fingerprint → optional internal build-version matcher → `fight_build_stats` → build analytics detail and filters.

**Acceptance criteria**:

- fingerprint normalization has an explicit strict and family matching policy for tier, enchantment, quality and optional slots;
- historical fingerprints do not change when an internal build is edited;
- exact internal build version match is preferred; ambiguous matches remain unmatched;
- build report shows Fights, player-fights, unique players, W/L, survival, deaths, fame, IP, estimate, opponents, Comp context and coverage;
- planned and observed build are separate fields;
- performance can be filtered by player, role, opponent, Comp, period and match confidence;
- recommendations require the approved sample threshold and show confidence;
- build usage observed only from a kill/death sample is never reported as full roster coverage.

**RED**: canonical fingerprint fixtures for tier/enchantment variations, slot changes, ambiguous internal matches, planned-versus-observed mismatch and low-sample recommendation.

**GREEN**: fingerprint/matcher domain module, projection and build performance UI; integrate nullable exact version IDs from the separate build-version plan when available.

**MUTATE**: fingerprint included/excluded fields, strict/family mode, ambiguous-match branch and sample threshold.

**KILL MUTANTS**: two internal versions differing by one item/ability and one observed partial loadout.

**REFACTOR**: matching rules remain versioned and explainable; no fuzzy score without surfaced evidence.

**Done when**: every build statistic states what was observed, what was matched and how much evidence supports it.

### Slice 9: An Event compares its planned composition with the composition actually observed

**Value**: Officers can tell whether a Comp failed or whether the roster did not actually field it.

**Path**: Event comp slots + signups + player links → Fight observed player/build/role facts → planned/observed matcher → Event Comp tab and `fight_comp_stats`.

**Acceptance criteria**:

- report shows planned, signed and observed counts by role and build;
- deltas identify missing and overrepresented roles/builds;
- build adherence, role coverage and identity/equipment coverage are separate metrics;
- unmatched observed players/builds remain visible;
- secondary/swap build semantics follow the separate build plan and are not guessed;
- Comp performance can be split by high versus low adherence;
- one player appearing in multiple segments counts once for roster adherence;
- an Event with no Fight evidence says `not observed`, not `0% adherence`.

**RED**: complete Comp, missing healer, extra DPS, substitute build, unlinked player, multi-segment duplicate and no-evidence fixtures.

**GREEN**: comp matcher/projection and Event Comp tab using existing comp/signup relationships.

**MUTATE**: count dedupe, planned/signed/observed source selection, adherence denominator and no-data branch.

**KILL MUTANTS**: exact 90% adherence boundary and a player with primary plus secondary assignment.

**REFACTOR**: share role/build identity types with Intel scouting; do not share business rules unless their semantics are identical.

**Done when**: the Event answers whether the planned Comp was actually fielded and relates adherence to Fight outcome.

### Slice 10: Intel counts canonical Fights and explains opponent matchup performance

**Value**: Officers get correct W/L and matchup counts and can trace every conclusion to real engagements.

**Path**: Fight-level opponent observations → `scouted_comp_fights` → matchup projection by our Comp/build and enemy scout → Intel dossier/dashboard.

**Acceptance criteria**:

- three source Battles in one Fight count as one matchup;
- source segment IDs remain listed for provenance;
- matchup rows show Fights, W/L, K/D, survival, estimate trade, numerical difference, Comp adherence and confidence;
- best/worst opponent and Comp lists require minimum sample and expose it;
- absent Event/Comp attribution remains absent data, not a loss;
- existing scouts are backfilled from raw battle links to distinct Fight links with a reconciliation report;
- recommended counter links to underlying Fights and distinguishes tested from untested similarity.

**RED**: multi-segment Fight, one Battle linked to multiple scout observations, missing Event attribution, mixed opponents and backfill idempotency tests.

**GREEN**: Fight-level scout link, rewritten matchup query/projection and updated Intel dossier.

**MUTATE**: distinct Fight counting, absent-data branch, win/loss aggregation and opponent-side classification.

**KILL MUTANTS**: one Fight with multiple opponent guilds and one opponent observed in several segments.

**REFACTOR**: remove integer/string Battle-ID joins from matchup calculations after canonical foreign keys are available.

**Done when**: Intel and Fight/Event views report the same engagement count and outcomes.

### Slice 11: Intel shows guild, player, build, Comp and opponent improvement over time

**Value**: Officers can identify sustained improvement, regression and weak matchups instead of reading isolated totals.

**Path**: Fight/player/build/Comp/opponent projections → period comparison service → Intel tabs and explainable attention items.

**Acceptance criteria**:

- dashboard supports 30d, 90d, 6m and custom ranges with previous-equivalent comparison;
- charts include rolling Fight-based and calendar-period views where appropriate;
- guild trends cover W/L, K/D, survival, economic trade, IP, roster size, Comp adherence and data coverage;
- player development lists metric-specific improvement/regression with role and sample size;
- build and Comp trends identify matchup-dependent performance instead of only global win rate;
- opponent matrix identifies strong/weak matchups with confidence and links to source Fights;
- attention items are deterministic rules with reasons, thresholds and evidence, not generated prose presented as fact;
- no alert is emitted below the approved sample threshold;
- users can distinguish `stable`, `improving`, `declining`, `insufficient data` without relying only on color.

**RED**: period equivalence, rolling window, threshold, trend direction, opponent/Comp interaction and insufficient-data tests. Angular tests cover keyboard-accessible filters and textual state labels.

**GREEN**: shared period comparison API, Intel performance tabs and deterministic insight rules.

**MUTATE**: comparison direction, window size, threshold equality, percentage-point versus percentage change and stable-band boundaries.

**KILL MUTANTS**: deliberately noisy one-Fight spike and zero-denominator previous period.

**REFACTOR**: reuse typed comparison results across player/build/Comp views; keep display formatting out of domain calculations.

**Done when**: every improvement or weakness is explainable from visible metrics and source Fight links.

### Slice 12: The canonical model becomes the only analytical authority and rollout is operationally safe

**Value**: The system no longer carries two competing truths, and operators can detect/recover from ingestion or recomputation failures.

**Path**: production reconciliation → compatibility telemetry → switch reads → remove/deprecate old analytical columns/paths → background recompute observability and runbook.

**Acceptance criteria**:

- reconciliation compares Battle/Fight/Event/Intel counts, kills, deaths, fame and estimates before final cutover;
- every mismatch is categorized and exportable;
- old `event_battles` analytical columns and direct JSON aggregation paths are removed or formally deprecated after zero unresolved critical mismatches;
- background sync writes canonical evidence first and projections second;
- failed projection jobs retry without duplicating facts or blocking ingestion;
- health/diagnostic output reports pending, failed and stale analytics revisions;
- migration forward-fix and rollback limitations are documented;
- load tests cover large multi-segment Fights and long date ranges;
- frontend heavy sections use progressive rendering with stable intrinsic sizing and verified keyboard traversal;
- API/OpenAPI, user documentation and metric definitions are current.

**RED**: reconciliation mismatch fixtures, projection retry/idempotency, stale revision, large Fight and long-range query benchmarks with agreed budgets.

**GREEN**: cutover flags if needed, diagnostics, cleanup migrations, documentation and performance tuning based on measurements.

**MUTATE**: stale/current revision comparison, retry state transitions and reconciliation equality.

**KILL MUTANTS**: partial writer failure between source persistence and projection enqueue.

**REFACTOR**: delete compatibility code only after telemetry proves it unused; do not retain dead dual-read paths indefinitely.

**Done when**: one canonical model powers all analytics, migration evidence is accepted, operational diagnostics exist and full quality gates pass.

## API Direction

Exact endpoint names may be adjusted to existing router conventions, but use unambiguous canonical resources:

- `GET /api/fights`;
- `GET /api/fights/{fight_id}`;
- `POST /api/fights/merge`;
- `POST /api/fights/{fight_id}/split`;
- `POST /api/fights/{fight_id}/segments/{battle_id}/move`;
- `PATCH /api/fights/{fight_id}` for Event association, notes or manual outcome;
- `GET /api/fights/{fight_id}/players|builds|timeline|economy` if payload size requires split resources;
- `GET /api/users/{user_id}/performance` or a project-consistent player resource;
- `GET /api/comps/builds/{build_id}/performance`;
- `GET /api/comps/{comp_id}/performance` widened to Fight-based analytics;
- `GET /api/intel/performance` with period/filter query parameters.

`GET /api/battles/{battle_id}` remains during rollout and either returns the raw segment resource explicitly or redirects/resolves to the containing Fight according to the Slice 4 compatibility decision.

## UI Information Architecture

### `/battles`

List canonical Fights with segment count, Event, opponent, unique forces, outcome, duration, K/D, estimate and review status. Management mode supports persistent merge/split/move rather than temporary browser aggregation.

### `/fights/:fightId`

Tabs: Overview, Timeline, Players, Guilds, Builds, Composition, Economy, Enemies, Segments/Data Quality. Above the fold contains only identity, outcome, core side-by-side totals and quality summary.

### `/events/:eventId`

Event overview aggregates Fights. The combat tab expands each Fight and lists contributing AlbionBB segments. Composition tab compares planned, signed and observed roster/builds.

### `/players/:playerId/performance`

Tabs: Overview, Trend, Builds, Comps, Matchups, Economy, Fights. Default comparison is last 30 days versus previous 30 with Fight count and coverage always visible.

### Build and Comp detail

Add performance tabs that preserve exact version identity, separate planned from observed usage and disclose sample/coverage.

### `/intel`

Tabs: Overview, Trend, Opponents, Our Comps, Builds, Players, Data Quality. Attention items link to filtered evidence; no unsupported damage/healing claims.

## Analytics Definitions to Lock Before Their Slice

Each definition is documented next to domain code and in user-facing metric help:

- unique participant identity and fallback;
- friendly side versus enemy side;
- Fight start/end and duration across overlapping segments;
- Fight outcome derivation and manual override;
- kill-event deduplication;
- survival when a player is only partially observed;
- kill participation supported by available kill-assist/group-member evidence;
- early-death time window;
- IP aggregation weighting;
- strict/family build fingerprint modes;
- observed role inference and ambiguity;
- Comp adherence denominator;
- economic side classification and net-trade sign;
- price revision selection;
- percentage change versus percentage-point change;
- confidence bands and minimum sample.

## Rollout and Migration Safety

1. Pre-flight production data counts and conflicting Event links.
2. Additive canonical tables and one-Fight-per-Battle backfill.
3. Dual-read comparison only, never dual-write without reconciliation.
4. Switch one vertical path at a time: Event → grouping → Fight detail → normalized projections → analytics → Intel.
5. Export mismatch reports before destructive cleanup.
6. Preserve raw AlbionBB payloads and source IDs throughout migration.
7. Avoid SQL casts between string/integer IDs by migrating to canonical typed foreign keys.
8. Keep SQLite test portability; use PostgreSQL-specific optimization only behind tested adapters or after a documented support decision.
9. Cleanup only in Slice 12 after accepted evidence.

## Observability

Record structured metrics/logs for:

- Battles fetched, hydrated, failed and retried;
- grouping decisions by confidence band and version;
- manual merge/split/move operations;
- projection queue age, retries and failures;
- stale analytics revisions;
- snapshot-to-normalized reconciliation mismatches;
- estimate price coverage;
- unmatched player identities and build fingerprints;
- API latency by Fight detail section and Intel range.

No player-sensitive metric values belong in general application logs.

## Test Strategy

- Pure Rust unit tests for grouping, identity, aggregation, trend and confidence rules.
- SeaORM integration tests on in-memory SQLite for migrations, constraints, transactions and service paths.
- PostgreSQL migration dry-run in the available CI/deployment environment before production cutover.
- API integration tests for permissions, compatibility routes and pagination/filtering.
- Angular Vitest component tests for states, filters, tables, tabs, keyboard behavior and metric disclosure.
- Reconciliation fixtures built from realistic multi-segment snapshots.
- Property-based tests are desirable for grouping invariants and aggregation conservation if adding a test-only dependency is approved.
- Performance budgets must be measured and agreed before Slice 12; do not invent passing thresholds after implementation.

## Pre-PR Quality Gate

Before each slice PR:

1. Human confirms that slice's acceptance criteria before production code.
2. Relevant RED test fails for the expected reason before GREEN implementation.
3. Mutation testing or documented manual mutator-aware review is complete.
4. `cargo fmt --check` passes.
5. Targeted backend tests pass, followed by broader `cargo test --workspace` when practical.
6. `cargo clippy --workspace --all-targets --all-features -- -D warnings` passes or any pre-existing blocker is reported separately.
7. Targeted frontend tests pass, followed by `npm test` and `npm run build` in `apps/frontend` for UI slices.
8. Migration dry-run/reconciliation checks pass for schema slices.
9. WCAG 2.2 AA, keyboard/focus and non-color state checks pass for UI slices.
10. Metric glossary and OpenAPI types remain aligned.
11. Work and mutation report are presented; no commit without explicit human approval.

## Dependencies and Coordination

- Coordinate observed/internal build matching with `plans/build-swaps-and-abilities.md`; do not duplicate build version semantics.
- Regear and Event estimate calculations currently consume Battle snapshots. Their migration must be included when the canonical economy projection becomes authoritative.
- Existing Intel scout fingerprints merge observations across Battles. Fight migration must preserve source provenance and avoid multiplying historical scout counts.
- Existing large `battle-detail.ts` and `event-detail.ts` components should be decomposed incrementally as slices introduce reusable sections, not rewritten wholesale before a visible behavior ships.

## Explicitly Out of Scope

- Damage and healing meters without a verified source;
- player positioning or movement heatmaps without combat-log/VOD telemetry;
- ability-cast accuracy or cooldown usage;
- AI-generated coaching presented as factual analysis;
- public global player leaderboards;
- automatic disciplinary action from performance analytics;
- live combat tracking during a Fight;
- replacing AlbionBB as the raw evidence provider.

---

*Delete this file when every slice is complete. If `plans/` becomes empty, delete the directory.*

