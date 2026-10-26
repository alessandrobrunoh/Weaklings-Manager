# Data-generation scripts

## Overview

These offline utilities regenerate bundled Albion item, ability, and combat data from the
community game-data dumps. The application reads the checked-in JSON outputs at runtime; it does
not run these generators or fetch the source dumps as part of normal application operation.

## Interface

- `albion_dumps.py` provides `fetch`, `load_json`, `dumps_commit`, `load_localization`,
  `index_items`, `index_spells`, `resolve_spell_list`, and `base_identifier` for the generator
  scripts.
- `generate_albion_abilities.py` builds the bundled ability catalog.
- `generate_albion_combat_data.py` builds item, spell, and global combat-rule datasets.

## Invariants

- Spell references and tier/enchantment identifiers are resolved during generation so runtime
  consumers can use normalized bundled records.
- Generators validate their inputs and refuse to write outputs when detected data inconsistencies
  would produce incomplete or misleading catalogs.
- Generated files are application data, not runtime code; keep the generator's output paths aligned
  with the backend's data consumers.

## Side Effects

- The scripts download source dumps and commit metadata from GitHub when the local cache does not
  contain the required data.
- Downloads are cached under the repository's ignored `.albion-dumps-cache/` directory.
- Running the generators writes JSON files under `apps/backend/src/modules/openalbion/` and
  `apps/backend/src/modules/combat/data/`.

## Verification

No automated test command is configured specifically for this utility directory.
