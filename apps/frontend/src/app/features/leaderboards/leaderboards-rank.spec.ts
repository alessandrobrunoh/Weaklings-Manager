import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import { SeasonOverview } from './leaderboards';

describe('SeasonOverview guild rank', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the member-facing configured guild rank separately from leaderboard position', async () => {
    const season = {
      id: 1,
      name: 'Season 35',
      starts_at: '2026-01-01T00:00:00Z',
      ends_at: '2026-12-31T23:59:59Z',
      is_active: true,
    };
    const api = {
      get: (url: string) => of(url === 'api/progression/seasons'
        ? [season]
        : url === 'api/progression/me'
          ? {
              season,
              level: 10,
              xp: 1_860,
              xp_to_next: 340,
              next_level_at: 2_200,
              rank: 12,
              multiplier: 1,
              lifetime_xp: 1_860,
              guild_rank: {
                name: 'Veteran',
                min_xp: 1_500,
                discord_role_id: '12345678901234567',
              },
            }
          : { items: [], total_items: 0 }),
    };
    const intel = {
      leaderboards: () => of({
        split_earnings: [],
        silver_lost: [],
        kills: [],
        attendance: [],
        kill_fame: [],
        death_fame: [],
        siphoned: [],
      }),
      report: () => of({ overview: null, operations: null }),
    };
    await TestBed.configureTestingModule({
      imports: [SeasonOverview],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { hasPermission: () => true } },
        { provide: IntelService, useValue: intel },
        {
          provide: TranslateService,
          useValue: {
            t: (key: string, params?: Record<string, string | number>) => {
              if (key === 'season.hero.guildRank') return `Guild rank: ${params?.['rank']}`;
              if (key === 'season.hero.myRank') return `Rank #${params?.['rank']}`;
              return key;
            },
          },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(SeasonOverview);
    await fixture.whenStable();
    fixture.detectChanges();

    const standing = fixture.nativeElement.querySelector('.season-standing') as HTMLElement;
    expect(standing.textContent).toContain('Guild rank: Veteran');
    expect(standing.textContent).toContain('Rank #12');
  }, 20_000);
});
