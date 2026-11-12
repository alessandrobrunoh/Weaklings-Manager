import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiClient } from '../api/client.js';
import {
  announcementRoleIds,
  effectiveEventDelivery,
  eventIsShared,
  tenantKindOf,
} from './event-shared.js';

test('links, alliance-shared guild events and alliance events are shared; plain events are not', () => {
  assert.equal(eventIsShared({}), false);
  assert.equal(eventIsShared({ is_link: true }), true);
  assert.equal(eventIsShared({ ping_alliance: true }), true);
  assert.equal(eventIsShared({}, 'alliance'), true);
  assert.equal(eventIsShared({}, 'guild'), false);
});

test('a shared event is announced publicly even where the server keeps a calendar', () => {
  assert.equal(effectiveEventDelivery('calendar', true), 'message');
  assert.equal(effectiveEventDelivery('calendar', false), 'calendar');
  assert.equal(effectiveEventDelivery('message', true), 'message');
  assert.equal(effectiveEventDelivery('forum', true), 'forum');
});

test('a link pings the server own event role, not the roles of the owning server', () => {
  assert.deepEqual(
    announcementRoleIds({ is_link: true, discord_role_ids: ['owner-role'] }, 'own-role'),
    ['own-role'],
  );
  assert.deepEqual(announcementRoleIds({ is_link: true, discord_role_ids: ['owner-role'] }, null), []);
  assert.deepEqual(
    announcementRoleIds({ is_link: false, discord_role_ids: ['a', 'a', 'b'] }, 'own-role'),
    ['a', 'b'],
  );
});

test('the tenant kind lookup never throws', async () => {
  const failing = {
    guildId: '900000000000000001',
    get: async () => {
      throw new Error('backend down');
    },
  } as unknown as ApiClient;
  assert.equal(await tenantKindOf(failing), null);

  const alliance = {
    guildId: '900000000000000002',
    get: async () => ({ id: '900000000000000002', registered: true, kind: 'alliance' }),
  } as unknown as ApiClient;
  assert.equal(await tenantKindOf(alliance), 'alliance');

  assert.equal(await tenantKindOf({ get: async () => ({}) } as unknown as ApiClient), null);
});
