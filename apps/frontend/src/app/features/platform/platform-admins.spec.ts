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

describe('PlatformAdmins', () => {
  let fixture: ComponentFixture<PlatformAdmins>;
  let api: {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
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
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('lists admins, assigns a new one, and revokes another', async () => {
    expect(api.get).toHaveBeenCalledWith('api/platform/admins');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('self');
    expect(compiled.textContent).toContain('other');

    const input = compiled.querySelector('#assign-discord-id') as HTMLInputElement;
    input.value = '999';
    input.dispatchEvent(new Event('input'));
    const form = compiled.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.post).toHaveBeenCalledWith('api/platform/admins', { discord_id: '999' });
    expect(compiled.textContent).toContain('999');

    const revoke = Array.from(compiled.querySelectorAll('button')).find(
      (button) =>
        button.textContent?.includes('platform.admins.revoke') && !button.disabled,
    );
    revoke?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.delete).toHaveBeenCalledWith('api/platform/admins/other');
    expect(compiled.textContent).not.toContain('other');
  });
});
