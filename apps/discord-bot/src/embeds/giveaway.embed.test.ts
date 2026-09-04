import assert from 'node:assert/strict';
import test from 'node:test';
import type { GiveawayView } from '../api/types.js';
import {
  buildGiveawayActionRow,
  buildGiveawayAnnouncementMessage,
  buildGiveawayEmbed,
  buildGiveawayWinnerMessage,
} from './giveaway.embed.js';

function giveaway(overrides: Partial<GiveawayView> = {}): GiveawayView {
  return {
    id: 7,
    title: 'T8 Dual Swords',
    description: 'Friday GvG loot',
    ends_at: '2026-09-12T19:00:00Z',
    status: 'open',
    created_by: 1,
    created_by_username: 'Officer',
    created_at: '2026-09-04T10:00:00Z',
    silver_amount: '2000000',
    winner_user_id: null,
    winner_username: null,
    winner_discord_id: null,
    drawn_at: null,
    silver_transaction_id: null,
    discord_message_id: null,
    discord_channel_id: null,
    entry_count: 12,
    prizes: [
      {
        id: 1,
        openalbion_item_id: 9,
        openalbion_item_name: 'Dual Swords',
        openalbion_item_icon: null,
        openalbion_item_identifier: 'T8_2H_DUALSWORD@3',
        openalbion_item_tier: 'T8.3',
        openalbion_item_quality: 4,
        quantity: 1,
      },
    ],
    ...overrides,
  };
}

test('open giveaway embed lists prizes, silver, and participant count', () => {
  const embed = buildGiveawayEmbed(giveaway());
  const description = embed.data.description ?? '';
  assert.match(description, /Dual Swords — T8\.3 · Excellent · ×1/);
  assert.match(description, /2,000,000\.00 silver/);
  assert.match(description, /Participants\*\* — 12/);
  assert.equal(embed.data.title, '🎁 T8 Dual Swords');
});

test('participate and leave stay enabled only while open', () => {
  const open = buildGiveawayActionRow(giveaway());
  assert.equal(open.components[0].data.disabled, false);
  const drawn = buildGiveawayActionRow(giveaway({ status: 'drawn' }));
  assert.equal(drawn.components[0].data.disabled, true);
  assert.equal(drawn.components[1].data.disabled, true);
});

test('announcement pings the configured role inside a spoiler', () => {
  const message = buildGiveawayAnnouncementMessage(giveaway(), '111');
  assert.equal(message.content, '|| <@&111> ||');
  assert.deepEqual(message.allowedMentions, { parse: [], roles: ['111'] });
});

test('winner message mentions the linked Discord user', () => {
  const message = buildGiveawayWinnerMessage(
    giveaway({
      status: 'drawn',
      winner_discord_id: '999',
      winner_username: 'Alice',
    }),
  );
  assert.match(message.content, /<@999>/);
  assert.deepEqual(message.allowedMentions.users, ['999']);
});
