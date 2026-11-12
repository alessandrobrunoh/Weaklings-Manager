import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformTenant } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { PlatformTenants } from './platform-tenants';

const mockTenants: PlatformTenant[] = [
  {
    id: '111',
    name: 'Weaklings',
    slug: 'weaklings',
    schema_name: 'tenant_111',
    status: 'active',
    kind: 'guild',
    owner_discord_id: '9',
    created_at: '2026-01-01',
    suspended_at: null,
  },
  {
    id: '222',
    name: 'Paused',
    slug: 'paused',
    schema_name: 'tenant_222',
    status: 'suspended',
    kind: 'alliance',
    owner_discord_id: null,
    created_at: '2026-02-01',
    suspended_at: '2026-03-01',
  },
];

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

function buttonWithText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes(text));
}

describe('PlatformTenants', () => {
  let fixture: ComponentFixture<PlatformTenants>;
  let api: {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
  };
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    stubDialogApi();
    api = {
      get: vi.fn().mockReturnValue(of(mockTenants)),
      post: vi.fn().mockReturnValue(
        of({
          id: '333',
          name: 'New Guild',
          slug: '333',
          schema_name: 'tenant_333',
          status: 'active',
          kind: 'guild',
          owner_discord_id: '9',
          created_at: '2026-04-01',
          suspended_at: null,
        } satisfies PlatformTenant),
      ),
      patch: vi.fn().mockReturnValue(of({ ...mockTenants[0], status: 'suspended' })),
    };
    toasts = { success: vi.fn(), error: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [PlatformTenants],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: toasts },
        { provide: TranslateService, useValue: { t: (key: string) => key, locale: () => 'en' } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PlatformTenants);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('lists tenants with kind, status and summary counts', () => {
    expect(api.get).toHaveBeenCalledWith('api/platform/tenants');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('app-summary-band')).toBeTruthy();
    expect(compiled.textContent).toContain('Weaklings');
    expect(compiled.textContent).toContain('Paused');
    expect(compiled.textContent).toContain('platform.tenants.kind.alliance');
    expect(compiled.querySelector('app-status-chip')).toBeTruthy();

    const nameLink = compiled.querySelector('a[href="/platform/tenants/111"]');
    expect(nameLink?.textContent).toContain('Weaklings');
  });

  it('filters rows by search text and by the kind facet', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const search = compiled.querySelector('[role="search"] input') as HTMLInputElement;
    search.value = 'paused';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(compiled.textContent).toContain('Paused');
    expect(compiled.textContent).not.toContain('Weaklings');

    search.value = '';
    search.dispatchEvent(new Event('input'));
    const kind = compiled.querySelector('select') as HTMLSelectElement;
    kind.value = 'guild';
    kind.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(compiled.textContent).toContain('Weaklings');
    expect(compiled.textContent).not.toContain('Paused');
  });

  it('suspends an active tenant from its row menu', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const trigger = compiled.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();

    const suspend = Array.from(compiled.querySelectorAll('button[role="menuitem"]')).find((item) =>
      item.textContent?.includes('platform.tenants.suspend'),
    ) as HTMLButtonElement | undefined;
    expect(suspend).toBeTruthy();
    suspend?.click();
    await fixture.whenStable();

    expect(api.patch).toHaveBeenCalledWith('api/platform/tenants/111', { status: 'suspended' });
    expect(toasts.success).toHaveBeenCalledWith('platform.tenants.updatedToast');
  });

  it('creates a tenant from the dialog form', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    buttonWithText(compiled, 'platform.tenants.create')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const idInput = compiled.querySelector('#tenant-id') as HTMLInputElement;
    const nameInput = compiled.querySelector('#tenant-name') as HTMLInputElement;
    idInput.value = '333';
    idInput.dispatchEvent(new Event('input'));
    nameInput.value = 'New Guild';
    nameInput.dispatchEvent(new Event('input'));

    const form = compiled.querySelector('#create-tenant-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.post).toHaveBeenCalledWith('api/platform/tenants', {
      id: '333',
      name: 'New Guild',
      slug: undefined,
    });
    expect(toasts.success).toHaveBeenCalledWith('platform.tenants.createdToast');
    expect(compiled.textContent).toContain('New Guild');
  });
});
