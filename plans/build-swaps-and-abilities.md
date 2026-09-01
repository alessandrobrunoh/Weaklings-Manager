# Plan: Build Identity, Versioning, Swaps and Ability Selection

**Branch**: feat/build-swaps-and-abilities
**Status**: Active — slices 1-6 implemented and green; 7-11 not started. Nothing committed.

## Goal

A build or comp is identified by name **and** category, can be versioned (v1, v2, v3 …) with per-version statistics, can carry one swap loadout, and records the exact Albion abilities to slot for every equipped item.

## Research Findings (verified 2026-09-01)

### Comp editing already exists — no work needed

`/comps/:compId` already has a full edit mode. `comp-detail.ts` implements `addBuild()`, `saveBuildQty()` and `removeBuild()` against endpoints that already exist in `comps/router.rs:111-114`:

- `POST /api/comps/{id}/builds` — add a build with a quantity
- `PATCH /api/comps/{id}/builds/{build_id}` — change the quantity
- `DELETE /api/comps/{id}/builds/{build_id}` — remove the build

Every control is gated on `canManage()` → the `comps.comps.manage` permission, **and** on `mode() === 'edit'` (the "Edit" button in the page header toggles it). If the buttons are not visible, the cause is one of those two gates, not a missing feature.

**Open question for the human:** is this actually missing for you, or is it a permission/discoverability problem? No slices are planned for it until that is answered.

### Identity: there is no uniqueness constraint today, on anything

`m20260710_000005_create_builds_table` and `m20260710_000007_create_comps_table` create only non-unique indexes on `role` and `category_id`. `comps/service.rs` never checks for a duplicate name. So today you can already create ten builds called "Pole Hammer" in the same category, and nothing stops it.

Adding `UNIQUE (name, category_id)` is therefore a **tightening of existing data**, not a new field. The migration will fail on any pre-existing duplicate. It needs a pre-flight query and a documented resolution policy — see Slice 1.

### Identity vs. versioning — a direct conflict that has to be resolved

"Unique by (name, category)" and "v1/v2/v3 of the same build" contradict each other: every version of "Pole Hammer | Crystal" carries the same name and the same category.

**Resolution chosen: `UNIQUE (name, category_id, version)`.**

- "Pole Hammer | Crystal" and "Pole Hammer | Kite" coexist — different categories.
- "Pole Hammer | Crystal v1/v2/v3" coexist — same pair, different version.
- A second, unrelated "Pole Hammer | Crystal" cannot be created, because it would collide at v1.
- The version group *is* the `(name, category_id)` pair. No extra `version_group_id` column, no join table.

Consequence to accept deliberately: **renaming or recategorising must move the whole group at once**, otherwise a rename splits versions across two identities. Slice 5 makes rename group-wide.

Alternative rejected: a separate `build_lines` parent table holding name/category with `builds` as version rows. It is the textbook-correct normalisation, but it rewrites every `build_id` foreign key in `comp_builds`, `event_signups` and `regear_items` for a property the `(name, category, version)` index already guarantees.

### `comps.parent_id` already exists and already does half of this

`comps.parent_id` (`m20260711_000001`) is live: `comp-detail.ts:695` `cloneComp()` creates a copy with `parent_id: comp.id`, and the page header renders a "↑ parent" link. This is an informal variant tree that overlaps with versioning.

**Open question for the human:** should versions replace `parent_id`, or coexist with it (parent = "a different comp derived from this one", version = "the same comp, revised")? Slices assume **coexist**, because `parent_id` is already populated in production data and repurposing it silently would reinterpret existing rows.

### Per-version statistics: free for comps, does not exist for builds

**Comps — already works.** `events/service.rs:835 get_comp_performance` filters `events.comp_id == comp_id`, collects `event_battles`, and aggregates. Because a version will be its own `comps` row, `GET /api/comps/{id}/performance` returns that version's stats with **zero backend changes**. Only a version-comparison view is new work.

