import { describe, expect, it } from 'vitest';

import type {
  BuildDetail,
  BuildItemSlot,
  BuildLoadout,
  BuildSlot,
  CompDetail,
} from '../../core/models/api.models';
import { diffBuildVersions, diffCompVersions } from './version-diff';

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
    created_by_username: 'admin',
    updated_at: '2026-09-01T00:00:00Z',
    item_count: items.length,
    archived_at: null,
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
        created_by_username: 'admin',
        updated_at: '2026-09-01T00:00:00Z',
        item_count: 0,
        archived_at: null,
      },
    })),
  };
}

describe('build version diff', () => {
  it('reports nothing when two versions are equivalent', () => {
    const items = [item('weapon', 'Polehammer')];
    expect(diffBuildVersions(build(1, items), build(2, items))).toEqual([]);
  });

  it('names the loadout and the slot that changed', () => {
    const changes = diffBuildVersions(
      build(1, [item('weapon', 'Polehammer')]),
      build(2, [item('weapon', 'Realmbreaker')]),
    );

    expect(changes).toHaveLength(1);
    expect(changes[0].subject).toBe('Main · Weapon');
    expect(changes[0].change).toBe('changed');
    expect(changes[0].before).toContain('Polehammer');
    expect(changes[0].after).toContain('Realmbreaker');
  });

  it('distinguishes an added slot from a removed one', () => {
    const added = diffBuildVersions(build(1, []), build(2, [item('head', 'Knight Helmet')]));
    expect(added[0].change).toBe('added');
    expect(added[0].before).toBeNull();

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
    expect(changes[0].subject).toBe('Swap · Weapon');
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

  it('names the abilities rather than printing their internal ids', () => {
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

    expect(changes[0].after).toBe('Polehammer — 1. Heroic Strike, Passive: Deep Cuts');
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
});
