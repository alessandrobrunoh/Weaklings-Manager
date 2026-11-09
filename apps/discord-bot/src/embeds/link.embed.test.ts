import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPendingLinkEmbed } from './link.embed.js';

test('the pending embed names the character and says an officer decides', () => {
  const embed = buildPendingLinkEmbed('Galvdon');
  assert.match(embed.description ?? '', /Galvdon/);
  assert.match(embed.description ?? '', /officer/);
});
