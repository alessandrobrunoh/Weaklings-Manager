#!/usr/bin/env python3
"""Shared access to the community binary dumps of Albion Online.

Two generators read the same five dump files, so the download, the cache, the localization scan
and the `craftingspelllist` resolver live here rather than being copied between them:

* `generate_albion_abilities.py` — which spells each item offers.
* `generate_albion_combat_data.py` — the numbers behind those spells, and the Item Power rules.

Nothing here is called at runtime. The app never contacts a third party for game data; these
helpers exist only to regenerate the bundled JSON by hand after an Albion patch.

The cache is anchored to the repository root, not the working directory, so a re-run from a
subdirectory reuses the ~110 MB already on disk instead of downloading it again.
"""

from __future__ import annotations

import html
import json
import re
import sys
import urllib.request
from pathlib import Path

DUMPS = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master"
COMMITS_API = "https://api.github.com/repos/ao-data/ao-bin-dumps/commits/master"
REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE = REPO_ROOT / ".albion-dumps-cache"

# Item kinds that can carry a spell list. Shapeshifter staves live under `transformationweapon`.
ITEM_KINDS = ("weapon", "equipmentitem", "transformationweapon", "mount")
SPELL_KINDS = ("activespell", "passivespell", "togglespell")
ACTIVE_KINDS = {"activespell", "togglespell"}


def fetch(name: str) -> Path:
    """Downloads one dump file, caching it so a re-run does not re-fetch ~110 MB."""
    CACHE.mkdir(exist_ok=True)
    target = CACHE / name
    if not target.exists():
        print(f"  downloading {name} …", file=sys.stderr)
        urllib.request.urlretrieve(f"{DUMPS}/{name}", target)
    return target


def load_json(name: str) -> dict:
    """Fetches a dump and parses it. The dumps are XML-shaped JSON: attributes are `@`-prefixed."""
    return json.loads(fetch(name).read_text(encoding="utf-8"))


def dumps_commit() -> dict[str, str]:
    """The `master` commit the cached dumps correspond to, for stamping `dataset_version`.

    Network-only and deliberately not cached: it is one small request, and a stale value here
    would mislabel a dataset, which is worse than an extra round trip.
    """
    request = urllib.request.Request(
        COMMITS_API, headers={"Accept": "application/vnd.github+json", "User-Agent": "weaklings"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    return {
        "sha": payload["sha"],
        "committed_at": payload["commit"]["committer"]["date"],
    }


def load_localization(prefix: str) -> dict[str, str]:
    """Extracts the English strings whose tuid starts with `prefix` from the TMX dump.

    Streams line by line: `localization.xml` is ~76 MB and parsing it as a tree costs a multiple
    of that in memory for no benefit, since the file is one flat list of translation units.
    """
    path = fetch("localization.xml")
    names: dict[str, str] = {}
    tuid = re.compile(r'<tu tuid="([^"]+)"')
    lang = re.compile(r'<tuv xml:lang="([^"]+)"')
    seg = re.compile(r"<seg>(.*?)</seg>")
    current_key: str | None = None
    current_lang: str | None = None
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if match := tuid.search(line):
                current_key, current_lang = match.group(1), None
            elif match := lang.search(line):
                current_lang = match.group(1)
            elif match := seg.search(line):
                if current_key and current_lang == "EN-US" and current_key.startswith(prefix):
                    names[current_key] = html.unescape(match.group(1))
    return names


def index_items(items_root: dict, kinds: tuple[str, ...] = ITEM_KINDS) -> dict[str, dict]:
    """Flattens the requested item kinds into one `uniquename -> item` map."""
    items: dict[str, dict] = {}
    for kind in kinds:
        for item in items_root.get(kind, []):
            if isinstance(item, dict) and "@uniquename" in item:
                items[item["@uniquename"]] = item
    return items


def index_spells(
    spells_root: dict, kinds: tuple[str, ...] = SPELL_KINDS
) -> dict[str, tuple[str, dict]]:
    """Flattens the spell kinds into `uniquename -> (kind, spell)`.

    The kind is kept because active-vs-passive is not derivable from the item's spell entry: on a
    weapon the actives carry `@slots` and the passives do not, while on chest armor it is the
    other way round.
    """
    spells: dict[str, tuple[str, dict]] = {}
    for kind in kinds:
        for spell in spells_root.get(kind, []):
            if isinstance(spell, dict) and "@uniquename" in spell:
                spells[spell["@uniquename"]] = (kind, spell)
    return spells


def resolve_spell_list(items: dict[str, dict], unique_name: str, depth: int = 0) -> list[dict]:
    """Resolves an item's spell list, following `@reference` down to the tier or family that owns it.

    A `@reference` entry can carry its own `removespell`/`craftspell` diff alongside it — e.g. a
    shapeshifter staff's other elemental variants all reference the Panther staff's base list, then
    swap `SHAPESHIFT_PANTHER` for their own transformation. Skipping that diff (as a plain recurse
    would) silently gives every variant the referenced item's unmodified spells.
    """
    if depth > 10 or unique_name not in items:
        return []
    listing = items[unique_name].get("craftingspelllist")
    if not listing:
        return []
    if "@reference" in listing:
        entries = resolve_spell_list(items, listing["@reference"], depth + 1)
        removed = listing.get("removespell")
        if removed:
            removed_names = {
                r["@uniquename"] for r in (removed if isinstance(removed, list) else [removed])
            }
            entries = [e for e in entries if e["@uniquename"] not in removed_names]
        added = listing.get("craftspell")
        if added:
            entries = entries + (added if isinstance(added, list) else [added])
        return entries
    entries = listing.get("craftspell")
    if entries is None:
        return []
    return entries if isinstance(entries, list) else [entries]


def base_identifier(identifier: str) -> str:
    """Strips the tier prefix and enchantment suffix: `T8_MAIN_SWORD@2` -> `MAIN_SWORD`."""
    return re.sub(r"@\d+$", "", re.sub(r"^T\d+_", "", identifier))
