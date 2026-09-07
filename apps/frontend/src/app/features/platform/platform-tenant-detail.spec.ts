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
  albion_guild_id: 'alb-1',
  albion_api_region: 'europe',
  icon_hash: 'abc',
  albion_allied_guild_ids: 'a,b',
  albion_allied_guild_names: 'Ally',
};

describe('PlatformTenantDetail', () => {
  let fixture: ComponentFixture<PlatformTenantDetail>;
  let api: { get: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = {
      get: vi.fn((path: string) => {
        if (path === 'api/platform/ranks') {
          return of([]);
        }
        return of(mockTenant);
      }),
      patch: vi.fn().mockReturnValue(
        of({
          ...mockTenant,
          name: 'Renamed',
          owner_discord_id: '42',
          status: 'suspended',
        }),
      ),
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

  it('loads the tenant by id and can save SuperAdmin and Albion fields', async () => {
    expect(api.get).toHaveBeenCalledWith('api/platform/tenants/111');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Weaklings');
    expect(compiled.textContent).toContain('tenant_111');
    expect((compiled.querySelector('#tenant-owner') as HTMLInputElement).value).toBe('9');
    expect((compiled.querySelector('#tenant-albion-guild') as HTMLInputElement).value).toBe(
      'alb-1',
    );
    expect(compiled.querySelector('a[href="/platform/tenants/111/features"]')).toBeTruthy();

    const nameInput = compiled.querySelector('#tenant-name') as HTMLInputElement;
    nameInput.value = 'Renamed';
    nameInput.dispatchEvent(new Event('input'));
    const ownerInput = compiled.querySelector('#tenant-owner') as HTMLInputElement;
    ownerInput.value = '42';
    ownerInput.dispatchEvent(new Event('input'));
    const form = compiled.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.patch).toHaveBeenCalledWith('api/platform/tenants/111', {
      name: 'Renamed',
      owner_discord_id: '42',
      albion_guild_id: 'alb-1',
      albion_api_region: 'europe',
      albion_allied_guild_ids: 'a,b',
      albion_allied_guild_names: 'Ally',
      rank_id: '',
    });
    expect(toasts.success).toHaveBeenCalledWith('platform.tenants.updatedToast');
  });
});
