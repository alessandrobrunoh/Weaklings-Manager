import { describe, expect, it } from 'vitest';

import {
  summarizeErrors,
  validateBuildDraft,
  validateBuildName,
  type BuildDraft,
} from './build-validation';

const draft = (over: Partial<BuildDraft> = {}): BuildDraft => ({
  name: 'Bear Paws',
  categoryId: 1,
  role: 'brawler',
  filledSlots: ['weapon', 'head'],
  ...over,
});

describe('validateBuildName', () => {
  it('rejects an empty or whitespace-only name', () => {
    expect(validateBuildName('', { existingNames: [] })?.field).toBe('name');
    expect(validateBuildName('   ', { existingNames: [] })?.field).toBe('name');
  });

  it('rejects a duplicate regardless of case or padding', () => {
    const error = validateBuildName('  bear paws ', { existingNames: ['Bear Paws'] });
    expect(error?.message).toContain('already exists');
  });

  it('lets a build keep its own name while editing', () => {
    const error = validateBuildName('Bear Paws', {
      existingNames: ['Bear Paws'],
      currentName: 'Bear Paws',
    });
    expect(error).toBeNull();
  });

  it('rejects an over-long name', () => {
    expect(validateBuildName('x'.repeat(81), { existingNames: [] })?.field).toBe('name');
  });

  it('accepts an ordinary new name', () => {
    expect(validateBuildName('Grovekeeper', { existingNames: ['Bear Paws'] })).toBeNull();
  });
});

describe('validateBuildDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateBuildDraft(draft(), { existingNames: [] })).toEqual([]);
  });

  /** The weapon defines the build's role and cost, so it cannot be optional. */
  it('rejects a build with no weapon', () => {
    const errors = validateBuildDraft(draft({ filledSlots: ['head', 'shoes'] }), {
      existingNames: [],
    });
    expect(errors.map((e) => e.field)).toContain('items');
  });

  it('accepts a build carrying only a weapon', () => {
    const errors = validateBuildDraft(draft({ filledSlots: ['weapon'] }), { existingNames: [] });
    expect(errors).toEqual([]);
  });

  it('requires a category by default and can be told not to', () => {
    const missing = draft({ categoryId: null });
    expect(validateBuildDraft(missing, { existingNames: [] }).map((e) => e.field)).toContain(
      'category',
    );
    expect(
      validateBuildDraft(missing, { existingNames: [], requireCategory: false }).map(
        (e) => e.field,
      ),
    ).not.toContain('category');
  });

  it('requires a role', () => {
    const errors = validateBuildDraft(draft({ role: '  ' }), { existingNames: [] });
    expect(errors.map((e) => e.field)).toContain('role');
  });

  it('reports every problem at once rather than the first', () => {
    const errors = validateBuildDraft(
      draft({ name: '', categoryId: null, role: '', filledSlots: [] }),
      { existingNames: [] },
    );
    expect(errors).toHaveLength(4);
    expect(summarizeErrors(errors)).toContain('Name is required.');
  });
});
