#!/usr/bin/env python3
"""Regenerates the bundled Albion combat dataset from the community binary dumps.

Like `abilities.json`, this data is bundled and refreshed by hand after an Albion patch; the app
never contacts a third party at runtime. Run this after a patch:

    python3 scripts/generate_albion_combat_data.py

Three output files rather than one, so a patch that only touches spell numbers does not churn a
one-megabyte diff:

* `items.json`  — the combat stats of every equippable base, per tier, plus its Item Power ladder
                  across the five enchantment levels.
* `spells.json` — the spells reachable from those items, with their timing and their effects.
* `rules.json`  — the global tables: quality bonuses, Item Power progression, the Destiny Board
                  bonus rules, and the combat modifiers (AoE escalation, focus fire, zerg debuff,
                  crowd-control diminishing returns, base character stats).

Five source files, five separate reasons:

* `items.json`        — per-item stats, the enchantment ladder, `@combatspecachievement` (the join
                        to the Destiny Board) and `@itempowerprogressiontype`.
* `spells.json`       — spell timing and effects.
* `characters.json`   — the base player: 1200 hit points, 120 energy, the 0.5 s global cast delay.
* `gamedata.json`     — every global balance table. This is the file that makes the numbers real
                        rather than guessed: quality bonuses, progression coefficients, the AoE
                        escalation cap, the focus-fire table, the zerg debuff.
* `achievements.json` — the Destiny Board itself: which node grants how much Item Power to which
                        item patterns, and which mastery node a specialization hangs off.
* `localization.xml`  — player-facing spell names.

Two resolutions are done HERE, at generation time, and never guessed by the backend:

1. `@itempowerprogressiontype` is `mainhand` for every weapon, while `gamedata.json` splits the
   table into `mainhand_1h` / `mainhand_2h`; and off-hands declare per-family types (`shield`,
   `orb`, `book`, …) that the table does not carry at all. Both are resolved against `@twohanded`
   and the table's own keys, and an unresolvable type aborts the run.
2. Most catalog bases carry a `@combatspecachievement`. The ones that do not are the capes, the
   bags, the gathering sets, the food, the potions and the mounts — none of which has a Destiny
   Board combat specialization. That list is an explicit allowlist, so a future patch that drops a
   real weapon's spec node aborts the run instead of silently zeroing its bonus.

Nothing is written if any problem is found.
"""

from __future__ import annotations

import fnmatch
import json
import re
import sys
from datetime import datetime, timezone

from albion_dumps import (
    REPO_ROOT,
    base_identifier,
    dumps_commit,
    index_items,
    index_spells,
    load_json,
    load_localization,
)

GENERATOR_VERSION = 1

CATALOG = REPO_ROOT / "apps/backend/src/modules/openalbion/catalog.json"
ABILITIES = REPO_ROOT / "apps/backend/src/modules/openalbion/abilities.json"
OUT_DIR = REPO_ROOT / "apps/backend/src/modules/combat/data"

# The tiers the app offers. `equipment-grid.ts` lists T4..T8, and every Destiny Board Item Power
# bonus declares `@mintier="4"`, so nothing below T4 can differ from its base value anyway.
TIERS = range(4, 9)

# Item kinds that can be equipped in a slot that counts toward Item Power.
ITEM_KINDS = ("weapon", "equipmentitem", "transformationweapon", "mount")

# Bases with no Destiny Board combat specialization. Anything of catalog type `weapon` or `armor`
# outside this list that resolves to no node aborts the run.
NO_SPEC_NODE_PREFIXES = (
    "CAPE",
    "BAG",
    "MEAL_",
    "POTION_",
    "MOUNT_",
    "HEAD_GATHERER_",
    "ARMOR_GATHERER_",
    "SHOES_GATHERER_",
    "2H_TOOL_",
)

