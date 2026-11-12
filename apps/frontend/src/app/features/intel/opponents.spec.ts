import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnemyGuildSummary, EnemyPlayerSummary, PaginatedData } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { EnemiesService } from '../../core/services/enemies.service';
import { IntelService } from '../../core/services/intel.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { Opponents } from './opponents';

function paginated<T>(
  items: T[],
  totalItems = items.length,
  totalPages = 1,
  currentPage = 1,
): PaginatedData<T> {
  return { items, total_items: totalItems, total_pages: totalPages, current_page: currentPage, limit: 25 };
}

const guild: EnemyGuildSummary = {
  id: 7,
  guild_key: 'id:123',
  name: 'Weaklings Nemesis',
  current_alliance_name: 'Doom Alliance',
  first_seen_at: '2026-01-01T00:00:00Z',
  last_seen_at: '2026-06-01T00:00:00Z',
  is_watchlisted: true,
  battles_fought: 12,
  our_kills: 40,
  their_kills: 20,
};

const player: EnemyPlayerSummary = {
  id: 3,
  player_key: 'id:999',
  name: 'Nemesis Prime',
  current_enemy_guild_id: 7,
  current_enemy_guild_name: 'Weaklings Nemesis',
  role: 'tank',
  main_hand_item_id: 'T8_2H_HAMMER',
  item_power: 1400,
  first_seen_at: '2026-01-01T00:00:00Z',
  last_seen_at: '2026-06-01T00:00:00Z',
  battles_fought: 5,
  our_kills: 10,
  their_kills: 4,
};

async function settle(fixture: ComponentFixture<Opponents>): Promise<void> {
  for (let i = 0; i < 10; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
  }
  fixture.detectChanges();
}

