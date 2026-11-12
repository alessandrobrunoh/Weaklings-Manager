import { describe, expect, it } from 'vitest';

import { planCopyRole, stepOfField, validateBuildCreate } from './build-create-model';

describe('validateBuildCreate', () => {
  const valid = { name: 'Bear Paws', categoryId: 1, role: 'dps', hasWeapon: true } as const;

  it('accepts a complete draft', () => {
    expect(validateBuildCreate(valid, [])).toEqual([]);
  });

  it('requires a name, a category and a weapon, in step order', () => {
    const errors = validateBuildCreate({ ...valid, name: '', categoryId: null, hasWeapon: false }, []);

    expect(errors.map((error) => error.field)).toEqual(['name', 'category', 'weapon']);
    expect(errors.map((error) => stepOfField(error.field))).toEqual(['basics', 'basics', 'loadout']);
  });

  it('does not ask a battle mount for a weapon', () => {
    expect(validateBuildCreate({ ...valid, role: 'battle_mount', hasWeapon: false }, [])).toEqual([]);
  });

  it('rejects an existing name regardless of case', () => {
    expect(validateBuildCreate({ ...valid, name: 'bear paws' }, ['Bear Paws'])[0]).toEqual({
      field: 'name',
      code: 'taken',
    });
  });
});

describe('planCopyRole', () => {
  it('takes the role of the copied build when the officer has not chosen one, and says so', () => {
    expect(planCopyRole({ current: 'dps', touched: false, copied: 'healer' })).toEqual({
      role: 'healer',
      note: 'set',
    });
  });

  it('never overwrites a role the officer chose, and says it kept it', () => {
    expect(planCopyRole({ current: 'tank', touched: true, copied: 'healer' })).toEqual({
      role: 'tank',
      note: 'kept',
    });
  });

  it('has nothing to say when the roles match or nothing is copied', () => {
    expect(planCopyRole({ current: 'dps', touched: false, copied: 'dps' }).note).toBeNull();
    expect(planCopyRole({ current: 'dps', touched: true, copied: null }).note).toBeNull();
  });
});
