import assert from 'node:assert/strict';
import test from 'node:test';
import type { BattleGuildSummary, BattleSummary } from '../api/types.js';
import { buildBattleEmbed, buildBattleListEmbed } from './battle.embed.js';

function guild(overrides: Partial<BattleGuildSummary>): BattleGuildSummary {
  return {
    id: 'g',
    name: 'Guild',
    players: 20,
    kills: 5,
    deaths: 5,
    kill_fame: 100_000,
    winner: false,
    ...overrides,
  };
}

function battle(overrides: Partial<BattleSummary> = {}): BattleSummary {
  return {
    battle_id: 4242,
    start_time: '2026-09-12T19:00:00Z',
    end_time: '2026-09-12T19:20:00Z',
    total_players: 40,
    total_kills: 10,
    total_fame: 300_000,
    guilds: [
      // The tenant's Albion guild is not called like the env GUILD_NAME.
      guild({ id: 'mine', name: 'Night Owls', kill_fame: 200_000, is_friendly: true, is_own: true }),
      guild({ id: 'foe', name: 'Rivals', kill_fame: 100_000, winner: true }),
    ],
    outcome: 'victory',
    ...overrides,
  };
}

test('embed renders the backend outcome, not the upstream winner flag', () => {
  // The enemy carries winner=true; the backend says we won.
  const embed = buildBattleEmbed(battle());
  assert.match(embed.data.title ?? '', /VICTORY/);
  assert.equal(embed.data.color, 0x2ecc71);
});

test('embed shows defeat, draw and unknown instead of mapping everything else to a loss', () => {
  const titleFor = (outcome: BattleSummary['outcome']) =>
    buildBattleEmbed(battle({ outcome })).data.title ?? '';
  assert.match(titleFor('defeat'), /DEFEAT/);
  assert.match(titleFor('draw'), /DRAW/);
  assert.match(titleFor('unknown'), /UNKNOWN/);
  assert.match(titleFor(undefined), /UNKNOWN/);
  assert.doesNotMatch(titleFor('draw'), /DEFEAT/);
});

test('embed finds our side from backend flags for a guild named differently from the env value', () => {
  const embed = buildBattleEmbed(battle());
  const names = (embed.data.fields ?? []).map((field) => field.name);
  assert.ok(names.includes('🛡️ Night Owls'));
  const opponents = (embed.data.fields ?? []).find((field) => field.name === '💀 Top Opponents');
  assert.match(opponents?.value ?? '', /Rivals/);
  assert.doesNotMatch(opponents?.value ?? '', /Night Owls/);
});

test('allied guilds are never listed as opponents', () => {
  const embed = buildBattleEmbed(
    battle({
      guilds: [
        guild({ id: 'mine', name: 'Night Owls', is_friendly: true, is_own: true }),
        guild({ id: 'ally', name: 'Friends', is_friendly: true }),
        guild({ id: 'foe', name: 'Rivals' }),
      ],
    }),
  );
  const opponents = (embed.data.fields ?? []).find((field) => field.name === '💀 Top Opponents');
  assert.match(opponents?.value ?? '', /Rivals/);
  assert.doesNotMatch(opponents?.value ?? '', /Friends/);
});

test('list embed badges follow the backend outcome per battle', () => {
  const embed = buildBattleListEmbed(
    [
      battle({ battle_id: 1, outcome: 'victory' }),
      battle({ battle_id: 2, outcome: 'defeat' }),
      battle({ battle_id: 3, outcome: 'draw' }),
      battle({ battle_id: 4, outcome: 'unknown' }),
    ],
    1,
    1,
  );
  const lines = (embed.data.description ?? '').split('\n\n');
  assert.match(lines[0], /WIN/);
  assert.match(lines[1], /LOSS/);
  assert.match(lines[2], /DRAW/);
  assert.match(lines[3], /N\/A/);
  assert.match(lines[0], /200,000 fame/);
});
