import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import { SeasonOverview } from './leaderboards';

const season = {
  id: 1,
  name: 'Season 35',
  starts_at: '2026-01-01T00:00:00Z',
  ends_at: '2026-12-31T23:59:59Z',
  is_active: true,
};

/** Mounts the page with empty Intel boards and records the window each Intel call receives. */
async function mount(options: { leaderboardItems?: unknown[] } = {}) {
  const intelWindows: Array<[string | undefined, string | undefined]> = [];
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
        : { items: options.leaderboardItems ?? [], total_items: (options.leaderboardItems ?? []).length }),
  };
  const intel = {
    leaderboards: (from?: string, to?: string) => {
      intelWindows.push([from, to]);
      return of({
        split_earnings: [],
        silver_lost: [],
        kills: [],
        attendance: [],
        kill_fame: [],
        death_fame: [],
        siphoned: [],
        regear_silver: [],
      });
    },
    report: (from?: string, to?: string) => {
      intelWindows.push([from, to]);
      return of({ overview: null, operations: null });
    },
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
  return { fixture, intelWindows };
}

describe('SeasonOverview', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the member-facing configured guild rank separately from leaderboard position', async () => {
    const { fixture } = await mount();

    const standing = fixture.nativeElement.querySelector('.season-standing') as HTMLElement;
    expect(standing.textContent).toContain('Guild rank: Veteran');
    expect(standing.textContent).toContain('Rank #12');
  }, 20_000);

  it('scopes the Intel boards and report to the active season window', async () => {
    const { intelWindows } = await mount();

    expect(intelWindows.length).toBeGreaterThan(0);
    for (const [from, to] of intelWindows) {
      expect(from).toBe(season.starts_at);
      expect(to).toBe(season.ends_at);
    }
  }, 20_000);

  it('explains an empty ranking instead of rendering a blank panel', async () => {
    const { fixture } = await mount();

    const empty = fixture.nativeElement.querySelector('app-empty-state') as HTMLElement | null;
    expect(empty?.textContent).toContain('season.empty.season');
    expect(fixture.nativeElement.querySelector('app-data-table')).toBeNull();
  }, 20_000);

  it('renders the ranking table with no podium when entries exist', async () => {
    const { fixture } = await mount({
      leaderboardItems: [
        { user_id: 1, username: 'Alpha', xp: 900, level: 9, rank: 1 },
        { user_id: 2, username: 'Bravo', xp: 500, level: 6, rank: 2 },
      ],
    });

    expect(fixture.nativeElement.querySelector('.podium')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-empty-state')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-data-table')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.rankings-tabs')).toBeNull();
  }, 20_000);
});