describe('Opponents list page', () => {
  let fixture: ComponentFixture<Opponents>;
  let listGuilds: ReturnType<typeof vi.fn>;
  let listPlayers: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    listGuilds = vi.fn().mockReturnValue(of(paginated([guild])));
    listPlayers = vi.fn().mockReturnValue(of(paginated([player])));

    await TestBed.configureTestingModule({
      imports: [Opponents],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        TranslateService,
        { provide: EnemiesService, useValue: { listGuilds, listPlayers } },
        { provide: AuthService, useValue: { hasPermission: () => true } },
        {
          provide: IntelService,
          useValue: {
            listScouts: vi.fn().mockReturnValue(of(paginated([]))),
            matchups: vi.fn().mockReturnValue(of({ rows: [], coverage: { total_battles: 0, battles_with_comp: 0 } })),
            report: vi.fn().mockReturnValue(NEVER),
          },
        },
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      ],
    }).compileComponents();

    TestBed.inject(TranslateService).use('en');
  });

  afterEach(() => {
    fixture?.destroy();
  });

  it('shows a loading state before the guild list resolves', () => {
    listGuilds.mockReturnValue(NEVER);
    fixture = TestBed.createComponent(Opponents);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Loading…');
  });

  it('renders the populated guild table', async () => {
    fixture = TestBed.createComponent(Opponents);
    await settle(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Weaklings Nemesis');
    expect(text).toContain('Doom Alliance');
    expect(text).toContain('Watchlisted');
    expect(listGuilds).toHaveBeenCalled();
  });

  it('lazily loads the player table only when the Players tab is opened', async () => {
    fixture = TestBed.createComponent(Opponents);
    await settle(fixture);
    expect(listPlayers).not.toHaveBeenCalled();

    const page = fixture.componentInstance as unknown as { onTabChange: (tab: string) => void };
    page.onTabChange('players');
    await settle(fixture);

    expect(listPlayers).toHaveBeenCalled();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Nemesis Prime');
  });

  it('offers a human-readable guild picker and resets pagination when the filter changes', async () => {
    fixture = TestBed.createComponent(Opponents);
    await settle(fixture);

    const page = fixture.componentInstance as unknown as {
      onTabChange: (tab: string) => void;
      onPlayersPageChange: (event: { page: number; pageSize: number; search: string; sort: null }) => void;
    };
    page.onTabChange('players');
    await settle(fixture);

    const picker = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(picker.textContent).toContain('Weaklings Nemesis');
    expect(picker.textContent).toContain('All');

    page.onPlayersPageChange({ page: 4, pageSize: 25, search: '', sort: null });
    picker.value = '7';
    picker.dispatchEvent(new Event('change'));
    await settle(fixture);

    expect(listPlayers).toHaveBeenLastCalledWith(expect.objectContaining({ guild_id: 7, page: 1 }));
  });

  it('ignores invalid guild filter values rather than sending malformed ids', async () => {
    fixture = TestBed.createComponent(Opponents);
    await settle(fixture);

    const page = fixture.componentInstance as unknown as {
      onTabChange: (tab: string) => void;
      onGuildFilterChange: (event: Event) => void;
    };
    page.onTabChange('players');
    await settle(fixture);

    page.onGuildFilterChange({ target: { value: 'not-a-guild' } } as unknown as Event);
    await settle(fixture);

    expect(listPlayers).toHaveBeenLastCalledWith(expect.objectContaining({ guild_id: undefined }));
  });

  it('searches and paginates guild options beyond the first API page', async () => {
    fixture = TestBed.createComponent(Opponents);
    await settle(fixture);
    listGuilds.mockImplementation((params: { page?: number; search?: string }) => {
      if (params.search === 'Guild' && params.page === 2) {
        return of(paginated([{ ...guild, id: 26, name: 'Guild Twenty Six' }], 26, 2, 2));
      }
      if (params.search === 'Guild') {
        return of(paginated([{ ...guild, id: 1, name: 'Guild One' }], 26, 2, 1));
      }
      return of(paginated([guild]));
    });

    const page = fixture.componentInstance as unknown as {
      onTabChange: (tab: string) => void;
      onGuildFilterSearchInput: (event: Event) => void;
      searchGuildFilter: () => void;
      changeGuildFilterPage: (page: number) => void;
      onGuildFilterChange: (event: Event) => void;
    };
    page.onTabChange('players');
    await settle(fixture);

    page.onGuildFilterSearchInput({ target: { value: 'Guild' } } as unknown as Event);
    page.searchGuildFilter();
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('Page 1 of 2');

    page.changeGuildFilterPage(2);
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('Guild Twenty Six');
    expect(listGuilds).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 25, search: 'Guild' }));

    page.onGuildFilterChange({ target: { value: '26' } } as unknown as Event);
    await settle(fixture);
    expect(listPlayers).toHaveBeenLastCalledWith(expect.objectContaining({ guild_id: 26, page: 1 }));
  });

  it('shows a guild-options error and retries the failed request', async () => {
    fixture = TestBed.createComponent(Opponents);
    await settle(fixture);
    listGuilds.mockReturnValueOnce(throwError(() => new Error('offline')));

    const page = fixture.componentInstance as unknown as {
      onTabChange: (tab: string) => void;
      retryGuildFilterOptions: () => void;
    };
    page.onTabChange('players');
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong.');

    page.retryGuildFilterOptions();
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Weaklings Nemesis');
  });
  it('shows members only the scout views and never loads the officer dossiers', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [Opponents],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        TranslateService,
        { provide: EnemiesService, useValue: { listGuilds, listPlayers } },
        { provide: AuthService, useValue: { hasPermission: () => false } },
        {
          provide: IntelService,
          useValue: {
            listScouts: vi.fn().mockReturnValue(of(paginated([]))),
            matchups: vi.fn().mockReturnValue(of({ rows: [], coverage: { total_battles: 0, battles_with_comp: 0 } })),
            report: vi.fn().mockReturnValue(NEVER),
          },
        },
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).use('en');

    fixture = TestBed.createComponent(Opponents);
    await settle(fixture);

    const tabs = Array.from(fixture.nativeElement.querySelectorAll('[role="tab"]')).map(
      (tab) => (tab as HTMLElement).textContent?.trim(),
    );
    expect(tabs).toEqual(['Scouted comps', 'Matchups']);
    expect(listGuilds).not.toHaveBeenCalled();
  });
});
