import { describe, expect, it } from 'vitest';

import { isOwnershipScope, ownershipListParams, ownershipOptionLabel } from './ownership-scope';

describe('ownership scope', () => {
  it('accepts only mine and all', () => {
    expect(isOwnershipScope('mine')).toBe(true);
    expect(isOwnershipScope('all')).toBe(true);
    expect(isOwnershipScope('others')).toBe(false);
  });

  it('sends mine=true only for the mine scope', () => {
    expect(ownershipListParams('mine')).toEqual({ mine: true });
    expect(ownershipListParams('all')).toEqual({});
  });

  it('appends the creator only when listing everyone', () => {
    expect(ownershipOptionLabel('Heavy Mace', 'alice', 'mine')).toBe('Heavy Mace');
    expect(ownershipOptionLabel('Heavy Mace', 'alice', 'all')).toBe('Heavy Mace · alice');
    expect(ownershipOptionLabel('Heavy Mace', '', 'all')).toBe('Heavy Mace');
  });
});
