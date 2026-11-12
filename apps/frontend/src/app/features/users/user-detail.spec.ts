import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { UserDetailPage } from './user-detail';

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

describe('UserDetail', () => {
  let fixture: ComponentFixture<UserDetailPage>;
  let apiGet: ReturnType<typeof vi.fn>;
  let apiPost: ReturnType<typeof vi.fn>;
  let apiDelete: ReturnType<typeof vi.fn>;
  let hasPermission: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    stubDialogApi();
    apiGet = vi.fn().mockImplementation((path: string) => {
      if (path === 'api/users/42') {
        return of({ id: 42, username: 'Officer', email: 'o@x', role: 'Officer' });
      }
      if (path === 'api/users/42/weapons') {
        return of([]);
      }
      if (path === 'api/users/42/roles') {
        return of({
          discord_id: '9',
          highest_role: 'Officer',
          roles: [
            {
              role_id: 'officer',
              role_name: 'Officer',
              priority: 50,
              discord_role_id: '222',
              is_default: false,
              is_staff: false,
              grants_staff: true,
              held: true,
              assignable: true,
            },
            {
              role_id: 'staff',
              role_name: 'Staff',
              priority: 30,
              discord_role_id: '111',
              is_default: false,
              is_staff: true,
              grants_staff: false,
              held: true,
              assignable: false,
            },
          ],
        });
      }
      if (path.startsWith('api/progression/users/')) {
        return of(null);
      }
      if (path.startsWith('api/albion/link/users/')) {
        return of({ linked: false, albion_player_name: null });
      }
      return of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 10 });
    });
    apiPost = vi.fn().mockReturnValue(of({ discord_id: '9', highest_role: 'Officer', roles: [] }));
    apiDelete = vi.fn().mockReturnValue(of({ discord_id: '9', highest_role: 'User', roles: [] }));
    hasPermission = vi
      .fn()
      .mockImplementation(
        (perm: string) => perm === 'users.weapons.manage' || perm === 'roles.manage',
      );

    await TestBed.configureTestingModule({
      imports: [UserDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        TranslateService,
        { provide: ApiService, useValue: { get: apiGet, put: vi.fn(), post: apiPost, delete: apiDelete } },
        {
          provide: AuthService,
          useValue: {
            profile: vi.fn().mockReturnValue({
              id: '9',
              username: 'Viewer',
              avatar: null,
              email: null,
              user_id: 9,
              roles: ['Officer'],
              highest_role: 'Officer',
              is_superadmin: false,
              is_platform_admin: false,
              permissions: ['users.weapons.manage'],
            }),
            hasPermission,
          },
        },
        { provide: IntelService, useValue: { playerReport: vi.fn(), leaderboards: vi.fn() } },
        {
          provide: AlbionCatalogService,
          useValue: {
            load: vi.fn().mockResolvedValue([
              {
                id: 1,
                name: 'Bow',
                tier: 'T8',
                type: 'weapon',
                category_id: null,
                subcategory_id: null,
                identifier: 'T8_2H_BOW',
                icon: null,
              },
            ]),
          },
        },
      ],
    }).compileComponents();

    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(UserDetailPage);
    fixture.componentRef.setInput('userId', '42');
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it("loads another member's weapons from /users/:id, not /me", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
      await Promise.resolve();
      if (apiGet.mock.calls.some((call) => call[0] === 'api/users/42/weapons')) break;
    }
    expect(apiGet).toHaveBeenCalledWith('api/users/42/weapons');
    expect(apiGet.mock.calls.some((call) => call[0] === 'api/users/me/weapons')).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Weapons');
  });

  it('shows held Discord-linked roles and lets officers remove an assignable one', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
      await Promise.resolve();
      if ((fixture.nativeElement.textContent as string).includes('Staff ping (automatic)')) break;
    }
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Officer');
    expect(text).toContain('Staff');
    expect(text).toContain('Staff ping (automatic)');
    const remove = (fixture.nativeElement as HTMLElement).querySelector(
      'button[aria-label="Remove role Officer"]',
    ) as HTMLButtonElement | null;
    expect(remove).not.toBeNull();
    remove?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(apiDelete).toHaveBeenCalledWith('api/users/42/roles/officer');
  });

  it('lets an officer link a character from outside the guild found through the global search', async () => {
    const previous = apiGet.getMockImplementation() as (path: string) => unknown;
    apiGet.mockImplementation((path: string, params?: Record<string, unknown>) => {
      if (path === 'api/albion/guild/roster') {
        return of({ items: [{ id: 'g1', name: 'Gálvdon' }], total_items: 1 });
      }
      if (path === 'api/albion/search') {
        return of({
          guilds: [],
          players: [
            { id: 'g1', name: 'Gálvdon', guild_name: 'Weaklings', in_guild: true },
            { id: 'o1', name: 'Galvdon', guild_name: 'Elsewhere', in_guild: false },
          ],
          q: params?.['q'],
        });
      }
      return previous(path);
    });
    const cmp = fixture.componentInstance as unknown as {
      openLinkDialog: () => Promise<void>;
      onRosterSearchInput: (event: Event) => void;
      filteredRoster: () => { id: string; name: string }[];
      confirmLink: (player: { id: string; name: string }) => Promise<void>;
    };
    await cmp.openLinkDialog();
    const input = { target: { value: 'galv' } } as unknown as Event;
    cmp.onRosterSearchInput(input);
    // Roster hit shows immediately, diacritic-insensitively.
    expect(cmp.filteredRoster().map((p) => p.id)).toEqual(['g1']);
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(apiGet).toHaveBeenCalledWith('api/albion/search', { q: 'galv' });
    // Non-guild namesake is listed after the guild member, once.
    expect(cmp.filteredRoster().map((p) => p.id)).toEqual(['g1', 'o1']);

    await cmp.confirmLink({ id: 'o1', name: 'Galvdon' });
    expect(apiPost).toHaveBeenCalledWith('api/albion/link/users/42', {
      albion_player_id: 'o1',
      albion_player_name: 'Galvdon',
    });
  });

  it('keeps the guild roster hits when the global search fails', async () => {
    const previous = apiGet.getMockImplementation() as (path: string) => unknown;
    apiGet.mockImplementation((path: string) => {
      if (path === 'api/albion/guild/roster') {
        return of({ items: [{ id: 'g1', name: 'Kay' }], total_items: 1 });
      }
      if (path === 'api/albion/search') {
        return throwError(() => new Error('upstream down'));
      }
      return previous(path);
    });
    const cmp = fixture.componentInstance as unknown as {
      openLinkDialog: () => Promise<void>;
      onRosterSearchInput: (event: Event) => void;
      filteredRoster: () => { id: string }[];
    };
    await cmp.openLinkDialog();
    cmp.onRosterSearchInput({ target: { value: 'kay' } } as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(cmp.filteredRoster().map((p) => p.id)).toEqual(['g1']);
  });
});
