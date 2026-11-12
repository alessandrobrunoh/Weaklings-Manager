import { describe, expect, it } from 'vitest';

import { groupPermissions, permissionParts } from './permission-groups';

describe('permissionParts', () => {
  it('takes the last segment as the verb and the middle as the object', () => {
    expect(permissionParts('comps.builds.edit')).toEqual({ verb: 'edit', object: 'builds' });
    expect(permissionParts('comps.build_categories.manage')).toEqual({
      verb: 'manage',
      object: 'build categories',
    });
  });

  it('leaves the object empty for two-segment keys', () => {
    expect(permissionParts('applications.manage')).toEqual({ verb: 'manage', object: '' });
    expect(permissionParts('bank.view_others')).toEqual({ verb: 'view_others', object: '' });
  });

  it('returns an empty verb for a key without a dot', () => {
    expect(permissionParts('reload')).toEqual({ verb: '', object: '' });
  });
});

describe('groupPermissions', () => {
  it('returns no groups when both catalog and available are empty', () => {
    expect(groupPermissions([], [])).toEqual([]);
    expect(groupPermissions(undefined, [])).toEqual([]);
  });

  it('falls back to splitting available keys on the first dot', () => {
    const groups = groupPermissions(undefined, ['roles.manage', 'roles.delete', 'audit.view']);
    expect(groups).toEqual([
      { resource: 'roles', keys: ['roles.manage', 'roles.delete'] },
      { resource: 'audit', keys: ['audit.view'] },
    ]);
  });

  it('prefers a non-empty catalog over available_permissions', () => {
    const groups = groupPermissions(
      [
        { key: 'roles.manage', resource: 'roles', action: 'manage' },
        { key: 'audit.view', resource: 'audit', action: 'view' },
      ],
      ['ignored.because.catalog.wins'],
    );
    expect(groups).toEqual([
      { resource: 'roles', keys: ['roles.manage'] },
      { resource: 'audit', keys: ['audit.view'] },
    ]);
  });

  it('treats keys without a dot as their own resource', () => {
    expect(groupPermissions(undefined, ['reload'])).toEqual([
      { resource: 'reload', keys: ['reload'] },
    ]);
  });
});
