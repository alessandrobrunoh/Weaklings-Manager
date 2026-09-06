import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformTenant } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { PlatformTenantDetail } from './platform-tenant-detail';

const mockTenant: PlatformTenant = {
  id: '111',
  name: 'Weaklings',
  slug: 'weaklings',
  schema_name: 'tenant_111',
  status: 'active',
  owner_discord_id: '9',
  created_at: '2026-01-01',
  suspended_at: null,
};

describe('PlatformTenantDetail', () => {
  let fixture: ComponentFixture<PlatformTenantDetail>;
  let api: { get: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = {
      get: vi.fn().mockReturnValue(of([mockTenant])),
      patch: vi.fn().mockReturnValue(of({ ...mockTenant, name: 'Renamed', status: 'suspended' })),
    };
    toasts = { success: vi.fn(), error: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [PlatformTenantDetail],
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

    fixture = TestBed.createComponent(PlatformTenantDetail);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('loads the tenant and can rename it', async () => {
    expect(api.get).toHaveBeenCalledWith('api/platform/tenants');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Weaklings');
    expect(compiled.querySelector('a[href="/platform/tenants/111/features"]')).toBeTruthy();

    const input = compiled.querySelector('#rename-tenant') as HTMLInputElement;
    input.value = 'Renamed';
    input.dispatchEvent(new Event('input'));
    const form = compiled.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.patch).toHaveBeenCalledWith('api/platform/tenants/111', { name: 'Renamed' });
    expect(toasts.success).toHaveBeenCalledWith('platform.tenants.updatedToast');
  });
});