# Flat combat stats read straight off the item. Emitted only when non-zero.
CORE_STATS = {
    "@abilitypower": "ability_power",
    "@attackdamage": "attack_damage",
    "@attackspeed": "attack_speed",
    "@attackrange": "attack_range",
    "@hitpointsmax": "hitpoints_max",
    "@energymax": "energy_max",
    "@physicalarmor": "physical_armor",
    "@magicresistance": "magic_resistance",
    "@crowdcontrolresistance": "cc_resistance",
    "@movespeed": "move_speed",
}

# Percentage-style modifiers. Grouped under `bonuses` so the stat block stays readable.
BONUS_STATS = (
    "physicalspelldamagebonus",
    "magicspelldamagebonus",
    "physicalattackdamagebonus",
    "magicattackdamagebonus",
    "healbonus",
    "healmodifier",
    "hitpointsregenerationbonus",
    "energyregenerationbonus",
    "energycostreduction",
    "movespeedbonus",
    "attackspeedbonus",
    "threatbonus",
    "bonusccdurationvsplayers",
    "bonusccdurationvsmobs",
    "bonusdefensevsplayers",
    "bonusdefensevsmobs",
    "magiccooldownreduction",
    "magiccasttimereduction",
)

# Presentation-only keys, dropped from every spell record. Substring match, lowercased.
DROP_KEY_SUBSTRINGS = (
    "fx",
    "audio",
    "prefab",
    "socket",
    "anim",
    "sprite",
    "atlas",
    "constraint",
    "mesh",
    "bone",
    "icon",
    "texture",
    "locatag",
)
DROP_KEYS = frozenset(
    {
        "AudioInfo",
        "locareferences",
        "dummy",
        "nop",
        "spellindicationarea",
        "generateloot",
        "unlockvanityunlock",
        "unlockavatar",
        "spawnmob",
        "@statblock",
        "@showrange",
        "@assessment",
        "@controllerpreferredtarget",
        "@controllerselfcastable",
        "@controllerpreferredcastdirection",
        "@keepmovingaftercast",
        "@adjustgroundtargettorange",
        "@unlockedtoequip",
        "@bindtoitem",
        "@castupperbodyblendtime",
        "@cancelautoattackaftercasting",
        "@autoattackcooldownaftercasting",
    }
)

# Keys whose string value names another spell, used to walk the reachable set.
SPELL_REF_KEYS = ("@spell", "@effect", "@uniquename", "@buff", "@debuff", "@spellname")

# Combat modifier tables lifted wholesale out of `gamedata.json`.
SERVER_SETTING_TABLES = (
    "AoeEscalation",
    "CrowdControlDiminishingReturns",
    "Casting",
    "SpellCooldowns",
    "ReflectedDamage",
)
ROOT_TABLES = ("PlayerFocusFire", "PlayerHealingSickness", "ZergDebuff", "ActiveBuffScaling")

problems: list[str] = []


def problem(message: str) -> None:
    """Records a reason to refuse to write. The run continues so one pass reports everything."""
    problems.append(message)


def as_float(value: str | None) -> float | None:
    """Parses a dump attribute, returning `None` for absent, unparseable or zero values."""
    if value is None:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if parsed != 0.0 else None


def prune(node: object, depth: int = 0) -> object:
    """Strips presentation keys from a spell subtree, keeping the mechanics verbatim."""
    if depth > 12:
        return None
    if isinstance(node, list):
        pruned = [p for p in (prune(entry, depth + 1) for entry in node) if p not in (None, {})]
        return pruned or None
    if not isinstance(node, dict):
        return node
    out: dict[str, object] = {}
    for key, value in node.items():
        if key in DROP_KEYS:
            continue
        lowered = key.lower()
        if any(fragment in lowered for fragment in DROP_KEY_SUBSTRINGS):
            continue
        child = prune(value, depth + 1)
        if child not in (None, {}):
            out[key] = child
    return out or None


