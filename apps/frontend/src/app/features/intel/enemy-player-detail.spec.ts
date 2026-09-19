import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnemyPlayerDossier } from '../../core/models/api.models';
import { ApiError } from '../../core/services/api.service';
import { EnemiesService } from '../../core/services/enemies.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { EnemyPlayerDetailPage } from './enemy-player-detail';

const dossier: EnemyPlayerDossier = {
  id: 3,
  player_key: 'id:999',
  albion_player_id: '999',
  name: 'Nemesis Prime',
  identity_source: 'player_id',
  current_enemy_guild_id: 7,
  current_enemy_guild_name: 'Weaklings Nemesis',
  first_seen_at: '2026-01-01T00:00:00Z',
  last_seen_at: '2026-06-01T00:00:00Z',
  is_watchlisted: false,
  notes: null,
  battles_fought: 5,
  our_kills: 10,
  their_kills: 4,
  battles: [
    {
      battle_id: 555,
      occurred_at: '2026-06-01T00:00:00Z',
      role: 'tank',
      main_hand_item_id: 'T8_2H_HAMMER',
      item_power: 1400,
      our_kills_on_them: 2,
      their_kills_on_us: 1,
    },
    {
      battle_id: 444,
      occurred_at: '2026-05-01T00:00:00Z',
      role: null,
      main_hand_item_id: null,
      item_power: 1300,
      our_kills_on_them: 0,
      their_kills_on_us: 1,
    },
  ],
};

async function settle(fixture: ComponentFixture<EnemyPlayerDetailPage>): Promise<void> {
  for (let i = 0; i < 10; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
    const page = fixture.componentInstance as unknown as { loading: () => boolean };
    if (!page.loading()) {
      fixture.detectChanges();
      return;
    }
  }
}

describe('EnemyPlayerDetailPage', () => {
  let fixture: ComponentFixture<EnemyPlayerDetailPage>;
  let getPlayer: ReturnType<typeof vi.fn>;

  async function setup(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [EnemyPlayerDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        TranslateService,
        { provide: EnemiesService, useValue: { getPlayer } },
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(EnemyPlayerDetailPage);
  }

  afterEach(() => {
    fixture?.destroy();
  });

  it('shows a loading state before the dossier resolves', async () => {
    getPlayer = vi.fn().mockReturnValue(of(dossier));
    await setup();
    fixture.componentRef.setInput('id', '3');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="status"]')).toBeTruthy();
  });

  it('renders the populated dossier with battle history, newest first', async () => {
    getPlayer = vi.fn().mockReturnValue(of(dossier));
    await setup();
    fixture.componentRef.setInput('id', '3');
    await settle(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Nemesis Prime');
    expect(text).toContain('Weaklings Nemesis');
    expect(text).toContain('Unobserved');
    expect(getPlayer).toHaveBeenCalledWith(3);

    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
  });

  it('shows a not-found message on a 404 instead of crashing', async () => {
    getPlayer = vi.fn().mockReturnValue(throwError(() => new ApiError(404, 'Not found')));
    await setup();
    fixture.componentRef.setInput('id', '999');
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('That enemy player no longer exists.');
  });
});