**Builds — nothing exists.** There is no build performance endpoint of any kind. Two ways to build one, with very different costs and very different honesty:

| Option | Source | What it actually measures | Cost |
|---|---|---|---|
| **A — association** | `event_signups.primary_build_id` / `secondary_build_id` → the event's `event_battles` rows | "Events this build was signed up for were won 62% of the time." It is a property of the *event*, not the build. Ten builds in one event all get the same number | Low |
| **B — attribution** | `guild_battle_snapshots.players_json` → `BattlePlayer { name, kills, deaths, kill_fame, death_fame, item_power }`, joined to the signed-up user via the Albion account link | Real per-player K/D and fame for the players who ran that build | Medium — but the name→user join is **already implemented** in `intel/report.rs:653,1028`, matching on lowercased `albion_player_name` |

Option A risks shipping a number that looks like build performance and is not. Slices below take **Option B**, reusing the existing linking helper, and Slice 8 states the coverage caveat (players without a linked Albion account are excluded and the sample size must be shown).

### Ability data source

| Question | Answer |
|---|---|
| Where do abilities live? | `ao-bin-dumps` → `items.json`, per item under `craftingspelllist` |
| Tier handling | Higher tiers carry `craftingspelllist: {"@reference": "T<n-1>_<BASE>"}` — resolve the chain. Abilities are identical across all tiers of a base, so the dataset is keyed by tier-stripped base identifier, matching `albionSpecializationIdentifier()` |
| Active vs passive | **Not** derivable from `@slots`. Classify by which node the spell sits in inside `spells.json` (`activespell` / `passivespell` / `togglespell`) |
| `@slots` semantics | The slot index *within its kind*, omitted when there is only one slot of that kind. Weapons: 3 active slots (actives carry `@slots` 1/2/3), 1 passive slot (passives omit it). Chest armor: 1 active slot (actives omit it), 2 passive slots (passives carry `@slots` 1/2). Head/shoes: 1 + 1, both omit |
| Slot counts | Read `@activespellslots` / `@passivespellslots` off the item — never hardcode |
| Names | `localization.xml` (TMX), key `@SPELLS_<ID>`, but **must honour `@namelocatag`** on the spell when present — 49 of 350 spells resolve only through it |
| Descriptions | Only ~120 of 350 have EN text, and it is templated game markup (`[dmg]$$SPELL.attributechangeovertime[0].change$[/dmg]`). **Out of scope** — v1 ships name + icon + cooldown/energy |
| Icons | `https://render.albiononline.com/v1/spell/<SPELL_ID>.png` — the same CDN already used for item icons. Probed all 363: **361 return 200**; the 2 failures (`PASSIVE_SHOES_YIELD_ROCK_T4`, `PASSIVE_SHOES_YIELD_WOOD_T4`) are gatherer-shoes passives. Needs an `onerror` fallback anyway |
| Coverage | All **235** weapon/armor bases in `catalog.json` resolve. 0 unresolved, 0 anomalies, 0 missing names |
| Size | **168 KB minified** (vs. 780 KB for `catalog.json`) — bundling it the same way is proportionate |
| Off-hands / capes / bags | `@activespellslots: 0`. Artifact capes carry exactly one fixed passive; nothing to choose. **No ability picker on those slots** |

Keybind labels, confirmed against the Albion wiki and community docs: **Q / W / E** = weapon active slots 1/2/3, **D** = head, **R** = chest, **F** = shoes.

Shapeshifter staves (`2H_SHAPESHIFTER_*`) live under `transformationweapon` and resolve correctly, but only their *human-form* spells are in the list; the transformed-form bar is a separate item. Noted, deliberately out of scope.

### Swap semantics

Community usage of "swap" is an alternative partial loadout carried for a specific matchup — most often a different weapon and off-hand, with its own ability choices. Modelling it as *any subset of slots* rather than weapon-only costs nothing extra and matches how guilds write comps.

