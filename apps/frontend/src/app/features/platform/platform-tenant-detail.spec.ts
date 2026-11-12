import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformTenant, TenantFeaturesView } from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';
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
  is_default: false,
};

const mockFeatures: TenantFeaturesView = {
  catalog: [{ key: 'albion.sync', display_name: 'Albion sync', description: null }],
  flags: [{ key: 'albion.sync', enabled: false }],
};

/** Some test DOMs lack `HTMLDialogElement.showModal`, which the shared dialog calls to open. */
function stubDialogApi(): void {
  if (typeof HTMLDialogElement === 'undefined') {
    return;
  }
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    Object.defineProperty(this, 'open', { configurable: true, get: () => true });
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    Object.defineProperty(this, 'open', { configurable: true, get: () => false });
    this.dispatchEvent(new Event('close'));
  };
}

describe('PlatformTenantDetail', () => {
  let fixture: ComponentFixture<PlatformTenantDetail>;
  let api: {
    get: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function openTab(id: string): void {
    const tab = root().querySelector<HTMLButtonElement>(`button[role="tab"][data-tab-id="${id}"]`);
    expect(tab).toBeTruthy();
    tab!.click();
    fixture.detectChanges();
  }

  function createFixture(): void {
    fixture = TestBed.createComponent(PlatformTenantDetail);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    stubDialogApi();
    api = {
      get: vi.fn((path: string) => {
        if (path === 'api/platform/ranks') {
          return of([]);
        }
        if (path.endsWith('/features')) {
          return of(mockFeatures);
        }
        return of(mockTenant);
      }),
      patch: vi.fn().mockReturnValue(
        of({ ...mockTenant, owner_discord_id: '42', status: 'suspended' }),
      ),
      put: vi.fn().mockReturnValue(
        of({ ...mockFeatures, flags: [{ key: 'albion.sync', enabled: true }] }),
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

    createFixture();
    await settle();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('loads the tenant by id and shows the record on the overview tab', () => {
    expect(api.get).toHaveBeenCalledWith('api/platform/tenants/111');
    expect(root().querySelector('h1')?.textContent).toContain('Weaklings');
    expect(root().textContent).toContain('tenant_111');
    expect(root().querySelector('a[href="/platform/tenants"]')).toBeTruthy();
  });

  it('saves the SuperAdmin and rank from the access tab in one patch', async () => {
    openTab('access');
    const owner = root().querySelector('#tenant-owner') as HTMLInputElement;
    expect(owner.value).toBe('9');
    owner.value = '42';
    owner.dispatchEvent(new Event('input'));

    const form = root().querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(api.patch).toHaveBeenCalledWith('api/platform/tenants/111', {
      owner_discord_id: '42',
      rank_id: '',
      is_default: false,
    });
    expect(toasts.success).toHaveBeenCalledWith('platform.tenants.updatedToast');
  });

  it('confirms before suspending from the overflow menu', async () => {
    const trigger = root().querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    const items = Array.from(root().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const suspend = items.find(
      (item) => item.textContent?.includes('platform.tenants.suspend'),
    );
    expect(suspend).toBeTruthy();
    suspend!.click();
    fixture.detectChanges();

    expect(api.patch).not.toHaveBeenCalled();
    const confirm = root().querySelector('app-dialog .btn--danger') as HTMLButtonElement;
    expect(confirm).toBeTruthy();
    confirm.click();
    await settle();

    expect(api.patch).toHaveBeenCalledWith('api/platform/tenants/111', { status: 'suspended' });
  });

  it('loads feature flags when the features tab opens and saves them', async () => {
    openTab('features');
    await settle();
    expect(api.get).toHaveBeenCalledWith('api/platform/tenants/111/features');

    const checkbox = root().querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(false);
    checkbox.click();
    fixture.detectChanges();

    const form = root().querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(api.put).toHaveBeenCalledWith('api/platform/tenants/111/features', {
      flags: [{ key: 'albion.sync', enabled: true }],
    });
    expect(toasts.success).toHaveBeenCalledWith('platform.features.saved');
  });

  it('shows the not-found state when the tenant does not exist', async () => {
    fixture.destroy();
    api.get.mockImplementation((path: string) => {
      if (path === 'api/platform/ranks') {
        return of([]);
      }
      return throwError(() => new ApiError(404, 'tenant 111 not found'));
    });
    createFixture();
    await settle();

    expect(root().textContent).toContain('ui.errorState.notFound');
    expect(root().querySelector('a[href="/platform/tenants"]')).toBeTruthy();
    expect(root().querySelector('app-entity-header')).toBeNull();
  });
});
