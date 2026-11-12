import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformAdminView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { PlatformAdmins } from './platform-admins';

const mockAdmins: PlatformAdminView[] = [
  { discord_id: 'self', role_id: 'r1', role_name: 'SuperAdmin' },
  { discord_id: 'other', role_id: 'r1', role_name: 'SuperAdmin' },
];

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

function rowFor(compiled: HTMLElement, text: string): HTMLTableRowElement | undefined {
  return Array.from(compiled.querySelectorAll('tr')).find((tr) =>
    tr.textContent?.includes(text),
  ) as HTMLTableRowElement | undefined;
}

describe('PlatformAdmins', () => {
  let fixture: ComponentFixture<PlatformAdmins>;
  let compiled: HTMLElement;
  let api: {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    stubDialogApi();
    api = {
      get: vi.fn().mockReturnValue(of(mockAdmins)),
      post: vi.fn().mockReturnValue(
        of({ discord_id: '999', role_id: 'r1', role_name: 'SuperAdmin' } satisfies PlatformAdminView),
      ),
      delete: vi.fn().mockReturnValue(of(undefined)),
    };
    toasts = { success: vi.fn(), error: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [PlatformAdmins],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: toasts },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
        {
          provide: AuthService,
          useValue: { profile: () => ({ id: 'self' }), isPlatformAdmin: () => true },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PlatformAdmins);
    compiled = fixture.nativeElement as HTMLElement;
    await settle();
    await settle();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('lists admins with the add action in the header and no inline form', async () => {
    expect(api.get).toHaveBeenCalledWith('api/platform/admins');
    expect(compiled.textContent).toContain('self');
    expect(compiled.textContent).toContain('other');
    expect(compiled.querySelector('form')).toBeNull();
    expect(compiled.querySelector('app-page-header button')?.textContent).toContain(
      'platform.admins.assign',
    );
  });

  it('grants access from the dialog and shows the new admin in the table', async () => {
    compiled.querySelector('app-page-header button')?.dispatchEvent(new Event('click'));
    await settle();

    const form = compiled.querySelector('#assign-admin-form') as HTMLFormElement;
    expect(form).toBeTruthy();
    const input = compiled.querySelector('#assign-discord-id') as HTMLInputElement;
    input.value = '999';
    input.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(api.post).toHaveBeenCalledWith('api/platform/admins', { discord_id: '999' });
    expect(rowFor(compiled, '999')).toBeTruthy();
    expect(compiled.querySelector('#assign-admin-form')).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith('platform.admins.assigned');
  });

  it('rejects non-numeric IDs before calling the API', async () => {
    compiled.querySelector('app-page-header button')?.dispatchEvent(new Event('click'));
    await settle();

    const input = compiled.querySelector('#assign-discord-id') as HTMLInputElement;
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    await settle();

    expect(compiled.querySelector('#assign-discord-id-error')?.textContent).toContain(
      'platform.admins.idInvalid',
    );
    expect(input.getAttribute('aria-invalid')).toBe('true');
    (compiled.querySelector('#assign-admin-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('disables removing your own access in the row menu', async () => {
    const selfRow = rowFor(compiled, 'self');
    (selfRow?.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement).click();
    await settle();

    const item = compiled.querySelector('[role="menuitem"]') as HTMLButtonElement;
    expect(item.disabled).toBe(true);
  });

  it('removes another admin only after confirmation', async () => {
    const otherRow = rowFor(compiled, 'other');
    (otherRow?.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement).click();
    await settle();

    (compiled.querySelector('[role="menuitem"]') as HTMLButtonElement).click();
    await settle();

    expect(api.delete).not.toHaveBeenCalled();
    const confirm = compiled.querySelector('.btn--danger') as HTMLButtonElement;
    expect(confirm.textContent).toContain('platform.admins.remove');
    confirm.click();
    await settle();

    expect(api.delete).toHaveBeenCalledWith('api/platform/admins/other');
    expect(rowFor(compiled, 'other')).toBeUndefined();
    expect(toasts.success).toHaveBeenCalledWith('platform.admins.revoked');
  });

  it('keeps the admin when the removal confirmation is cancelled', async () => {
    const otherRow = rowFor(compiled, 'other');
    (otherRow?.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement).click();
    await settle();
    (compiled.querySelector('[role="menuitem"]') as HTMLButtonElement).click();
    await settle();

    const cancel = Array.from(compiled.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'common.cancel',
    ) as HTMLButtonElement;
    cancel.click();
    await settle();

    expect(api.delete).not.toHaveBeenCalled();
    expect(rowFor(compiled, 'other')).toBeTruthy();
  });
});
