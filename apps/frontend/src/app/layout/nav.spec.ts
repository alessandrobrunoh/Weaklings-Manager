import { describe, expect, it } from 'vitest';

import {
  ADMIN_ACCESS_PERMISSIONS,
  ADMIN_NAV_SECTIONS,
  APP_NAV_SECTIONS,
  filterNavSections,
  isAdminUrl,
} from './nav';

describe('isAdminUrl', () => {
  it('matches the console root and its child panels', () => {
    expect(isAdminUrl('/admin')).toBe(true);
    expect(isAdminUrl('/admin/')).toBe(true);
    expect(isAdminUrl('/admin/roles')).toBe(true);
    expect(isAdminUrl('/admin/permissions?reload=1')).toBe(true);
    expect(isAdminUrl('/admin/discord#autorole')).toBe(true);
    expect(isAdminUrl('/users')).toBe(true);
    expect(isAdminUrl('/users/')).toBe(true);
    expect(isAdminUrl('/users/123')).toBe(true);
    expect(isAdminUrl('/users/abc-456?tab=xp#top')).toBe(true);
  });

  it('does not treat similarly prefixed app routes as the console', () => {
    expect(isAdminUrl('/dashboard')).toBe(false);
    expect(isAdminUrl('/administrator')).toBe(false);
    expect(isAdminUrl('/admins')).toBe(false);
    expect(isAdminUrl('/users-list')).toBe(false);
    expect(isAdminUrl('/profile')).toBe(false);
    expect(isAdminUrl('/')).toBe(false);
  });
});

describe('filterNavSections', () => {
  it('keeps ungated items and drops items the session cannot reach', () => {
    const visible = filterNavSections(ADMIN_NAV_SECTIONS, (permission) =>
      permission === 'progression.settings.manage',
    );
    const paths = visible.flatMap((section) => section.items.map((item) => item.path));
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/admin');
    expect(paths).toContain('/admin/progression');
    expect(paths).not.toContain('/admin/roles');
    expect(paths).not.toContain('/admin/permissions');
    expect(paths).not.toContain('/admin/discord');
  });

  it('hides the Admin entry on the app nav without any admin permission', () => {
    const visible = filterNavSections(APP_NAV_SECTIONS, () => false);
    const paths = visible.flatMap((section) => section.items.map((item) => item.path));
    expect(paths).not.toContain('/admin');
    expect(paths).toContain('/dashboard');
  });

  it('shows Admin when any console permission is present', () => {
    const visible = filterNavSections(APP_NAV_SECTIONS, (permission) =>
      permission === 'autorole.manage',
    );
    const paths = visible.flatMap((section) => section.items.map((item) => item.path));
    expect(paths).toContain('/admin');
    expect(ADMIN_ACCESS_PERMISSIONS).toContain('autorole.manage');
  });
});