Adjacent prior art already in the schema: `event_signups.secondary_build_id` lets a participant declare a second build for an event. That is a *different* concept (two whole builds for one player) and is left alone.

### Schema constraints found

- `build_items` has `UNIQUE (build_id, slot)` (`m20260710_000006`). A swap therefore **requires a migration**. Chosen shape: add `loadout TEXT NOT NULL DEFAULT 'main'`, drop `idx_build_items_build_id_slot_unique`, recreate as `UNIQUE (build_id, loadout, slot)`. Existing rows backfill via the default, so the read path keeps working before the API changes.
- Rejected alternative: synthetic slot names (`weapon_swap`, …). It doubles the `BuildSlot` enum, leaks into `regear/slots.rs`, and makes "show me the swap" a string-prefix query.
- `comps/service.rs:577` already refuses to delete a build referenced by any comp. Version deletion must respect the same rule per version.

### Slice ordering rationale

Versioning is scheduled **after** swaps and abilities on purpose. "Create v2" is a deep copy, and the thing being copied is `build_items` + the swap loadout + `build_item_spells`. Building the copy before those tables exist means writing it twice and shipping a v2 that silently drops the parts added later.

### Tooling gap

The `planning` skill's TDD loop requires a MUTATE step, but this repo has **no mutation testing tool configured** (no `cargo-mutants`, no Stryker; frontend is `vitest run`, backend is `cargo test`). Decide before Slice 1: install the tools, or run MUTATE as a manual test-adequacy review. Slices assume the manual review until told otherwise.

## Acceptance Criteria

**Identity**
- [ ] Two builds may share a name when their categories differ ("Pole Hammer | Crystal" and "Pole Hammer | Kite")
- [ ] Two builds may not share both name and category at the same version
- [ ] The same rules apply to comps
- [ ] A rejected duplicate returns a 409 with a message naming the conflict, not a 500 from the DB

**Versioning**
- [ ] Any build or comp can spawn a new version; versions number v1, v2, v3 … within their (name, category) group
- [ ] A new version is a full copy — items, swap loadout, ability choices for builds; build entries and quantities for comps
- [ ] Each version can be edited and deleted independently; deleting one never touches another
- [ ] Deleting a version still refuses when a comp references that specific build version
- [ ] Every existing build and comp reads back as v1 with no user action
- [ ] Each version shows its own statistics, and versions can be compared side by side
- [ ] Renaming or recategorising moves the whole version group together

**Swap**
- [ ] A build holds exactly one swap loadout; the UI never offers a second
- [ ] Any equipment slot can be filled in the swap, independently of the main loadout
- [ ] Builds saved before this change keep rendering unchanged, with their items in the main loadout

**Abilities**
- [ ] For an equipped weapon, an officer chooses one ability per active slot (Q/W/E) and one passive, restricted to that weapon's real Albion options
- [ ] For head, chest and shoes, an officer chooses the active (D/R/F) and each passive slot's ability
- [ ] Slots with no choices show no ability picker
- [ ] Changing the item in a slot clears ability choices the new item does not offer
- [ ] Without `comps.builds.manage`, chosen abilities render read-only with names and icons
- [ ] The ability dataset is bundled, not fetched from a third party at runtime


## Deviations From The Approved Plan

**Slices 2 and 3 were merged.** The plan sliced "swap weapon only" before "swap, every slot". On
opening `shared/components/equipment-grid`, the grid turns out to be a fixed 3×3 paper-doll with a
per-slot CSS class and a hardcoded slot order; a weapon-only swap would have meant building a
throwaway single-slot UI that Slice 3 immediately deletes. The backend was written loadout-generic
either way, so the merged slice delivers a superset of both at less total cost. Every acceptance
criterion from both slices is still met and tested.

**Two pre-existing failures had to be fixed first**, because `cargo test` did not compile at HEAD
and no backend test could run:
- `intel/report.rs` test fixtures were missing `updated_at` on `split::Model` and
  `transaction::Model` (4 initializers), left behind when the column was added.