def item_power_ladder(item: dict, unique_name: str) -> list[int] | None:
    """The five Item Power values of an item, indexed by enchantment level 0..4.

    An item with no `enchantments` block cannot be enchanted at all — artifacts, mounts, food. Its
    ladder repeats the base value so callers never have to special-case the length.
    """
    base = item.get("@itempower")
    if base is None:
        return None
    ladder = [int(float(base))]
    enchantments = item.get("enchantments", {}).get("enchantment")
    if enchantments is None:
        return ladder * 5
    entries = enchantments if isinstance(enchantments, list) else [enchantments]
    levels = [int(entry["@enchantmentlevel"]) for entry in entries]
    if levels != [1, 2, 3, 4]:
        problem(f"{unique_name}: enchantment levels are {levels}, expected [1, 2, 3, 4]")
        return None
    ladder.extend(int(float(entry["@itempower"])) for entry in entries)
    if ladder != sorted(ladder):
        problem(f"{unique_name}: Item Power ladder {ladder} is not monotonic")
        return None
    return ladder


def resolve_progression(item: dict, unique_name: str, table: dict) -> str | None:
    """Maps `@itempowerprogressiontype` onto a `gamedata.json` progression row."""
    declared = item.get("@itempowerprogressiontype")
    if declared is None:
        return None
    if declared == "mainhand":
        return "mainhand_2h" if item.get("@twohanded") == "true" else "mainhand_1h"
    if declared in table:
        return declared
    # Off-hands declare a per-family type (`shield`, `orb`, `book`, …) the table does not carry.
    if item.get("@slottype") == "offhand":
        return "offhand"
    problem(f"{unique_name}: progression {declared!r} resolves to no ItemPowerProgression row")
    return None


def build_items(items: dict, catalog: list, progression_table: dict) -> dict:
    """One record per equippable base: its shared stat block and its Item Power ladder per tier.

    Tier does not change a single combat stat — measured across all 286 bases, only `@itempower`
    differs between a T4 and a T8 of the same item. Everything else scales from Item Power through
    `ItemPowerProgression`. So the stats are hoisted out of the per-tier map, and a patch that ever
    breaks that invariant aborts the run rather than silently emitting the T4 numbers for T8.

    Mounts, food and potions are absent from the output: they carry no `@itempower` at all, and no
    slot holding one counts toward character Item Power.
    """
    bases: dict[str, str] = {}
    for entry in catalog:
        bases.setdefault(base_identifier(entry["identifier"]), entry["type"])

    out: dict[str, dict] = {}
    skipped: list[str] = []
    for base, catalog_type in sorted(bases.items()):
        ladders: dict[str, list[int]] = {}
        mastery: dict[str, float] = {}
        penetrations: dict[str, float] = {}
        shared: dict[str, object] = {}
        stats: dict[str, object] = {}
        for tier in TIERS:
            unique_name = f"T{tier}_{base}"
            item = items.get(unique_name)
            if item is None:
                continue
            ladder = item_power_ladder(item, unique_name)
            if ladder is None:
                continue

            tier_stats: dict[str, object] = {}
            for attribute, name in CORE_STATS.items():
                value = as_float(item.get(attribute))
                if value is not None:
                    tier_stats[name] = value
            bonuses = {
                name: value
                for name in BONUS_STATS
                if (value := as_float(item.get(f"@{name}"))) is not None
            }
            if bonuses:
                tier_stats["bonuses"] = bonuses

            if not shared:
                spec_node = item.get("@combatspecachievement")
                if (
                    spec_node is None
                    and catalog_type in ("weapon", "armor")
                    and not base.startswith(NO_SPEC_NODE_PREFIXES)
                ):
                    problem(f"{base}: catalog type {catalog_type} but no @combatspecachievement")
                shared = {
                    "type": catalog_type,
                    "slot_type": item.get("@slottype"),
                    "two_handed": item.get("@twohanded") == "true",
                    "progression": resolve_progression(item, unique_name, progression_table),
                    "spec_node": spec_node,
                    "active_slots": int(item.get("@activespellslots", "0")),
                    "passive_slots": int(item.get("@passivespellslots", "0")),
                }
                stats = tier_stats
            elif tier_stats != stats:
                problem(f"{base}: T{tier} combat stats differ from the lowest emitted tier's")

            ladders[str(tier)] = ladder
            if (modifier := as_float(item.get("@masterymodifier"))) is not None:
                mastery[str(tier)] = modifier
            if (penetration := as_float(item.get("@focusfireprotectionpenetration"))) is not None:
                penetrations[str(tier)] = penetration

        if ladders:
            out[base] = {
                **{key: value for key, value in shared.items() if value is not None},
                "stats": stats,
                "item_power": ladders,
                **({"mastery_modifier": mastery} if mastery else {}),
                **({"ffp_penetration": penetrations} if penetrations else {}),
            }
        else:
            skipped.append(base)

    if skipped:
        print(
            f"  {len(skipped)} bases carry no Item Power and are omitted "
            f"(mounts, food, potions): {', '.join(skipped[:4])}…",
            file=sys.stderr,
        )
    return out


