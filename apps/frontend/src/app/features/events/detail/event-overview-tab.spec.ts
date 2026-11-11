import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { BattleLossEstimate, EventDetailView } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import { EventOverviewTab } from './event-overview-tab';

function render(stats: { wins: number; losses: number; total_battles: number }): HTMLElement {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([]), TranslateService],
  });
  TestBed.inject(TranslateService).use('en');
  const fixture = TestBed.createComponent(EventOverviewTab);
  const detail = {
    stats: {
      ...stats,
      win_rate: 0,
      total_kills: 0,
      total_deaths: 0,
      kill_death_ratio: 0,
      total_kill_fame: 0,
      average_guild_players: 0,
      top_opponents: [],
    },
    split_stats: null,
  } as unknown as EventDetailView;
  const loss = {
    total_estimated_loss: 0,
    priced_items: 0,
    total_items: 0,
    players: [],
  } as unknown as BattleLossEstimate;
  fixture.componentRef.setInput('event', detail);
  fixture.componentRef.setInput('eventLossEstimate', loss);
  fixture.componentRef.setInput('canViewOpponents', false);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('EventOverviewTab win rate', () => {
  it('uses wins / (wins + losses) for both the number and the bar, and says what is excluded', () => {
    const el = render({ wins: 3, losses: 1, total_battles: 8 });
    expect(el.textContent).toContain('75.0%');
    const bar = el.querySelector<HTMLElement>('.event-detail__fill-bar > span');
    expect(bar?.style.width).toBe('75%');
    expect(el.textContent).toContain('4 draw or unknown, not counted in the win rate');
  });

  it('shows no rate and no bar when nothing was decided', () => {
    const el = render({ wins: 0, losses: 0, total_battles: 2 });
    expect(el.querySelector('.event-detail__fill-bar')).toBeNull();
    expect(el.textContent).toContain('2 draw or unknown');
  });
});