- `m20260831_000010_add_fee_to_splits` failed on a fresh database with `duplicate column name: fee`,
  because `m20260709_000001_create_splits_table` was later amended to declare `fee` inline. Guarded
  with `has_column` so both fresh and existing databases apply.

Neither is related to this feature; both are noted here so they are not mistaken for it in review.

## Slices

Every slice follows RED-GREEN-MUTATE-KILL MUTANTS-REFACTOR. No production code without a failing test.
Read `AGENTS.md`, `apps/frontend/AGENTS.md` and `PRODUCT.md` before writing slices.

### Slice 1 ✅ DONE: A build or comp is identified by name + category, and duplicates are refused

**Value**: Officers can finally name builds by weapon and distinguish them by category, instead of inventing "Pole Hammer 2".
**Path**: Create/rename form → `POST|PATCH /api/comps/builds` → uniqueness check → 409 with a readable message → inline field error.
**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`.
**Acceptance criteria**:
- A pre-flight migration step reports any existing `(name, category_id)` duplicates before the index is created; the migration fails loudly with the offending rows rather than silently renaming production data
- `UNIQUE (name, category_id, version)` exists on `builds` and on `comps` (the `version` column lands here, defaulting to 1, so the index never has to be rebuilt in Slice 5)
- Creating a second "Pole Hammer" in category "Crystal" returns **409**, not 500
- Creating "Pole Hammer" in category "Kite" succeeds
- Renaming a build into an existing pair returns 409 and leaves the row untouched
- Comparison is trimmed; leading/trailing whitespace cannot create a near-duplicate. Case sensitivity is a decision to record, not to leave to the database collation
**RED**: service tests for create-duplicate → 409, create-same-name-other-category → 201, rename-into-conflict → 409 + unchanged row, and whitespace-only difference → 409. The trim and the case decision are single expressions and are exactly what a mutation flips, so each gets its own test.
**GREEN**: `version` column (default 1) + unique indexes on both tables; a shared `ensure_unique_name` helper in `comps/service.rs`; map the DB unique violation to `AppError::Conflict` as a backstop for races.
**MUTATE**: per the tooling decision above.
**KILL MUTANTS**: expect survivors on the trim and on the self-exclusion in the rename check (`id != self.id`) — a build must not conflict with itself.
**REFACTOR**: only if the build and comp helpers are genuinely identical.
**Done when**: all criteria met, mutation report reviewed, human approves commit.

### Slice 2 ✅ DONE (merged with Slice 3): An officer fills a swap loadout on a build

**Value**: Officers can express "bring a Realmbreaker as your swap" in the tool instead of in a Discord message.
**Path**: `/comps/builds/:buildId` edit mode → `PUT /api/comps/builds/{id}/items/weapon?loadout=swap` → `build_items` row with `loadout='swap'` → `BuildDetail.items[].loadout` → a second equipment row under "Swap".
**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`.
**Acceptance criteria**:
- Migration adds `loadout` defaulting to `'main'`; every pre-existing row reads back as `'main'`
- `UNIQUE (build_id, loadout, slot)` holds
- `PUT .../items/{slot}` with no `loadout` param still writes the main loadout (existing clients unaffected)
- `PUT .../items/weapon?loadout=swap` creates a swap row without touching the main weapon
- `DELETE .../items/weapon?loadout=swap` removes only the swap row
- An unknown `loadout` value is rejected with 400, not silently coerced
- The Swap section shows only when the build has a swap item, or when in edit mode
- Deleting the build removes both loadouts' rows
**RED**: `comps::service` tests for upsert/remove scoped by loadout, the "swap does not clobber main" case, and the rejected-unknown-loadout case; a `BuildLoadout::from_str` round-trip test (the `_ => Err` arm and the `'main'` default are prime mutants). Frontend vitest: a `BuildDetail` with mixed loadouts groups into two sections.
**GREEN**: `BuildLoadout` enum in `comps/status.rs` mirroring `BuildSlot`; migration; `loadout` threaded through `upsert_build_item`/`remove_build_item`/`BuildItemSlot`; weapon-only swap row in `comp-build-detail.ts`.
**MUTATE / KILL MUTANTS / REFACTOR**: as above.
**Done when**: all criteria met, human approves commit.