def spell_references(node: object, out: list[str] | None = None) -> list[str]:
    """Collects every spell id a spell's subtree names."""
    out = [] if out is None else out
    if isinstance(node, dict):
        for key, value in node.items():
            if key in SPELL_REF_KEYS and isinstance(value, str):
                out.append(value)
            spell_references(value, out)
    elif isinstance(node, list):
        for entry in node:
            spell_references(entry, out)
    return out


def reachable_spells(spells: dict, abilities: dict) -> set[str]:
    """Every spell an equippable item offers, plus everything those spells reach."""
    seed = {
        choice["id"]
        for entry in abilities.values()
        for group in ("active", "passive")
        for choices in entry[group].values()
        for choice in choices
    }
    missing = sorted(name for name in seed if name not in spells)
    for name in missing:
        problem(f"offered spell {name} is absent from spells.json")
    closure, frontier = set(seed) - set(missing), list(seed - set(missing))
    while frontier:
        following: list[str] = []
        for name in frontier:
            for reference in spell_references(spells[name][1]):
                if reference in spells and reference not in closure:
                    closure.add(reference)
                    following.append(reference)
        frontier = following
    return closure


def build_spells(spells: dict, reachable: set[str], localized: dict) -> dict:
    """One pruned record per reachable spell, with its player-facing name."""
    out: dict[str, dict] = {}
    for name in sorted(reachable):
        kind, spell = spells[name]
        record = normalize(prune(spell) or {})
        record.pop("uniquename", None)
        display = next(
            (
                localized[key]
                for key in (spell.get("@namelocatag"), f"@SPELLS_{name}")
                if key and key in localized
            ),
            None,
        )
        out[name] = {"kind": kind, **({"name": display} if display else {}), **record}
    return out


def normalize(node: object) -> object:
    """Turns a dump subtree into ordinary JSON: no `@` prefixes, no numbers hiding in strings.

    Every value in the dumps is a string, including `"1.0918"` and `"false"`. Converting here
    rather than in the backend keeps the rule that resolution happens at generation time: Rust
    deserializes typed numbers and never parses a game string.
    """
    if isinstance(node, dict):
        return {key.lstrip("@").replace("#text", "text"): normalize(value) for key, value in node.items()}
    if isinstance(node, list):
        return [normalize(entry) for entry in node]
    if not isinstance(node, str):
        return node
    if node in ("true", "false"):
        return node == "true"
    try:
        number = float(node)
    except ValueError:
        return node
    return int(number) if number.is_integer() and "." not in node and "e" not in node.lower() else number


