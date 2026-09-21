import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { Users } from './users';

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

describe('Users new member', () => {
  let fixture: ComponentFixture<Users>;
  let apiGet: ReturnType<typeof vi.fn>;
  let apiPost: ReturnType<typeof vi.fn>;
  let hasPermission: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    stubDialogApi();
    apiGet = vi.fn().mockImplementation((path: string) => {
      if (path === 'api/users') {
        return of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 10 });
      }
      if (path === 'api/admin/discord/members') {
        return of([
          {
            id: '111',
            username: 'nelly',
            global_name: 'Nelly',
            nick: null,
            display_name: 'Nelly',
            avatar: null,
          },
        ]);
      }
      if (path === 'api/albion/guild/roster') {
        return of({ items: [{ id: 'p1', name: 'Kay' }], total_items: 1, total_pages: 1, current_page: 1, limit: 500 });
      }
      return of([]);
    });
    apiPost = vi.fn().mockReturnValue(of({ id: 9, username: 'Kay', email: '111@discord.invalid', role: 'Member' }));
    hasPermission = vi.fn().mockImplementation((perm: string) => perm === 'users.create');

    await TestBed.configureTestingModule({
      imports: [Users],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: { get: apiGet, post: apiPost } },
        {
          provide: AuthService,
          useValue: { hasPermission, profile: () => null },
        },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Users);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('shows the new member action for admins with users.create', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('users.create');
  });

  it('hides the new member action without users.create', async () => {
    fixture.destroy();
    hasPermission.mockReturnValue(false);
    fixture = TestBed.createComponent(Users);
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).not.toContain('users.create');
  });

  it('creates a member from the selected Discord and Albion identities', async () => {
    const cmp = fixture.componentInstance as unknown as {
      openCreate: () => void;
      selectedDiscordId: { set: (id: string) => void };
      selectedAlbionId: { set: (id: string) => void };
      createMember: (event: Event) => Promise<void>;
    };
    cmp.openCreate();
    await fixture.whenStable();
    cmp.selectedDiscordId.set('111');
    cmp.selectedAlbionId.set('p1');
    await cmp.createMember(new Event('submit'));
    expect(apiPost).toHaveBeenCalledWith('api/users', {
      discord_id: '111',
      albion_player_id: 'p1',
      albion_player_name: 'Kay',
    });
  });
});