### Slice 3 ✅ DONE (merged into Slice 2)

**Value**: Guilds that swap off-hand or armor, not just weapon, can express the real loadout.
**Path**: Same as Slice 2, widened — the Swap section renders the full `SLOT_ORDER` grid via the existing `EquipmentGrid`.
**Acceptance criteria**:
- Every slot in `SLOT_ORDER` is fillable and clearable in the swap loadout
- The main loadout's behaviour is unchanged
- An empty swap renders as an empty state, not ten blank rows, in view mode
**RED**: parameterised frontend test over all ten slots; service test that a build with items in both loadouts returns them grouped and deterministically ordered.
**GREEN**: reuse `EquipmentGrid` with a `loadout` input.
**Done when**: all criteria met, human approves commit.

### Slice 4 ✅ DONE: An officer picks the weapon's Q/W/E and passive from that weapon's real options

**Value**: The single highest-value part of the request — a build finally says which spells to slot.
**Path**: Bundled `abilities.json` → `GET /api/openalbion/abilities` → build page reads the equipped weapon's base identifier → picker per slot → `PUT /api/comps/builds/{id}/items/{slot}/spells` → `build_item_spells` rows → icon + name under the weapon.
**Acceptance criteria**:
- `abilities.json` is generated by a committed, re-runnable script from `ao-bin-dumps`, so it can be refreshed on an Albion patch
- Dataset keys match `albionSpecializationIdentifier()` output exactly, for all 235 bases
- Slot counts come from `@activespellslots`/`@passivespellslots`, never hardcoded
- Selecting an ability the equipped item does not offer is rejected with 400
- Labels read Q / W / E for active slots 1/2/3 and "Passive" for the passive slot
- Icons load from the Albion spell CDN with a graceful fallback when a sprite 502s
- Changing the weapon clears choices the new weapon does not offer
- Without `comps.builds.manage`, abilities render read-only
**RED**: a dataset-integrity test asserting all 235 bases resolve, every referenced spell has a non-empty name, and no base declares a slot index above its slot count — this is what catches a bad regeneration after a patch. Service tests for reject-invalid-spell and clear-on-item-change. Frontend test that a two-active-slot item renders two pickers, not three.
**GREEN**: generator script + `abilities.json` + `GET /openalbion/abilities`; `build_item_spells` (`build_item_id` FK cascade, `kind`, `slot_index`, `spell_id`, unique on the first three); weapon picker UI.
**KILL MUTANTS**: boundary tests at `slot_index = active_slots` and `= active_slots + 1`.
**Done when**: all criteria met, human approves commit.

### Slice 5 ✅ DONE: Head, chest and shoes get their ability pickers

**Value**: The build covers the whole ability bar, which is what makes it copyable in game.
**Acceptance criteria**:
- Head shows 1 active (**D**) + 1 passive; chest shows 1 active (**R**) + **2** passives; shoes show 1 active (**F**) + 1 passive — driven by the dataset, so an Albion patch that changes a count needs only a regeneration
- Off-hand, cape, bag, potion, food and mount show no picker at all
- The full ability bar renders in one readable row in view mode
**RED**: a test asserting chest renders exactly two passive pickers and off-hand renders zero — the asymmetry is the point of the slice.
**GREEN**: drop the weapon-only guard; drive purely off `active_slots`/`passive_slots`.
**Done when**: all criteria met, human approves commit.

### Slice 6 ✅ DONE: The swap loadout carries its own ability choices