def build_spec_nodes(achievements: dict) -> dict:
    """Destiny Board Item Power rules, and the mastery node each specialization hangs off.

    A specialization node carries BOTH of its rules itself: `+2.0` per level against its own item
    pattern and `+0.2` per level against the whole family. So resolving a player's bonus needs no
    tree walk — only the nodes they actually have levels in. The `parent` link is kept anyway,
    because the mastery node is levelled separately and the UI has to group by it.
    """
    templates = {t["@name"]: t for t in achievements["template"]}
    max_levels = {
        name: len([line for line in template["baselevels"]["#text"].splitlines() if line.strip()])
        for name, template in templates.items()
        if "baselevels" in template
    }

    nodes: dict[str, dict] = {}
    for node in achievements["templateachievement"]:
        node_id = node.get("@id")
        template = str(node.get("@usetemplate"))
        if node_id is None or not template.startswith("COMBAT"):
            continue
        raw = node.get("baserewards", {}).get("bonus")
        entries = raw if isinstance(raw, list) else ([raw] if raw else [])
        rules = []
        for bonus in entries:
            if bonus.get("@type") != "itemwearbonus" or bonus.get("@attribute") != "itempower":
                continue
            raw_patterns = bonus.get("itempattern")
            listed = raw_patterns if isinstance(raw_patterns, list) else [raw_patterns]
            patterns = [entry["@pattern"] for entry in listed if entry]
            for pattern in patterns:
                if not re.fullmatch(r"[A-Z0-9_?*]+", pattern):
                    problem(f"{node_id}: item pattern {pattern!r} has unexpected characters")
            rules.append(
                {
                    "bonus": float(bonus["@bonus"]),
                    "min_tier": int(bonus.get("@mintier", "1")),
                    "max_tier": int(bonus.get("@maxtier", "8")),
                    "patterns": patterns,
                }
            )
        if not rules:
            continue

        parent = None
        if template.endswith("SPEC"):
            listed = node.get("parentachievements", {}).get("achievement")
            if isinstance(listed, dict):
                parent = listed["@id"]
            else:
                problem(f"{node_id}: specialization has no single parent mastery node")
        nodes[node_id] = {
            "kind": "spec" if template.endswith("SPEC") else "mastery",
            **({"parent": parent} if parent else {}),
            "max_level": max_levels.get(template, 100),
            "bonuses": rules,
        }

    for node_id, node in nodes.items():
        if (parent := node.get("parent")) and parent not in nodes:
            problem(f"{node_id}: parent mastery node {parent} carries no Item Power rules")
    return nodes


# `ItemPowerProgression` mixes two unrelated shapes under one element: thirteen per-slot rows of
# growth coefficients, and four `*share` tables that weight how much each slot contributes to a
# pooled stat. Splitting them here means the backend gets two well-typed maps instead of one union.
SHARE_TABLES = ("armorshare", "ccrshare", "hitpointsshare", "energyshare")


def split_progression(table: dict) -> dict:
    """Separates the per-slot growth rows from the `*share` weighting tables."""
    rows: dict = {}
    shares: dict = {}
    for name, row in table.items():
        if name in SHARE_TABLES:
            shares[name.removesuffix("share")] = row
            continue
        if "armorbase" not in row:
            continue  # `trackingtime` is neither a row nor a share table.
        growth = {key: value for key, value in row.items() if key.endswith(("progression", "base"))}
        rest = {key: value for key, value in row.items() if not key.endswith(("progression", "base"))}
        # `isinstance(False, int)` is True in Python, so booleans have to be excluded by identity.
        growth["multipliers"] = {
            key: value for key, value in rest.items() if isinstance(value, (int, float)) and not isinstance(value, bool)
        }
        growth["flags"] = {key: value for key, value in rest.items() if isinstance(value, bool)}
        rows[name] = growth
    missing = set(SHARE_TABLES) - {f"{key}share" for key in shares}
    for name in sorted(missing):
        problem(f"ItemPowerProgression is missing the {name} table")
    return {"item_power_progression": rows, "stat_shares": shares}


