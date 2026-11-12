import { describe, expect, it } from 'vitest';

import type { BuildSummary } from '../../core/models/api.models';
import {
  addToComposition,
  compositionTotals,
  overlapWithParent,
  roleMixText,
  setQuantity,
  validateCompDraft,
  versionClashes,
} from './comp-create-model';

function build(id: number, overrides: Partial<BuildSummary> = {}): BuildSummary {
  return {
    id,
    name: `Build ${id}`,
    description: null,
    role: 'dps',
    category_id: 1,
    version: 1,
    category_name: 'ZvZ',
    created_by_id: 1,
    created_by_username: 'kris',
    updated_at: '2026-09-01T00:00:00Z',
    item_count: 9,
    main_item_count: 9,
    archived_at: null,
    weapon_key: null,
    weapon_name: null,
    ...overrides,
  };
}

describe('composition editing', () => {
  it('raises the quantity of a build added twice instead of listing it twice', () => {
    const once = addToComposition([], build(1));
    const twice = addToComposition(once, build(1));

    expect(twice).toHaveLength(1);
    expect(twice[0].quantity).toBe(2);
  });

  it('removes a build when its quantity drops to zero', () => {
    const list = addToComposition(addToComposition([], build(1)), build(2));

    expect(setQuantity(list, 1, 3).find((entry) => entry.build.id === 1)?.quantity).toBe(3);
    expect(setQuantity(list, 1, 0).map((entry) => entry.build.id)).toEqual([2]);
  });
});

describe('duplicate detection', () => {
  it('flags a build present in several versions', () => {
    const clashes = versionClashes([
      { build: build(1, { name: 'Healer', version: 3 }) },
      { build: build(2, { name: 'Healer', version: 1 }) },
      { build: build(3, { name: 'Tank' }) },
    ]);

    expect(clashes).toEqual([{ name: 'Healer', versions: [1, 3] }]);
  });

  it('finds the added builds a parent already contains', () => {
    const added = [
      { build: build(1), quantity: 1 },
      { build: build(2), quantity: 1 },
    ];

    expect(overlapWithParent(added, [{ build_id: 2, quantity: 5 }]).map((entry) => entry.build.id)).toEqual([2]);
  });
});

describe('compositionTotals', () => {
  it('counts the parent and the additions together, with parties of 20', () => {
    const totals = compositionTotals(
      [{ build: build(1, { role: 'tank' }), quantity: 15 }],
      [{ build: build(2, { role: 'healer' }), quantity: 8 }],
    );

    expect(totals.players).toBe(23);
    expect(totals.inheritedPlayers).toBe(15);
    expect(totals.addedPlayers).toBe(8);
    expect(totals.parties).toBe(2);
    expect(totals.partialParty).toBe(3);
    expect(roleMixText(totals.mix, (role) => role)).toBe('15 tank · 8 healer');
  });

  it('has no partial party when the last one is full', () => {
    expect(compositionTotals([], [{ build: build(1), quantity: 20 }]).partialParty).toBe(0);
  });
});

describe('validateCompDraft', () => {
  const valid = { name: 'ZvZ Mass', categoryId: 1, variant: false, parentId: null, buildCount: 2 };

  it('accepts a complete draft', () => {
    expect(validateCompDraft(valid, ['Other'])).toEqual([]);
  });

  it('lists everything that is missing, in form order', () => {
    const errors = validateCompDraft(
      { name: '  ', categoryId: null, variant: true, parentId: null, buildCount: 0 },
      [],
    );

    expect(errors.map((error) => error.field)).toEqual(['name', 'category', 'parent', 'builds']);
  });

  it('rejects a name that is too long or already used, ignoring case', () => {
    expect(validateCompDraft({ ...valid, name: 'x'.repeat(81) }, [])[0]).toEqual({
      field: 'name',
      code: 'tooLong',
    });
    expect(validateCompDraft({ ...valid, name: 'zvz mass' }, ['ZvZ Mass'])[0]).toEqual({
      field: 'name',
      code: 'taken',
    });
  });

  it('needs a parent only for a variant', () => {
    expect(validateCompDraft({ ...valid, variant: true }, []).map((error) => error.field)).toEqual(['parent']);
  });
});