**Value**: A swap weapon showing the main weapon's spells is wrong information.
**Path**: `build_item_spells` hangs off `build_item_id`, so swap items get their own rows for free — this slice is the UI plus the tests that prove isolation.
**Acceptance criteria**:
- Editing a swap ability leaves the main loadout untouched, and vice versa
- Clearing a swap item removes its ability rows
**RED**: service test with the same base identifier in both loadouts and different spells in each — the case a naive `build_id + slot` lookup gets wrong.
**Done when**: all criteria met, human approves commit.

### Slice 7: An officer creates v2 of a build and edits it without touching v1

**Value**: The variant workflow the request is really about — try a change without losing the version people already run.
**Path**: Build page → "New version" → `POST /api/comps/builds/{id}/versions` → deep copy of the row, `build_items` (both loadouts) and `build_item_spells`, with `version = max(version) + 1` in the group → redirect to the new version → version switcher on the page.
**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`.
**Acceptance criteria**:
- The copy carries every item in **both** loadouts and every ability choice; no field is silently dropped
- Version numbers are contiguous per `(name, category_id)` group and assigned under the unique index, so two concurrent requests cannot both produce v2
- Editing v2 leaves v1 byte-for-byte unchanged
- Deleting v2 leaves v1 intact; deleting a version referenced by a comp is refused with 409, reusing the existing rule at `comps/service.rs:577`
- Deleting the last remaining version of a group deletes the group — there is no build with zero versions
- The build page shows a version switcher listing every version in the group
- Renaming or recategorising updates every version in the group in one transaction, and is refused with 409 if the new pair is taken
- Every pre-existing build reads back as v1 without a data migration beyond the column default
**RED**: a copy-completeness test that builds a fixture with both loadouts and abilities in every slot, creates a version, and asserts field-by-field equality of the copy — written so that adding a future column to `build_items` fails it rather than passing silently. Concurrency test on version assignment. Rename-cascade test asserting all versions moved. Delete-last-version test.
**GREEN**: `POST /{id}/versions`, a `clone_build_tree` service function, group-wide rename in `update_build`, version switcher UI.
**MUTATE**: expect survivors on `max(version) + 1` and on the group-scoping predicate.
**KILL MUTANTS**: a test with two groups present, asserting v-numbering does not leak across them.
**REFACTOR**: assess whether `cloneComp()`'s existing frontend logic and this share a path.
**Done when**: all criteria met, human approves commit.

### Slice 8: Each build version shows its own statistics

**Value**: "v2 wins more than v1" is the reason to version anything.
**Path**: `GET /api/comps/builds/{id}/performance` → `event_signups` where `primary_build_id` or `secondary_build_id` is this version → those events' `guild_battle_snapshots` → `players_json`, matched to signed-up users via the existing Albion account link → aggregated K/D, fame and win rate.
**Required implementation skills**: `tdd`, `testing`, `mutation-testing`, `refactoring`.
**Acceptance criteria**:
- Stats are scoped to one build version; v1 and v2 of the same group report different numbers
- The player→user match reuses the lowercased-name helper already used in `intel/report.rs:653,1028` rather than a second implementation
- The response carries the sample size (events, battles, matched players) and the **number of signed-up players with no linked Albion account**, so a thin sample is visibly thin
- A version with no events returns an empty result, not a zeroed one that reads like a 0% win rate
- Secondary-build signups are counted, and the response says whether a number came from primary or secondary use
**RED**: fixture with two versions, overlapping events, one unlinked player; assert per-version separation, correct exclusion of the unlinked player, and that the exclusion count is reported. Empty-history test asserting "no data" is distinguishable from "0%".
**GREEN**: the endpoint plus a `build_performance` service function; extract the name-matching helper if it is not already reusable.
**KILL MUTANTS**: expect survivors on the primary/secondary OR condition and on the empty-vs-zero branch.
**Done when**: all criteria met, human approves commit.

### Slice 9: An officer creates a comp version and reads its statistics

**Value**: Comp versions are what actually get compared after a fight night.
**Path**: Comp page → "New version" → `POST /api/comps/{id}/versions` → copy the comp row and its `comp_builds` entries → version switcher → the **existing** `GET /api/comps/{id}/performance`, which needs no change because a version is its own `comps` row.
**Acceptance criteria**:
- The copy carries every `comp_builds` entry with its quantity
- `parent_id` is preserved on the copy — a version of a variant is still a variant of the same parent
- Each version's `/performance` reflects only the events linked to that version
- The version switcher and the parent link coexist without ambiguity in the header
- Deleting a version does not orphan comps whose `parent_id` points at it
**RED**: copy-completeness test over `comp_builds`; a test that an event linked to v1 does not appear in v2's performance; an orphaned-parent test.
**GREEN**: `POST /{id}/versions` for comps, reusing the build version helper's shape.
**Done when**: all criteria met, human approves commit.

### Slice 10: Versions can be compared side by side

**Value**: The comparison is the decision-making moment; a switcher alone makes officers hold two pages open.
**Path**: Version switcher → "Compare" → two versions' `/performance` results in one table, plus a diff of what changed between them.
**Acceptance criteria**:
- Two versions of a build or comp render side by side with their stats
- The equipment/ability diff (or, for comps, the build-and-quantity diff) is shown, so a win-rate gap has a visible cause
- Versions with no data are labelled as such rather than shown as losing
- Meets WCAG 2.2 AA: the diff is not conveyed by colour alone
**RED**: frontend test that a version with no events renders "no data" and not "0%"; diff test over an added build, a removed build and a changed quantity.
**Done when**: all criteria met, human approves commit.

### Slice 11: The comp detail page shows each build's abilities without navigating away

**Value**: The audience is the member reading the comp before a fight, not the officer authoring it.
**Acceptance criteria**:
- Each build row shows its ability icons read-only, names on hover and as accessible text
- A build with no chosen abilities shows nothing rather than empty placeholders
- The added rendering does not change the existing `compositionStats` output
- Meets WCAG 2.2 AA: icons are not the only carrier of meaning, contrast holds in both themes
**RED**: frontend test that a comp with one ability-less build and one fully-specified build renders exactly one ability strip.
**Done when**: all criteria met, human approves commit.

## Pre-PR Quality Gate

Before each PR:
1. Mutation testing — per the tooling decision recorded above
2. Refactoring assessment — run `refactoring` skill
3. `cargo check` + `cargo test` (backend), `npx tsc --noEmit` + `npx vitest run` (frontend)
4. AXE pass on any changed screen, per `apps/frontend/AGENTS.md`

## Resolved Decisions

Approved 2026-09-01. Every open question took the recommended option.

1. **Comp editing** — already implemented; no slices. If the buttons are not visible it is the `comps.comps.manage` permission or the header's Edit toggle.
2. **`parent_id` vs. versions** — they coexist. `parent_id` keeps meaning "a different comp derived from this one"; `version` means "the same comp, revised". Existing rows are not reinterpreted.
3. **Name comparison** — case-insensitive and trimmed. "pole hammer" collides with "Pole Hammer". Enforced in the service on a normalised form, not left to the database collation, so behaviour is identical on every backend.
4. **Existing duplicates** — the migration fails loudly and names the offending rows. No automatic renaming of production data.
5. **Build statistics** — Option B, real per-player attribution via `guild_battle_snapshots.players_json` joined through the existing Albion account link, with the unlinked-player count reported.
6. **Mutation tooling** — no tool installed; MUTATE runs as a manual test-adequacy review, recorded per slice.
7. **Swap naming** — one unnamed swap loadout.
8. **Dataset refresh** — manual, via a committed re-runnable generator script, matching how `catalog.json` is maintained today.

---
*Delete this file when the plan is complete. If `plans/` is empty, delete the directory.*
