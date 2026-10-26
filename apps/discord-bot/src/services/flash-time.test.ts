import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFlashWhen } from './flash-time.js';

const NOW = new Date('2026-10-26T18:30:00Z'); // 19:30 in Europe/Rome (CET)

test('parses relative minutes and hours', () => {
  assert.deepEqual(parseFlashWhen('30m', NOW), {
    massAt: new Date('2026-10-26T19:00:00Z'),
    interpretation: 'in 30m',
  });
  assert.deepEqual(parseFlashWhen('1h', NOW), {
    massAt: new Date('2026-10-26T19:30:00Z'),
    interpretation: 'in 1h',
  });
  assert.deepEqual(parseFlashWhen('1h30m', NOW), {
    massAt: new Date('2026-10-26T20:00:00Z'),
    interpretation: 'in 1h 30m',
  });
});

function parsedInterpretation(input: string): string {
  const result = parseFlashWhen(input, NOW);
  assert.ok(!('error' in result), `expected ${input} to parse`);
  return result.interpretation;
}

test('parses wall-clock times in the guild timezone', () => {
  // 21:00 Rome time on 2026-10-26 is 20:00 UTC (CET, UTC+1).
  const result = parseFlashWhen('21:00', NOW);
  assert.ok(!('error' in result));
  assert.equal(result.massAt.toISOString(), '2026-10-26T20:00:00.000Z');

  // 19:00 Rome (18:00 UTC) has already passed at 18:30 UTC → tomorrow.
  const tomorrow = parseFlashWhen('19:00', NOW);
  assert.ok(!('error' in tomorrow));
  assert.equal(tomorrow.massAt.toISOString(), '2026-10-27T18:00:00.000Z');
});

// Keep the interpretation contract exercised without duplicating every case.
test('relative interpretations read naturally', () => {
  assert.equal(parsedInterpretation('45m'), 'in 45m');
  assert.equal(parsedInterpretation('2h'), 'in 2h');
  assert.equal(parsedInterpretation('1h15m'), 'in 1h 15m');
});

test('rejects garbage and out-of-range input instead of guessing', () => {
  for (const bad of ['', 'tra poco', '21;15', 'banana', '999h']) {
    assert.ok('error' in parseFlashWhen(bad, NOW), `expected ${bad} to be rejected`);
  }
  const tooFar = parseFlashWhen('13h', NOW);
  assert.ok('error' in tooFar);
  assert.match(tooFar.error, /12h/);
});
