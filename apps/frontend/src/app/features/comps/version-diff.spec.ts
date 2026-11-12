import { describe, expect, it } from 'vitest';

import type {
  BuildDetail,
  BuildItemSlot,
  BuildLoadout,
  BuildSlot,
  CompDetail,
} from '../../core/models/api.models';
import { DEFAULT_BUILD_DIFF_LABELS, diffBuildVersions, diffCompVersions } from './version-diff';

function item(
  slot: BuildSlot,
  name: string,
  loadout: BuildLoadout = 'main',
  spells?: BuildItemSlot['spells'],
): BuildItemSlot {
  return {
    loadout,
    slot,
    spells,
    openalbion_item_type: 'weapon',
    openalbion_item_id: 1,
    openalbion_item_name: name,
  };
}

function build(version: number, items: BuildItemSlot[]): BuildDetail {
  return {
    id: version,
    name: 'Pole Hammer',
    description: null,
    role: 'dps',
    category_id: 1,
    version,
    category_name: 'Crystal',
    created_by_id: 1,
    created_by_username: 'admin',
    updated_at: '2026-09-01T00:00:00Z',
    item_count: items.length,
    main_item_count: items.length,
    archived_at: null,
    weapon_key: null,
    weapon_name: null,
    items,
  };
}

function comp(
  version: number,
  builds: { name: string; quantity: number; buildVersion?: number }[],
): CompDetail {
  return {
    id: version,
    name: 'Standard',
    description: null,
    category_id: 1,
    version,
    category_name: 'ZvZ',
    created_by_id: 1,
    created_by_username: 'admin',
    created_at: '2026-09-01T00:00:00Z',
    build_count: builds.length,
    total_quantity: builds.reduce((sum, entry) => sum + entry.quantity, 0),
    parent_id: null,
    archived_at: null,
    builds: builds.map((entry, index) => ({
      build_id: index + 1,
      quantity: entry.quantity,
      build: {
        id: index + 1,
        name: entry.name,
        description: null,
        role: 'dps',
        category_id: 1,
        version: entry.buildVersion ?? 1,
        category_name: 'Crystal',
        created_by_id: 1,
        created_by_username: 'admin',
        updated_at: '2026-09-01T00:00:00Z',
        item_count: 0,
        main_item_count: 0,
        archived_at: null,
        weapon_key: null,
        weapon_name: null,
      },
    })),
  };
}

function tiered(
  slot: BuildSlot,
  name: string,
  tier: string,
  extra: Partial<BuildItemSlot> = {},
): BuildItemSlot {
  return { ...item(slot, name), openalbion_item_tier: tier, ...extra };
}

