import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantFeaturesView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AdminFeatures } from './admin-features';

const mockView: TenantFeaturesView = {
  catalog: [
    { key: 'splits', display_name: 'Splits', description: null },
    { key: 'events', display_name: 'Events', description: null },
    { key: 'intel', display_name: 'Intel', description: null },
    { key: 'sidebar', display_name: 'Tenant switcher', description: null },
  ],
  flags: [
    { key: 'splits', enabled: true },
    { key: 'events', enabled: true },
    { key: 'sidebar', enabled: true },
  ],
  rank_id: 'rank-gold',
  rank_name: 'Gold',
  allowed_keys: ['splits', 'events'],
};

describe('AdminFeatures', () => {
  let fixture: ComponentFixture<AdminFeatures>;
  let api: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = {
      get: vi.fn().mockReturnValue(of(mockView)),
      put: vi.fn().mockReturnValue(of(mockView)),
    };
    toasts = { success: vi.fn(), error: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [AdminFeatures],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: toasts },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminFeatures);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('lists every feature grouped by area, locking those outside the Rank and platform-managed ones', async () => {
    expect(api.get).toHaveBeenCalledWith('api/admin/features');
    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('Splits');
    expect(page.textContent).toContain('Intel');
    expect(page.querySelectorAll('h2').length).toBeGreaterThan(0);

    const splits = page.querySelector('#tenant-flag-splits') as HTMLInputElement;
    const intel = page.querySelector('#tenant-flag-intel') as HTMLInputElement;
    const sidebar = page.querySelector('#tenant-flag-sidebar') as HTMLInputElement;
    expect(splits.disabled).toBe(false);
    expect(intel.disabled).toBe(true);
    expect(intel.checked).toBe(false);
    expect(sidebar.disabled).toBe(true);
    expect(sidebar.checked).toBe(true);
    expect(page.textContent).toContain('admin.features.lock.rank');
    expect(page.textContent).toContain('admin.features.lock.platform');
  });

  it('saves only the editable rows and can disable one', async () => {
    const page = fixture.nativeElement as HTMLElement;
    const save = page.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(page.textContent).toContain('admin.features.noChanges');

    const events = page.querySelector('#tenant-flag-events') as HTMLInputElement;
    events.checked = false;
    events.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(page.textContent).toContain('admin.features.unsaved');

    const form = page.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(api.put).toHaveBeenCalledWith('api/admin/features', {
      flags: [
        { key: 'splits', enabled: true },
        { key: 'events', enabled: false },
      ],
    });
    expect(toasts.success).toHaveBeenCalledWith('admin.features.saved');
  });

  it('shows loading instead of an empty form, including on retry', async () => {
    fixture.destroy();
    const request = new Subject<TenantFeaturesView>();
    api.get.mockReturnValue(request);
    fixture = TestBed.createComponent(AdminFeatures);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('[role="status"]')?.textContent).toContain('common.loading');
    expect(page.querySelector('form')).toBeNull();
    request.error(new Error('offline'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(page.querySelector('[role="alert"]')?.textContent).toContain('common.error');
    expect(page.querySelector('form')).toBeNull();

    const retry = new Subject<TenantFeaturesView>();
    api.get.mockReturnValue(retry);
    (page.querySelector('app-error-state button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(page.querySelector('[role="status"]')?.textContent).toContain('common.loading');
    retry.next(mockView);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(page.textContent).toContain('Splits');
    expect(page.querySelector('#tenant-flag-splits')).not.toBeNull();
  });

  it('locks edits during save and retains them when saving fails', async () => {
    const request = new Subject<TenantFeaturesView>();
    api.put.mockReturnValue(request);
    const page = fixture.nativeElement as HTMLElement;
    const checkbox = page.querySelector('#tenant-flag-events') as HTMLInputElement;
    checkbox.click();
    (page.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    expect((page.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(page.textContent).toContain('common.loading');
    request.error(new Error('offline'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect((page.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    expect((page.querySelector('#tenant-flag-events') as HTMLInputElement).checked).toBe(false);
    expect(toasts.error).toHaveBeenCalledWith('admin.features.saveFailed');
  });
});
