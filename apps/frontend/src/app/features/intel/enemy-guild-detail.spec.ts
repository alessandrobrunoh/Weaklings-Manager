import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnemyGuildDossier } from '../../core/models/api.models';
import { ApiError } from '../../core/services/api.service';
import { EnemiesService } from '../../core/services/enemies.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { EnemyGuildDetailPage } from './enemy-guild-detail';

const dossier: EnemyGuildDossier = {
  id: 7,
  guild_key: 'id:123',
  albion_guild_id: '123',
  name: 'Weaklings Nemesis',
  current_alliance_id: 'A1',
  current_alliance_name: 'Doom Alliance',
  first_seen_at: '2026-01-01T00:00:00Z',
  last_seen_at: '2026-06-01T00:00:00Z',
  is_watchlisted: true,
  notes: 'Runs heavy cleave comps.',
  aliases: [
    {
      kind: 'name',
      values: [
        {
          value: 'Old Name',
          first_seen_at: '2026-01-01T00:00:00Z',
          last_seen_at: '2026-02-01T00:00:00Z',
        },
        {
          value: 'Weaklings Nemesis',
          first_seen_at: '2026-02-01T00:00:00Z',
          last_seen_at: '2026-06-01T00:00:00Z',
        },
      ],
    },
  ],
  battles_fought: 12,
  our_kills: 40,
  their_kills: 20,
  roster: [
    {
      id: 3,
      player_key: 'id:999',
      name: 'Nemesis Prime',
      role: 'tank',
      main_hand_item_id: 'T8_2H_HAMMER',
      item_power: 1400,
      first_seen_at: '2026-01-01T00:00:00Z',
      last_seen_at: '2026-06-01T00:00:00Z',
    },
  ],
  weapon_histogram: [
    { main_hand_item_id: 'T8_2H_HAMMER', count: 5 },
    { main_hand_item_id: 'T8_MAIN_SWORD', count: 3 },
  ],
};

async function settle(fixture: ComponentFixture<EnemyGuildDetailPage>): Promise<void> {
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

describe('EnemyGuildDetailPage', () => {
  let fixture: ComponentFixture<EnemyGuildDetailPage>;
  let getGuild: ReturnType<typeof vi.fn>;

  async function setup(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [EnemyGuildDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        TranslateService,
        { provide: EnemiesService, useValue: { getGuild } },
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(EnemyGuildDetailPage);
  }

  afterEach(() => {
    fixture?.destroy();
  });

  it('shows a loading state before the dossier resolves', async () => {
    getGuild = vi.fn().mockReturnValue(of(dossier));
    await setup();
    fixture.componentRef.setInput('id', '7');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="status"]')).toBeTruthy();
  });

  it('renders the populated dossier', async () => {
    getGuild = vi.fn().mockReturnValue(of(dossier));
    await setup();
    fixture.componentRef.setInput('id', '7');
    await settle(fixture);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Weaklings Nemesis');
    expect(text).toContain('Doom Alliance');
    expect(text).toContain('Watchlisted');
    expect(text).toContain('Old Name');
    expect(text).toContain('Nemesis Prime');
    expect(text).toContain('Runs heavy cleave comps.');
    expect(getGuild).toHaveBeenCalledWith(7);
  });

  it('shows a not-found message on a 404 instead of crashing', async () => {
    getGuild = vi.fn().mockReturnValue(throwError(() => new ApiError(404, 'Not found')));
    await setup();
    fixture.componentRef.setInput('id', '999');
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('That enemy guild no longer exists.');
  });
});