describe('build version diff', () => {
  it('reports nothing when two versions are equivalent', () => {
    const items = [item('weapon', 'Polehammer')];
    expect(diffBuildVersions(build(1, items), build(2, items))).toEqual([]);
  });

  it('names the loadout as the group and the slot as the subject', () => {
    const changes = diffBuildVersions(
      build(1, [item('weapon', 'Polehammer')]),
      build(2, [item('weapon', 'Realmbreaker')]),
    );

    expect(changes).toHaveLength(1);
    expect(changes[0].group).toBe('Main');
    expect(changes[0].subject).toBe('Weapon');
    expect(changes[0].change).toBe('changed');
    expect(changes[0].before).toContain('Polehammer');
    expect(changes[0].after).toContain('Realmbreaker');
  });

  it('shows only the item token when only the item changed', () => {
    const changes = diffBuildVersions(
      build(1, [item('weapon', 'Polehammer')]),
      build(2, [item('weapon', 'Realmbreaker')]),
    );

    expect(changes[0].tokens).toEqual([
      { kind: 'item', label: 'Item', before: 'Polehammer', after: 'Realmbreaker' },
    ]);
  });

  it('writes the tier the way the game does, never as TT8', () => {
    const changes = diffBuildVersions(
      build(1, [tiered('weapon', 'Polehammer', 'T8')]),
      build(2, [tiered('weapon', 'Polehammer', 'T8', { openalbion_item_enchantment: 1, openalbion_item_id: 1 })]),
    );

    expect(changes[0].tokens?.[0]).toMatchObject({ before: 'Polehammer T8', after: 'Polehammer T8.1' });
    const text = JSON.stringify(changes);
    expect(text).not.toContain('TT8');
  });

  it('accepts a bare numeric tier from the API', () => {
    const changes = diffBuildVersions(
      build(1, [tiered('head', 'Knight Helmet', '7')]),
      build(2, [tiered('head', 'Knight Helmet', '8')]),
    );

    expect(changes[0].tokens?.[0]).toMatchObject({ before: 'Knight Helmet T7', after: 'Knight Helmet T8' });
  });

  it('prints quality only when it is not the default or when it is what changed', () => {
    const quality = diffBuildVersions(
      build(1, [item('head', 'Knight Helmet')]),
      build(2, [{ ...item('head', 'Knight Helmet'), openalbion_item_quality: 2 }]),
    );
    expect(quality[0].tokens?.[0]).toMatchObject({
      before: 'Knight Helmet · Excellent',
      after: 'Knight Helmet · Good',
    });

    const plain = diffBuildVersions(
      build(1, [item('head', 'Knight Helmet')]),
      build(2, [item('head', 'Knight Helm')]),
    );
    expect(plain[0].tokens?.[0]).toMatchObject({ before: 'Knight Helmet', after: 'Knight Helm' });
  });

  it('distinguishes an added slot from a removed one', () => {
    const added = diffBuildVersions(build(1, []), build(2, [item('head', 'Knight Helmet')]));
    expect(added[0].change).toBe('added');
    expect(added[0].before).toBeNull();
    expect(added[0].tokens?.[0]).toMatchObject({ before: null, after: 'Knight Helmet' });

    const removed = diffBuildVersions(build(1, [item('head', 'Knight Helmet')]), build(2, []));
    expect(removed[0].change).toBe('removed');
    expect(removed[0].after).toBeNull();
  });

  it('treats the same slot in the two loadouts as separate lines', () => {
    const changes = diffBuildVersions(
      build(1, [item('weapon', 'Polehammer'), item('weapon', 'Realmbreaker', 'swap')]),
      build(1, [item('weapon', 'Polehammer'), item('weapon', 'Kingmaker', 'swap')]),
    );

    expect(changes).toHaveLength(1);
    expect(changes[0].group).toBe('Swap');
    expect(changes[0].subject).toBe('Weapon');
  });

  it('orders the lines main before swap and by slot, not alphabetically', () => {
    const changes = diffBuildVersions(
      build(1, [item('mount', 'Horse'), item('weapon', 'A', 'swap'), item('head', 'Cap'), item('weapon', 'Axe')]),
      build(2, [item('mount', 'Direwolf'), item('weapon', 'B', 'swap'), item('head', 'Hood'), item('weapon', 'Bow')]),
    );

    expect(changes.map((entry) => `${entry.group}/${entry.subject}`)).toEqual([
      'Main/Weapon',
      'Main/Head',
      'Main/Mount',
      'Swap/Weapon',
    ]);
  });

  it('counts an ability change as a difference even when the item is the same', () => {
    const changes = diffBuildVersions(
      build(1, [
        item('weapon', 'Polehammer', 'main', { active: { '1': 'HEROICSTRIKE2' }, passive: {} }),
      ]),
      build(2, [item('weapon', 'Polehammer', 'main', { active: { '1': 'CLEAVE' }, passive: {} })]),
    );

    expect(changes).toHaveLength(1);
    expect(changes[0].change).toBe('changed');
    expect(changes[0].after).toContain('CLEAVE');
  });

  it('shows only the changed spell, labelled by its key, with names instead of ids', () => {
    const names = { HEROICSTRIKE2: 'Heroic Strike', CLEAVE: 'Cleave', PASSIVE_BLEEDCHANCE: 'Deep Cuts' };
    const changes = diffBuildVersions(
      build(1, [
        item('weapon', 'Polehammer', 'main', {
          active: { '1': 'HEROICSTRIKE2', '2': 'CLEAVE' },
          passive: { '1': 'PASSIVE_BLEEDCHANCE' },
        }),
      ]),
      build(2, [
        item('weapon', 'Polehammer', 'main', {
          active: { '1': 'CLEAVE', '2': 'CLEAVE' },
          passive: { '1': 'PASSIVE_BLEEDCHANCE' },
        }),
      ]),
      names,
    );

    expect(changes[0].tokens).toEqual([
      { kind: 'spell', label: 'Q', before: 'Heroic Strike', after: 'Cleave' },
    ]);
  });

  it('describes the whole slot in one line with names for non-rich consumers', () => {
    const names = { HEROICSTRIKE2: 'Heroic Strike', PASSIVE_BLEEDCHANCE: 'Deep Cuts' };
    const changes = diffBuildVersions(
      build(1, [item('weapon', 'Polehammer')]),
      build(2, [
        item('weapon', 'Polehammer', 'main', {
          active: { '1': 'HEROICSTRIKE2' },
          passive: { '1': 'PASSIVE_BLEEDCHANCE' },
        }),
      ]),
      names,
    );

    expect(changes[0].after).toBe('Polehammer — Q Heroic Strike, Passive Deep Cuts');
  });

  it('falls back to the id for a spell the catalog does not know', () => {
    const changes = diffBuildVersions(
      build(1, [item('weapon', 'Polehammer')]),
      build(2, [
        item('weapon', 'Polehammer', 'main', { active: { '1': 'BRAND_NEW_SPELL' }, passive: {} }),
      ]),
      {},
    );

    expect(changes[0].after).toContain('BRAND_NEW_SPELL');
    expect(changes[0].tokens?.[0]).toMatchObject({ label: 'Q', before: null, after: 'BRAND_NEW_SPELL' });
  });

  it('uses the translated labels the caller passes', () => {
    const changes = diffBuildVersions(
      build(1, [item('off_hand', 'Torch')]),
      build(2, [item('off_hand', 'Shield')]),
      {},
      {
        ...DEFAULT_BUILD_DIFF_LABELS,
        loadout: { main: 'Principale', swap: 'Swap' },
        slot: { ...DEFAULT_BUILD_DIFF_LABELS.slot, off_hand: 'Seconda mano' },
        item: 'Oggetto',
      },
    );

    expect(changes[0]).toMatchObject({ group: 'Principale', subject: 'Seconda mano' });
    expect(changes[0].tokens?.[0].label).toBe('Oggetto');
  });
});

