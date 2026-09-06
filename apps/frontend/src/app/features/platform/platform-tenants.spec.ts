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
        { provide: TranslateService, useValue: { t: (key: string) => key } },
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

  it('lists tenants and can suspend an active one', async () => {
    expect(api.get).toHaveBeenCalledWith('api/platform/tenants');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Weaklings');
    expect(compiled.textContent).toContain('Paused');

    const suspend = compiled.querySelector('button') as HTMLButtonElement;
    const buttons = Array.from(compiled.querySelectorAll('button'));
    const suspendBtn = buttons.find((button) => button.textContent?.includes('platform.tenants.suspend'));
    expect(suspendBtn).toBeTruthy();
    suspendBtn?.click();
    await fixture.whenStable();
    expect(api.patch).toHaveBeenCalledWith('api/platform/tenants/111', { status: 'suspended' });
    expect(toasts.success).toHaveBeenCalledWith('platform.tenants.updatedToast');
    expect(suspend).toBeTruthy();
  });

  it('creates a tenant from the dialog form', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const open = Array.from(compiled.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('platform.tenants.create'),
    );
    open?.click();
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
