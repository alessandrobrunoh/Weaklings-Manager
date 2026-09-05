#!/usr/bin/env python3
"""Regenerates the bundled Albion ability catalog from the community binary dumps.

The app never calls a third-party service at runtime — like `catalog.json`, the ability list is
bundled and refreshed by hand when Albion patches. Run this after a patch:

    python3 scripts/generate_albion_abilities.py

It writes `apps/backend/src/modules/openalbion/abilities.json`, keyed by the tier-stripped base
identifier so one entry serves all eight tiers (a T4 and a T8 Broadsword offer the same spells).

Three source files, three separate reasons:

* `items.json` — which spells an item offers, under `craftingspelllist`. Higher tiers carry
  `{"@reference": "T<n-1>_<BASE>"}` instead of a list, so the chain has to be resolved.
* `spells.json` — whether a spell is active or passive. This is NOT derivable from the item entry:
  on a weapon the actives carry `@slots` and the passives do not, while on chest armor it is the
  other way round. `@slots` is the index *within its kind*, omitted when the item has only one slot
  of that kind.
* `localization.xml` — the player-facing name. The key is `@SPELLS_<ID>`, except where the spell
  declares a `@namelocatag` pointing elsewhere; 49 of 350 spells resolve only through that.

Slot counts come from `@activespellslots` / `@passivespellslots` on the item and are never assumed,
so a patch that changes a count needs only a regeneration.

Downloading, caching, the localization scan and the `craftingspelllist` resolver are shared with
`generate_albion_combat_data.py` and live in `albion_dumps.py`.
"""

from __future__ import annotations

import collections
import json
import sys

from albion_dumps import (
    ACTIVE_KINDS,
    REPO_ROOT,
    base_identifier,
    index_items,
    index_spells,
    load_json,
    load_localization,
    resolve_spell_list,
)

CATALOG = REPO_ROOT / "apps/backend/src/modules/openalbion/catalog.json"
OUTPUT = REPO_ROOT / "apps/backend/src/modules/openalbion/abilities.json"


def main() -> int:
    print("Loading dumps…", file=sys.stderr)
    items = index_items(load_json("items.json")["items"])
    spells = index_spells(load_json("spells.json")["spells"])
    localized = load_localization("@SPELLS_")

    def display_name(unique_name: str) -> str | None:
        _, spell = spells[unique_name]
        for key in (spell.get("@namelocatag"), f"@SPELLS_{unique_name}"):
            if key and key in localized:
                return localized[key]
        return None

    # Only the weapons and armor the app actually offers; keys match the frontend's
    # `albionSpecializationIdentifier()`, which strips the tier prefix and the enchantment suffix.
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    bases: dict[str, str] = {}
    for entry in catalog:
        if entry["type"] not in ("weapon", "armor"):
            continue
        bases.setdefault(base_identifier(entry["identifier"]), entry["name"])

    output: dict[str, dict] = {}
    problems: list[str] = []
    for base, label in bases.items():
        source = next(
            (f"T{tier}_{base}" for tier in range(4, 9) if f"T{tier}_{base}" in items),
            next((f"T{tier}_{base}" for tier in range(1, 9) if f"T{tier}_{base}" in items), None),
        )
        if source is None:
            problems.append(f"{base}: no item of any tier in the dump")
            continue

        item = items[source]
        active_slots = int(item.get("@activespellslots", "0"))
        passive_slots = int(item.get("@passivespellslots", "0"))
        active: dict[int, list] = collections.defaultdict(list)
        passive: dict[int, list] = collections.defaultdict(list)

        for entry in resolve_spell_list(items, source):
            unique_name = entry["@uniquename"]
            if unique_name not in spells:
                problems.append(f"{base}: spell {unique_name} is absent from spells.json")
                continue
            name = display_name(unique_name)
            if not name:
                problems.append(f"{base}: spell {unique_name} has no English name")
                continue
            kind, spell = spells[unique_name]
            bucket = active if kind in ACTIVE_KINDS else passive
            # An omitted `@slots` means the item has exactly one slot of that kind.
            bucket[int(entry.get("@slots", "1"))].append(
                {
                    "id": unique_name,
                    "name": name,
                    "cooldown": spell.get("@recastdelay"),
                    "energy": spell.get("@energyusage"),
                }
            )

        for kind_name, bucket, declared in (
            ("active", active, active_slots),
            ("passive", passive, passive_slots),
        ):
            if bucket and max(bucket) > max(declared, 1):
                problems.append(
                    f"{base}: a {kind_name} spell claims slot {max(bucket)} but the item declares "
                    f"{declared} {kind_name} slot(s)"
                )

        output[base] = {
            "label": label,
            "slot_type": item.get("@slottype"),
            "two_handed": item.get("@twohanded") == "true",
            "active_slots": active_slots,
            "passive_slots": passive_slots,
            "active": {str(index): choices for index, choices in sorted(active.items())},
            "passive": {str(index): choices for index, choices in sorted(passive.items())},
        }

    if problems:
        print(f"\n{len(problems)} problem(s) — refusing to write:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1

    OUTPUT.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    distinct = {
        choice["id"]
        for base in output.values()
        for group in ("active", "passive")
        for choices in base[group].values()
        for choice in choices
    }
    print(
        f"Wrote {OUTPUT.relative_to(REPO_ROOT)}: {len(output)} bases, "
        f"{len(distinct)} distinct spells",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
