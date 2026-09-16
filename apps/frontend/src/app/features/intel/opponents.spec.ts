import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnemyGuildSummary, EnemyPlayerSummary, PaginatedData } from '../../core/models/api.models';
import { EnemiesService } from '../../core/services/enemies.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { Opponents } from './opponents';

function paginated<T>(items: T[]): PaginatedData<T> {
  return { items, total_items: items.length, total_pages: 1, current_page: 1, limit: 25 };
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
});
