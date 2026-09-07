import { describe, expect, it } from 'vitest';

import {
  ADMIN_ACCESS_PERMISSIONS,
  ADMIN_NAV_SECTIONS,
  APP_NAV_SECTIONS,
  PLATFORM_NAV_SECTIONS,
  filterNavSections,
  isAdminUrl,
  isPlatformUrl,
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

  it('hides optional modules when the tenant feature is off', () => {
    const visible = filterNavSections(
      APP_NAV_SECTIONS,
      () => true,
      false,
      (key) => key === 'splits',
    );
    const paths = visible.flatMap((section) => section.items.map((item) => item.path));
    expect(paths).toContain('/splits');
    expect(paths).not.toContain('/events');
    expect(paths).toContain('/dashboard');
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

  it('hides Platform without a platform role and shows it with one', () => {
    const hidden = filterNavSections(APP_NAV_SECTIONS, () => false, false);
    expect(hidden.flatMap((section) => section.items.map((item) => item.path))).not.toContain(
      '/platform',
    );
    const shown = filterNavSections(APP_NAV_SECTIONS, () => false, true);
    expect(shown.flatMap((section) => section.items.map((item) => item.path))).toContain(
      '/platform',
    );
  });
});

describe('isPlatformUrl', () => {
  it('matches the console root and its child panels', () => {
    expect(isPlatformUrl('/platform')).toBe(true);
    expect(isPlatformUrl('/platform/')).toBe(true);
    expect(isPlatformUrl('/platform/tenants')).toBe(true);
    expect(isPlatformUrl('/platform/tenants/1/features?x=1')).toBe(true);
    expect(isPlatformUrl('/platform/admins#top')).toBe(true);
  });

  it('does not treat similarly prefixed app routes as the console', () => {
    expect(isPlatformUrl('/dashboard')).toBe(false);
    expect(isPlatformUrl('/platforms')).toBe(false);
    expect(isPlatformUrl('/profile')).toBe(false);
    expect(isPlatformUrl('/admin')).toBe(false);
  });

  it('keeps the platform nav sections self-contained', () => {
    const paths = PLATFORM_NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.path));
    expect(paths).toContain('/platform');
    expect(paths).toContain('/platform/tenants');
    expect(paths).toContain('/platform/admins');
    expect(paths).toContain('/platform/ranks');
    expect(paths).toContain('/dashboard');
  });
});
