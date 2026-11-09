import { describe, expect, it } from 'vitest';

import { canChangeAuthored } from './comp-access';

describe('canChangeAuthored', () => {
  const row = { created_by_id: 7 };

  it('lets the author act with the own-rows permission', () => {
    expect(canChangeAuthored(row, 7, true, false)).toBe(true);
  });

  it('refuses another member who only holds the own-rows permission', () => {
    expect(canChangeAuthored(row, 8, true, false)).toBe(false);
  });

  it('lets a manager act on anyone\'s row', () => {
    expect(canChangeAuthored(row, 8, false, true)).toBe(true);
    expect(canChangeAuthored(row, undefined, false, true)).toBe(true);
  });

  it('refuses the author without the permission, and signed-out callers', () => {
    expect(canChangeAuthored(row, 7, false, false)).toBe(false);
    expect(canChangeAuthored(row, undefined, true, false)).toBe(false);
    expect(canChangeAuthored(null, 7, true, false)).toBe(false);
  });
});