describe('comp version diff', () => {
  it('reports nothing when two versions field the same builds', () => {
    const builds = [{ name: 'Pole Hammer', quantity: 5 }];
    expect(diffCompVersions(comp(1, builds), comp(2, builds))).toEqual([]);
  });

  it('reports an added build, a removed build and a changed quantity', () => {
    const changes = diffCompVersions(
      comp(1, [
        { name: 'Pole Hammer', quantity: 5 },
        { name: 'Great Axe', quantity: 2 },
      ]),
      comp(2, [
        { name: 'Pole Hammer', quantity: 8 },
        { name: 'Realmbreaker', quantity: 1 },
      ]),
    );

    expect(changes.map((entry) => [entry.subject, entry.change])).toEqual([
      ['Great Axe v1', 'removed'],
      ['Pole Hammer v1', 'changed'],
      ['Realmbreaker v1', 'added'],
    ]);
    expect(changes.find((entry) => entry.subject === 'Pole Hammer v1')).toMatchObject({
      before: 'x5',
      after: 'x8',
    });
  });

  it('keeps two versions of the same build apart instead of collapsing them', () => {
    // Fielding v1 and v2 of one build together is the normal way to trial a change, and keying the
    // diff by name alone silently dropped one of the two lines.
    const changes = diffCompVersions(
      comp(1, [{ name: 'Pole Hammer', quantity: 6 }]),
      comp(2, [
        { name: 'Pole Hammer', quantity: 10 },
        { name: 'Pole Hammer', quantity: 4, buildVersion: 2 },
      ]),
    );

    expect(changes.map((entry) => [entry.subject, entry.before, entry.after])).toEqual([
      ['Pole Hammer v1', 'x6', 'x10'],
      ['Pole Hammer v2', null, 'x4'],
    ]);
  });

  it('reads a build that moved from v1 to v3 as one changed line, not a removal and an addition', () => {
    const changes = diffCompVersions(
      comp(1, [{ name: 'Pole Hammer', quantity: 5 }]),
      comp(2, [{ name: 'Pole Hammer', quantity: 5, buildVersion: 3 }]),
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ subject: 'Pole Hammer', change: 'changed' });
    expect(changes[0].tokens).toEqual([
      { kind: 'version', label: 'Version', before: 'v1', after: 'v3' },
    ]);
  });

  it('adds the player count when the version and the quantity both changed', () => {
    const changes = diffCompVersions(
      comp(1, [{ name: 'Pole Hammer', quantity: 5 }]),
      comp(2, [{ name: 'Pole Hammer', quantity: 8, buildVersion: 2 }]),
      { version: 'Versione', players: 'Giocatori' },
    );

    expect(changes[0].tokens).toEqual([
      { kind: 'version', label: 'Versione', before: 'v1', after: 'v2' },
      { kind: 'quantity', label: 'Giocatori', before: 'x5', after: 'x8' },
    ]);
  });
});
