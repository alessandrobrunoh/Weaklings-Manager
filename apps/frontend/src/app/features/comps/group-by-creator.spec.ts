import { describe, expect, it } from 'vitest';

import { groupBuildsByCreator } from './group-by-creator';

function build(
  id: number,
  name: string,
  created_by_username: string,
): { id: number; name: string; created_by_username: string } {
  return { id, name, created_by_username };
}

describe('groupBuildsByCreator', () => {
  it('groups by creator then name and keeps homonyms from different creators', () => {
    const grouped = groupBuildsByCreator([
      build(2, 'Heavy Mace', 'bob'),
      build(1, 'Heavy Mace', 'alice'),
      build(3, 'Light Mace', 'alice'),
    ]);

    expect(grouped.map((group) => group.creator)).toEqual(['alice', 'bob']);
    expect(grouped[0]?.items.map((item) => item.name)).toEqual(['Heavy Mace', 'Light Mace']);
    expect(grouped[1]?.items.map((item) => item.id)).toEqual([2]);
  });

  it('does not hide a second active build that shares a name', () => {
    const grouped = groupBuildsByCreator([
      build(1, 'Heavy Mace', 'alice'),
      build(2, 'Heavy Mace', 'bob'),
    ]);

    expect(grouped.flatMap((group) => group.items)).toHaveLength(2);
  });

  it('returns no sections for an empty list', () => {
    expect(groupBuildsByCreator([])).toEqual([]);
  });
});