def build_rules(gamedata: dict, characters: dict, achievements: dict, commit: dict) -> dict:
    """The global tables, plus the dataset stamp every combat response echoes."""
    root = gamedata["AO-GameData"]
    server = root["ServerSettings"]
    # `Characters` is the one table that lives in `characters.json` rather than `gamedata.json`.
    character_root = characters["CharacterData"]["Characters"]

    quality = {
        entry["@level"]: int(float(entry["@itempowerbonus"]))
        for entry in root["Items"]["QualityLevels"]["qualitylevel"]
    }
    quality.setdefault("1", 0)

    return {
        "dataset_version": {
            "source": "ao-data/ao-bin-dumps",
            "dumps_commit": commit["sha"],
            "dumps_committed_at": commit["committed_at"],
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "generator_version": GENERATOR_VERSION,
        },
        "quality_item_power": {level: quality[level] for level in sorted(quality)},
        **split_progression(normalize(root["Items"]["ItemPowerProgression"])),
        "ability_power_progression": normalize(root["Items"]["AbilityPowerProgression"]),
        "spec_nodes": build_spec_nodes(achievements["achievements"]),
        "character_defaults": normalize(
            {key: value for key, value in character_root["DefaultValues"].items() if key.startswith("@")}
        ),
        "global_cast_delay": float(character_root["@globalcastdelay"]),
        **{table: normalize(server[table]) for table in SERVER_SETTING_TABLES if table in server},
        **{table: normalize(root[table]) for table in ROOT_TABLES if table in root},
    }


def check_pattern_coverage(spec_nodes: dict, items: dict) -> None:
    """Every node must match at least one real item, or its pattern is dead."""
    names = [f"T{tier}_{base}" for base in items for tier in TIERS]
    for node_id, node in spec_nodes.items():
        patterns = [pattern for rule in node["bonuses"] for pattern in rule["patterns"]]
        if not any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns for name in names):
            problem(f"{node_id}: no catalog item matches any of its patterns {patterns}")


def main() -> int:
    print("Loading dumps…", file=sys.stderr)
    items = index_items(load_json("items.json")["items"], ITEM_KINDS)
    spells = index_spells(load_json("spells.json")["spells"])
    gamedata = load_json("gamedata.json")
    characters = load_json("characters.json")
    achievements = load_json("achievements.json")
    localized = load_localization("@SPELLS_")
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    abilities = json.loads(ABILITIES.read_text(encoding="utf-8"))

    print("Resolving dumps commit…", file=sys.stderr)
    commit = dumps_commit()

    rules = build_rules(gamedata, characters, achievements, commit)
    item_records = build_items(items, catalog, rules["item_power_progression"])
    spell_records = build_spells(spells, reachable_spells(spells, abilities), localized)
    check_pattern_coverage(rules["spec_nodes"], item_records)

    for node in sorted(
        {
            record["spec_node"]
            for record in item_records.values()
            if record.get("spec_node") and record["spec_node"] not in rules["spec_nodes"]
        }
    ):
        problem(f"item spec node {node} has no Item Power rules in achievements.json")

    if problems:
        print(f"\n{len(problems)} problem(s) — refusing to write:", file=sys.stderr)
        for entry in problems[:40]:
            print(f"  {entry}", file=sys.stderr)
        if len(problems) > 40:
            print(f"  … and {len(problems) - 40} more", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = []
    for name, payload in (
        ("items.json", item_records),
        ("spells.json", spell_records),
        ("rules.json", rules),
    ):
        path = OUT_DIR / name
        path.write_text(
            json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        written.append((path, path.stat().st_size))

    for path, size in written:
        print(f"Wrote {path.relative_to(REPO_ROOT)}: {size / 1024:.0f} KB", file=sys.stderr)
    print(
        f"{len(item_records)} bases, {len(spell_records)} spells, "
        f"{len(rules['spec_nodes'])} destiny nodes, "
        f"{sum(size for _, size in written) / 1024:.0f} KB total",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
