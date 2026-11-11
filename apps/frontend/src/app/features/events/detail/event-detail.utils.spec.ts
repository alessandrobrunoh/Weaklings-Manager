import { describe, expect, it } from 'vitest';

import type { EventBattleSummary, EventFight } from '../../../core/models/api.models';
import { fightMetrics, formatConfidence, formatPercent } from './event-detail.utils';

function fight(overrides: Partial<EventFight> = {}): EventFight {
  return {
    id: 1,
    started_at: '2026-01-01T00:00:00Z',
    ended_at: null,
    grouping_method: 'automatic',
    grouping_confidence: 0.93,
    needs_review: false,
    battle_ids: ['10', '11'],
    ...overrides,
  };
}

function battle(id: string, overrides: Partial<EventBattleSummary> = {}): EventBattleSummary {
  return {
    albionbb_battle_id: id,
    outcome: 'victory',
    battle_total_players: 40,
    guild_kills: 5,
    guild_kill_fame: 1000,
    ...overrides,
  } as EventBattleSummary;
}

describe('fightMetrics', () => {
  const battles = [battle('10'), battle('11', { battle_total_players: 55, guild_kills: 7 })];

  it('falls back to the linked battles when the fight has no aggregates', () => {
    expect(fightMetrics(fight(), battles)).toEqual({
      outcome: 'victory',
      segments: 2,
      players: 55,
      kills: 12,
      fame: 2000,
    });
  });

  it('reports nothing it cannot know when no battle is linked', () => {
    expect(fightMetrics(fight(), [])).toEqual({
      outcome: 'unknown',
      segments: 2,
      players: null,
      kills: null,
      fame: null,
    });
  });

  it('prefers the fight-level aggregates over the linked battles', () => {
    const metrics = fightMetrics(
      fight({
        outcome: { outcome: 'defeat', evidence_count: 2, method: 'fight_stats' },
        segment_count: 3,
        total_players: 80,
        total_kills: 31,
        total_fame: 9000,
      }),
      battles,
    );
    expect(metrics).toEqual({ outcome: 'defeat', segments: 3, players: 80, kills: 31, fame: 9000 });
  });

  it('reads the nested stats before the linked battles', () => {
    const metrics = fightMetrics(
      fight({ stats: { players: 70, kills: 20, kill_fame: 4000 } }),
      battles,
    );
    expect(metrics.players).toBe(70);
    expect(metrics.kills).toBe(20);
    expect(metrics.fame).toBe(4000);
  });

  it('keeps a zero aggregate instead of falling back', () => {
    const metrics = fightMetrics(fight({ total_kills: 0 }), battles);
    expect(metrics.kills).toBe(0);
  });
});

describe('percent helpers', () => {
  it('formats a 0..100 win rate without rescaling', () => {
    expect(formatPercent(75)).toBe('75.0%');
    expect(formatPercent(0.5)).toBe('0.5%');
  });

  it('formats the 0..1 grouping confidence as a real percentage', () => {
    expect(formatConfidence(0.93)).toBe('93%');
  });
});
