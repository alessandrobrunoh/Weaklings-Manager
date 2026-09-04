import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { Settings } from './settings';

describe('Profile Destiny Board tab', () => {
  let fixture: ComponentFixture<Settings>;
  let apiGet: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    apiGet = vi.fn().mockImplementation((path: string) => {
      switch (path) {
        case 'api/bank/balance':
          return of({
            user_id: 7,
            pending_total: 0,
            pending_count: 0,
            requested_total: 0,
            requested_count: 0,
          });
        case 'api/bank/transactions':
        case 'api/battles/me':
          return of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 50 });
        case 'api/albion/link/me':
          return of({ linked: false, albion_player_name: null });
        case 'api/users/me/metrics':
          return of({
            most_played_build: null,
            events_attended: 0,
            total_estimated_loss: 0,
            top_estimated_loss: 0,
            events_total: 0,
            attendance_rate: 0,
            attendance_streak: 0,
            next_event_title: null,
            next_event_at: null,
            battles_fought: 0,
            kills: 0,
            deaths: 0,
            kill_fame: 0,
            regears_claimed: 0,
            regears_pending: 0,
            regears_approved: 0,
            regear_silver: 0,
            splits_joined: 0,
            split_earnings: 0,
          });
        case 'api/regear/me/summary':
          return of(null);
        case 'api/progression/me':
          return of(null);
        case 'api/users/me/specializations':
          return of([]);
        default:
          return of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 10 });
      }
    });

    await TestBed.configureTestingModule({
      imports: [Settings],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        TranslateService,
        {
          provide: ApiService,
          useValue: { get: apiGet, put: vi.fn(), post: vi.fn(), delete: vi.fn() },
        },
        {
          provide: AuthService,
          useValue: {
            profile: vi.fn().mockReturnValue({
              id: '1',
              username: 'Galvdon',
              avatar: null,
              email: null,
              user_id: 7,
              roles: ['Member'],
              highest_role: 'Member',
              is_superadmin: false,
              permissions: [],
            }),
            hasPermission: vi.fn().mockReturnValue(false),
          },
        },
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
    fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('shows a Destiny Board tab on the profile', () => {
    const labels = [...fixture.nativeElement.querySelectorAll('[role="tab"]')].map((tab) =>
      (tab as HTMLElement).textContent?.trim(),
    );
    expect(labels.some((label) => label?.includes('Destiny Board'))).toBe(true);
    expect(fixture.nativeElement.textContent).not.toContain('Gestisci specializzazioni');
  });

  it('loads the caller specializations from /me when the Destiny Board tab opens', async () => {
    const destinyTab = [...fixture.nativeElement.querySelectorAll('[role="tab"]')].find((tab) =>
      (tab as HTMLElement).textContent?.includes('Destiny Board'),
    ) as HTMLButtonElement;
    destinyTab.click();
    await settle(fixture, () => (fixture.nativeElement.textContent as string).includes('Weapons'));

    expect(apiGet).toHaveBeenCalledWith('api/users/me/specializations');
    expect(apiGet.mock.calls.some((call) => String(call[0]).includes('/users/7/specializations'))).toBe(
      false,
    );
    expect(fixture.nativeElement.textContent).toContain('Bows');
  });
});

async function settle(fixture: ComponentFixture<unknown>, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
    if (predicate()) return;
  }
  throw new Error(`view did not settle: ${fixture.nativeElement.textContent}`);
}
