import { provideZonelessChangeDetection, type Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { PlatformAdmins } from './platform-admins';
import { PlatformRanks } from './platform-ranks';
import { PlatformTenantDetail } from './platform-tenant-detail';
import { PlatformTenants } from './platform-tenants';

const tenant = {
  id: '123',
  name: 'Guild',
  slug: 'guild',
  schema_name: 'guild_123',
  status: 'active',
  owner_discord_id: '456',
  created_at: null,
  suspended_at: null,
  icon_hash: null,
  albion_guild_id: null,
  albion_api_region: 'europe',
  albion_allied_guild_ids: null,
  albion_allied_guild_names: null,
  rank_id: null,
  rank_name: null,
  is_default: false,
} as const;

function stubDialogApi(): void {
  if (typeof HTMLDialogElement === 'undefined') return;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

async function configure<T>(component: Type<T>): Promise<ComponentFixture<T>> {
  stubDialogApi();
  const api = {
    get: vi.fn((url: string) => {
      if (url === 'api/platform/tenants/123') return of(tenant);
      return of([]);
    }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  await TestBed.configureTestingModule({
    imports: [component],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: { profile: () => ({ id: '456' }) } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: TranslateService, useValue: { t: (key: string) => key } },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: { get: () => '123' } } },
      },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(component);
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe('platform required-field markers', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('marks the required tenant ID and name in the create dialog', async () => {
    const fixture = await configure(PlatformTenants);
    const compiled = fixture.nativeElement as HTMLElement;
    compiled.querySelector('app-page-header button')?.dispatchEvent(new Event('click'));
    fixture.detectChanges();

    const form = compiled.querySelector('#create-tenant-form') as HTMLFormElement;
    expect(form.textContent).toContain('validation.requiredLegend');
    expect(form.querySelectorAll('input[required]')).toHaveLength(2);
    expect(form.querySelectorAll('label [aria-hidden="true"]')).toHaveLength(2);
    expect(form.checkValidity()).toBe(false);
  });

  it('marks the required platform admin Discord ID', async () => {
    const fixture = await configure(PlatformAdmins);
    const compiled = fixture.nativeElement as HTMLElement;
    compiled.querySelector('app-page-header button')?.dispatchEvent(new Event('click'));
    fixture.detectChanges();

    const form = compiled.querySelector('#assign-admin-form') as HTMLFormElement;
    expect(form.textContent).toContain('validation.requiredLegend');
    expect((form.querySelector('input[required]') as HTMLInputElement).required).toBe(true);
    expect(form.querySelector('label [aria-hidden="true"]')?.textContent).toBe('*');
    expect(form.checkValidity()).toBe(false);
  });

  it('marks only the required rank name in the create dialog', async () => {
    const fixture = await configure(PlatformRanks);
    const compiled = fixture.nativeElement as HTMLElement;
    compiled.querySelector('app-page-header button')?.dispatchEvent(new Event('click'));
    fixture.detectChanges();

    const form = compiled.querySelector('#create-rank-form') as HTMLFormElement;
    expect(form.textContent).toContain('validation.requiredLegend');
    expect(form.querySelectorAll('input[required]')).toHaveLength(1);
    expect(form.querySelector('label [aria-hidden="true"]')?.textContent).toBe('*');
    expect(form.checkValidity()).toBe(false);
  });

  it('marks the required tenant name and owner while leaving rank optional', async () => {
    const fixture = await configure(PlatformTenantDetail);
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    // Overview tab: the display name is the only required field.
    const nameForm = compiled.querySelector('form') as HTMLFormElement;
    expect(nameForm.textContent).toContain('validation.requiredLegend');
    expect(nameForm.querySelectorAll('input[required]')).toHaveLength(1);
    expect(nameForm.querySelectorAll('label [aria-hidden="true"]')).toHaveLength(1);

    // Access tab: the SuperAdmin is required, the rank stays optional.
    compiled.querySelector<HTMLButtonElement>('button[role="tab"][data-tab-id="access"]')!.click();
    fixture.detectChanges();
    const accessForm = compiled.querySelector('form') as HTMLFormElement;
    expect(accessForm.textContent).toContain('validation.requiredLegend');
    expect(accessForm.querySelectorAll('input[required]')).toHaveLength(1);
    expect(accessForm.querySelector('select[required]')).toBeNull();
  });
});
