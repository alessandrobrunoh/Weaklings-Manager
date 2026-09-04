import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { UserDetailPage } from './user-detail';

describe('UserDetail Destiny Board', () => {
  let fixture: ComponentFixture<UserDetailPage>;
  let apiGet: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    apiGet = vi.fn().mockImplementation((path: string) => {
      if (path === 'api/users/42') {
        return of({ id: 42, username: 'Officer', email: 'o@x', role: 'Officer' });
      }
      if (path === 'api/users/42/specializations') {
        return of([]);
      }
      if (path.startsWith('api/progression/users/')) {
        return of(null);
      }
      if (path.startsWith('api/albion/link/users/')) {
        return of({ linked: false, albion_player_name: null });
      }
      return of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 10 });
    });

    await TestBed.configureTestingModule({
      imports: [UserDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        TranslateService,
        { provide: ApiService, useValue: { get: apiGet, put: vi.fn(), post: vi.fn(), delete: vi.fn() } },
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
              permissions: ['users.specializations.manage'],
            }),
            hasPermission: vi.fn().mockImplementation((perm: string) => perm === 'users.specializations.manage'),
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

  it('loads another member specializations from /users/:id, not /me', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
      await Promise.resolve();
      if ((fixture.nativeElement.textContent as string).includes('Destiny Board')) break;
    }
    expect(apiGet).toHaveBeenCalledWith('api/users/42/specializations');
    expect(apiGet.mock.calls.some((call) => call[0] === 'api/users/me/specializations')).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Destiny Board');
    expect(fixture.nativeElement.textContent).toContain('Weapons');
  });
});
