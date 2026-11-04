import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantFeaturesView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { PlatformFeatureFlags } from './platform-feature-flags';

const mockView: TenantFeaturesView = {
  catalog: [
    { key: 'regolamento', display_name: 'Rules', description: 'Guild rules' },
    { key: 'splits.paid', display_name: 'Paid splits', description: null },
  ],
  flags: [{ key: 'regolamento', enabled: true }],
};

describe('PlatformFeatureFlags', () => {
  let fixture: ComponentFixture<PlatformFeatureFlags>;
  let api: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = {
      get: vi.fn().mockReturnValue(of(mockView)),
      put: vi.fn().mockReturnValue(
        of({
          ...mockView,
          flags: [
            { key: 'regolamento', enabled: false },
            { key: 'splits.paid', enabled: true },
          ],
        } satisfies TenantFeaturesView),
      ),
    };
    toasts = { success: vi.fn(), error: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [PlatformFeatureFlags],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: toasts },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ tenantId: '111' }) },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PlatformFeatureFlags);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('loads catalog flags and saves toggles', async () => {
    expect(api.get).toHaveBeenCalledWith('api/platform/tenants/111/features');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Rules');
    expect(compiled.textContent).toContain('Paid splits');

    const boxes = compiled.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    boxes[0].checked = false;
    boxes[0].dispatchEvent(new Event('change'));
    boxes[1].checked = true;
    boxes[1].dispatchEvent(new Event('change'));

    const form = compiled.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(api.put).toHaveBeenCalledWith('api/platform/tenants/111/features', {
      flags: [
        { key: 'regolamento', enabled: false },
        { key: 'splits.paid', enabled: true },
      ],
    });
    expect(toasts.success).toHaveBeenCalledWith('platform.features.saved');
  });

  it('shows loading until the catalog arrives', async () => {
    fixture.destroy();
    const request = new Subject<TenantFeaturesView>();
    api.get.mockReturnValue(request);
    fixture = TestBed.createComponent(PlatformFeatureFlags);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('[role="status"]')?.textContent).toContain('common.loading');
    expect(page.querySelector('form')).toBeNull();
    request.next(mockView);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(page.textContent).toContain('Rules');
  });

  it('prevents edits during save and keeps changes after failure', async () => {
    const request = new Subject<TenantFeaturesView>();
    api.put.mockReturnValue(request);
    const page = fixture.nativeElement as HTMLElement;
    (page.querySelector('#flag-regolamento') as HTMLInputElement).click();
    (page.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    expect((page.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    request.error(new Error('offline'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect((page.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    expect((page.querySelector('#flag-regolamento') as HTMLInputElement).checked).toBe(false);
    expect(toasts.error).toHaveBeenCalled();
  });
});
