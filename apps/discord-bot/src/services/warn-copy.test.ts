import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCORD_FIELD_VALUE_LIMIT,
  clampDiscordField,
  warnEscalationGauge,
  warnSeverityBadge,
} from './warn-copy.js';

test('warn severities match the API values instead of high/medium/low', () => {
  assert.match(warnSeverityBadge('note'), /NOTE/);
  assert.match(warnSeverityBadge('warn'), /WARN/);
  assert.match(warnSeverityBadge('strike'), /STRIKE/);
  assert.doesNotMatch(warnSeverityBadge('strike'), /HIGH/);
});

test('warn gauge uses the configured escalation threshold and does not promise a kick', () => {
  const gauge = warnEscalationGauge(2, 6);
  assert.match(gauge, /2 \/ 6/);
  assert.match(gauge, /escalation opens at 6/);
  assert.doesNotMatch(gauge, /Kick/);
  assert.doesNotMatch(warnEscalationGauge(4, null), /Kick at 4/);
});

test('clampDiscordField stays inside Discord\'s embed field limit', () => {
  const clamped = clampDiscordField('x'.repeat(2000));
  assert.equal(clamped.length, DISCORD_FIELD_VALUE_LIMIT);
});
