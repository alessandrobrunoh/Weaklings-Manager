import assert from 'node:assert/strict';
import test from 'node:test';
import type { BuildSummary } from '../api/types.js';
import { buildDisplayName, findBuildMatches } from './build-lookup.js';

function build(id: number, creator: string): BuildSummary {
  return {
    id,
    name: 'Fire',
    role: 'dps',
    category_id: 1,
    category_name: 'ZvZ',
    created_by_username: creator,
    updated_at: '2026-01-01T00:00:00Z',
    item_count: 7,
  };
}

test('build display keys use spaces and include category and creator', () => {
  assert.equal(buildDisplayName(build(1, 'Alessandro')), 'Fire ZvZ Alessandro');
  assert.ok(!buildDisplayName(build(1, 'Alessandro')).includes('-'));
});

test('full display key selects one variant without ambiguity', () => {
  const matches = findBuildMatches(
    [build(1, 'Alessandro'), build(2, 'Marco')],
    ' fire   zvz  marco ',
  );

  assert.deepEqual(matches.map((item) => item.id), [2]);
});

test('plain build name returns all variants for an ambiguity response', () => {
  const matches = findBuildMatches([build(1, 'Alessandro'), build(2, 'Marco')], 'Fire');

  assert.deepEqual(matches.map((item) => item.id), [1, 2]);
});
