import { describe, expect, it } from 'vitest';

import type { FightListItem } from '../../core/models/api.models';
import { buildGuildScopeStats, emptyScopeStats } from './battle-scope-stats';

function fight(overrides: Partial<FightListItem>): FightListItem {
  return {
    id: 1,
    event_id: null,
    event_title: null,
    started_at: '2026-01-01T00:00:00Z',
    ended_at: null,
    grouping_method: 'automatic',
    grouping_confidence: 0.9,
    needs_review: false,
    segment_count: 1,
    total_players: 20,
    total_kills: 10,
    total_fame: 1000,
    outcome: { outcome: 'victory', evidence_count: 1, method: 'x' },
    ...overrides,
  };
}

describe('buildGuildScopeStats', () => {
  it('is empty for no fights', () => {
    expect(buildGuildScopeStats([])).toEqual(emptyScopeStats());
  });

  it('accumulates deaths, kills, fame and decided outcomes', () => {
    const stats = buildGuildScopeStats([
      fight({ total_deaths: 4, total_kills: 10, total_fame: 1000 }),
      fight({
        id: 2,
        total_deaths: 6,
        total_kills: 5,
        total_fame: 500,
        outcome: { outcome: 'defeat', evidence_count: 1, method: 'x' },
      }),
      fight({
        id: 3,
        total_kills: 1,
        total_fame: 50,
        outcome: { outcome: 'unknown', evidence_count: 0, method: 'x' },
      }),
    ]);
    expect(stats).toMatchObject({
      battles: 3,
      kills: 16,
      deaths: 10,
      fame: 1550,
      victories: 1,
      defeats: 1,
    });
  });

  it('does not sum players across fights', () => {
    const stats = buildGuildScopeStats([
      fight({ total_players: 30 }),
      fight({ id: 2, total_players: 45 }),
    ]);
    expect(stats.peakPlayers).toBe(45);
    expect(stats.players).toBe(0);
  });

  it('treats a missing total_deaths as zero', () => {
    expect(buildGuildScopeStats([fight({})]).deaths).toBe(0);
  });
});
