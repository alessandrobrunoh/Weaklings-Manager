import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionMatrix } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AdminPermissions } from './admin-permissions';

const mockMatrix: PermissionMatrix = {
  roles: [
    {
      role_id: 'officer',
      role_name: 'Officer',
      priority: 10,
      discord_role_id: '123456',
      is_default: false,
      permissions: ['splits.create', 'splits.delete', 'events.create'],
    },
    {
      role_id: 'member',
      role_name: 'Member',
      priority: 1,
      discord_role_id: null,
      is_default: true,
      permissions: ['splits.create'],
    },
  ],
  available_permissions: [
    'splits.create',
    'splits.delete',
    'splits.edit',
    'events.create',
    'events.delete',
    'admin.settings.manage',
  ],
  permission_catalog: [
    { key: 'splits.create', resource: 'splits', action: 'create' },
    { key: 'splits.delete', resource: 'splits', action: 'delete' },
    { key: 'splits.edit', resource: 'splits', action: 'edit' },
    { key: 'events.create', resource: 'events', action: 'create' },
    { key: 'events.delete', resource: 'events', action: 'delete' },
    { key: 'admin.settings.manage', resource: 'admin', action: 'settings.manage' },
  ],
};

describe('AdminPermissions', () => {
  let fixture: ComponentFixture<AdminPermissions>;
  let api: {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };
  let toasts: {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    api = {
      get: vi.fn().mockReturnValue(of(mockMatrix)),
      post: vi.fn().mockReturnValue(of('ok')),
      put: vi.fn().mockReturnValue(of(mockMatrix)),
    };

    toasts = {
      success: vi.fn(),
      error: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [AdminPermissions],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: toasts },
        {
          provide: TranslateService,
          useValue: {
            t: (key: string) => key,
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminPermissions);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('loads and renders the permission matrix table', () => {
    expect(api.get).toHaveBeenCalledWith('api/admin/permissions');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Officer');
    expect(compiled.textContent).toContain('Member');
    expect(compiled.textContent).toContain('splits.create');
    expect(compiled.textContent).toContain('events.create');
    expect(compiled.textContent).toContain('admin.settings.manage');
  });

  it('filters permissions by search query', async () => {
    const searchInput = fixture.nativeElement.querySelector('input[type="search"]') as HTMLInputElement;
    searchInput.value = 'splits';
    searchInput.dispatchEvent(new Event('input'));

    fixture.detectChanges();
    await fixture.whenStable();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('splits.create');
    expect(compiled.textContent).toContain('splits.delete');
    expect(compiled.textContent).not.toContain('events.create');
    expect(compiled.textContent).not.toContain('admin.settings.manage');
  });

  it('filters permissions by module selection', async () => {
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'events';
    select.dispatchEvent(new Event('change'));

    fixture.detectChanges();
    await fixture.whenStable();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('events.create');
    expect(compiled.textContent).toContain('events.delete');
    expect(compiled.textContent).not.toContain('splits.create');
  });

  it('collapses and expands accordion groups', async () => {
    const instance = fixture.componentInstance;
    expect(instance['isGroupCollapsed']('splits')).toBe(false);

    instance['toggleGroupCollapse']('splits');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(instance['isGroupCollapsed']('splits')).toBe(true);

    instance['expandAll']();
    expect(instance['isGroupCollapsed']('splits')).toBe(false);

    instance['collapseAll']();
    expect(instance['isGroupCollapsed']('splits')).toBe(true);
    expect(instance['isGroupCollapsed']('events')).toBe(true);
  });

  it('toggles role visibility', async () => {
    const instance = fixture.componentInstance;
    expect(instance['visibleRoles']().length).toBe(2);

    instance['toggleRoleVisibility']('member');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(instance['visibleRoles']().length).toBe(1);
    expect(instance['visibleRoles']()[0].role_id).toBe('officer');

    instance['selectAllRoles']();
    expect(instance['visibleRoles']().length).toBe(2);
  });

  it('reloads definitions when button is clicked', async () => {
    await fixture.componentInstance['reload']();

    expect(api.post).toHaveBeenCalledWith('api/admin/permissions/reload');
    expect(toasts.success).toHaveBeenCalled();
  });
});
