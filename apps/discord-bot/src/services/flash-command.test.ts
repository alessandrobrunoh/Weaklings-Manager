import assert from 'node:assert/strict';
import test from 'node:test';
import { ComponentType } from 'discord.js';
import { buildFlashModal, prefillFromMessage } from '../commands/flash.js';

test('flash modal uses the requesting Discord locale for Italian', () => {
  const modal = buildFlashModal({}, 'it-IT');
  const payload = modal.toJSON();
  const labels = payload.components
    .filter((component) => component.type === ComponentType.ActionRow)
    .flatMap((row) => row.components.map((component) => ('label' in component ? component.label : '')));
  assert.equal(payload.title, 'Massa flash');
  assert.deepEqual(labels, [
    'Cosa',
    'Quando (30m · 1h30m · 21:00)',
    'Note (facoltative)',
  ]);
});

test('message context action pre-fills title, time, and notes without sending', () => {
  assert.deepEqual(
    prefillFromMessage('Castle dive @ Mercer in 30m\nMeet at Caerleon gate'),
    {
      what: 'Castle dive @ Mercer',
      when: '30m',
      notes: 'Meet at Caerleon gate',
    },
  );
});

test('message context action leaves time blank when it cannot confidently parse one', () => {
  assert.deepEqual(prefillFromMessage('Castle dive happening soon'), {
    what: 'Castle dive happening soon',
    when: '',
    notes: '',
  });
});
