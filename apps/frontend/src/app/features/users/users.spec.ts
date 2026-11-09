import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
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

  it('labels role counts as current-page counts and provides a localized member link', async () => {
    fixture.destroy();
    apiGet.mockReturnValue(of({
      items: [{ id: 9, username: 'Kay', email: 'kay@example.com', role: 'Member' }],
      total_items: 50, total_pages: 5, current_page: 1, limit: 10,
    }));
    fixture = TestBed.createComponent(Users);
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent?.match(/common.currentPage/g)).toHaveLength(3);
    const link = element.querySelector('a[href="/users/9"]');
    expect(link?.textContent).toContain('common.view');
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

  it('shows the email column only to holders of users.create or roles.manage', async () => {
    const withEmails = of({
      items: [{ id: 9, username: 'Kay', email: 'kay@example.com', role: 'Member' }],
      total_items: 1, total_pages: 1, current_page: 1, limit: 10,
    });
    fixture.destroy();
    apiGet.mockReturnValue(withEmails);
    fixture = TestBed.createComponent(Users);
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('kay@example.com');

    fixture.destroy();
    hasPermission.mockReturnValue(false);
    apiGet.mockReturnValue(of({
      items: [{ id: 9, username: 'Kay', role: 'Member' }],
      total_items: 1, total_pages: 1, current_page: 1, limit: 10,
    }));
    fixture = TestBed.createComponent(Users);
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Kay');
    expect(element.textContent).not.toContain('common.email');
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

  it('searches every Albion player, not only the guild roster, and keeps the chosen name', async () => {
    const baseline = apiGet.getMockImplementation() as (path: string) => unknown;
    apiGet.mockImplementation((path: string) => {
      if (path === 'api/albion/search') {
        return of({
          guilds: [],
          players: [
            { id: 'p1', name: 'Kay', guild_name: 'Weaklings', in_guild: true },
            { id: 'o9', name: 'Kayla', guild_name: 'Elsewhere', in_guild: false },
          ],
        });
      }
      return baseline(path);
    });
    const cmp = fixture.componentInstance as unknown as {
      openCreate: () => void;
      onAlbionSearch: (text: string) => void;
      albionOptions: () => { id: string; label: string; hint?: string }[];
      selectedDiscordId: { set: (id: string) => void };
      selectedAlbionId: { set: (id: string) => void };
      createMember: (event: Event) => Promise<void>;
    };
    cmp.openCreate();
    await fixture.whenStable();
    expect(cmp.albionOptions().map((o) => o.id)).toEqual(['p1']);

    cmp.onAlbionSearch('kay');
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(apiGet).toHaveBeenCalledWith('api/albion/search', { q: 'kay' });
    expect(cmp.albionOptions().map((o) => o.id)).toEqual(['p1', 'o9']);
    expect(cmp.albionOptions()[1].hint).toBe('Elsewhere');

    cmp.selectedDiscordId.set('111');
    cmp.selectedAlbionId.set('o9');
    cmp.onAlbionSearch('');
    // The picked outsider stays selectable and named after the search is cleared.
    expect(cmp.albionOptions().map((o) => o.id)).toEqual(['o9', 'p1']);
    await cmp.createMember(new Event('submit'));
    expect(apiPost).toHaveBeenCalledWith('api/users', {
      discord_id: '111',
      albion_player_id: 'o9',
      albion_player_name: 'Kayla',
    });
  });

  it('falls back to the guild roster when the global search fails', async () => {
    const baseline = apiGet.getMockImplementation() as (path: string) => unknown;
    apiGet.mockImplementation((path: string) =>
      path === 'api/albion/search' ? throwError(() => new Error('down')) : baseline(path),
    );
    const cmp = fixture.componentInstance as unknown as {
      openCreate: () => void;
      onAlbionSearch: (text: string) => void;
      albionOptions: () => { id: string }[];
    };
    cmp.openCreate();
    await fixture.whenStable();
    cmp.onAlbionSearch('kay');
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(cmp.albionOptions().map((o) => o.id)).toEqual(['p1']);
  });

  it('marks both identity selectors as required and blocks an incomplete submission', async () => {
    const cmp = fixture.componentInstance as unknown as {
      openCreate: () => void;
      createMember: (event: Event) => Promise<void>;
    };
    cmp.openCreate();
    await fixture.whenStable();
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('validation.requiredLegend');
    expect(element.querySelectorAll('app-searchable-select button[aria-required="true"]')).toHaveLength(2);
    await cmp.createMember(new Event('submit'));
    expect(apiPost).not.toHaveBeenCalled();
  });
});
