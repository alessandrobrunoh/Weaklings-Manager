import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits, type Guild, type TextChannel } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { ApplicationView, GuildSettingsView } from '../api/types.js';
import {
  findReusableTicket,
  linkIngameName,
  reopenTicket,
  ticketChannelName,
  ticketOverwrites,
} from './application-ticket.js';

const GUILD_ID = '900';

function application(overrides: Partial<ApplicationView> = {}): ApplicationView {
  return {
    id: 7,
    user_discord_id: '42',
    username: 'applicant',
    channel_id: 'chan-1',
    status: 'declined',
    ...overrides,
  };
}

/** A guild whose channel lookup answers from a fixed map. */
function guild(channels: Record<string, { type: number } | undefined>): Guild {
  return {
    id: GUILD_ID,
    channels: {
      cache: { get: (id: string) => channels[id] },
      fetch: async (id: string) => channels[id] ?? null,
    },
  } as unknown as Guild;
}

function api(routes: Record<string, unknown>, calls: string[] = []): ApiClient {
  return {
    guildId: GUILD_ID,
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      if (path in routes) return routes[path];
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path: string, body: unknown) => {
      calls.push(`POST ${path} ${JSON.stringify(body)}`);
      if (path in routes) return routes[path];
      throw new Error(`unexpected POST ${path}`);
    },
  } as unknown as ApiClient;
}

test('ticketChannelName strips what Discord will not take, and falls back', () => {
  assert.equal(ticketChannelName('Galvdon AO', '42'), 'ticket-galvdon-ao');
  assert.equal(ticketChannelName('!!!', '42'), 'ticket-42');
});

test('ticketOverwrites gives the applicant back the access closing took away', () => {
  const overwrites = ticketOverwrites(guild({}), '42', 'manage-role', 'bot');
  const applicant = overwrites.find((entry) => entry.id === '42');
  assert.ok(applicant?.allow?.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(applicant?.allow?.includes(PermissionFlagsBits.ReadMessageHistory));
  // Everyone else still cannot see it.
  assert.ok(
    overwrites
      .find((entry) => entry.id === GUILD_ID)
      ?.deny?.includes(PermissionFlagsBits.ViewChannel),
  );
});

test('findReusableTicket returns the archived channel to reuse', async () => {
  const found = await findReusableTicket(
    guild({ 'chan-1': { type: 0 } }),
    api({ 'api/applications/latest': application() }),
    '42',
  );
  assert.equal(found?.application.id, 7);
});

test('findReusableTicket ignores a ticket that is still open', async () => {
  const found = await findReusableTicket(
    guild({ 'chan-1': { type: 0 } }),
    api({ 'api/applications/latest': application({ status: 'open' }) }),
    '42',
  );
  assert.equal(found, null);
});

/** A deleted channel has no history left to preserve, so a fresh ticket is right. */
test('findReusableTicket ignores a ticket whose channel is gone', async () => {
  const found = await findReusableTicket(
    guild({}),
    api({ 'api/applications/latest': application() }),
    '42',
  );
  assert.equal(found, null);
});

test('findReusableTicket returns nothing when the member never applied', async () => {
  const found = await findReusableTicket(guild({}), api({ 'api/applications/latest': null }), '42');
  assert.equal(found, null);
});

test('reopenTicket moves the channel back and restores access', async () => {
  const calls: string[] = [];
  const moved: string[] = [];
  let overwritesSet: unknown = null;
  const channel = {
    setParent: async (id: string) => {
      moved.push(id);
    },
    permissionOverwrites: {
      set: async (value: unknown) => {
        overwritesSet = value;
      },
    },
  } as unknown as TextChannel;

  const reopened = await reopenTicket(
    guild({}),
    api({ 'api/applications/7/reopen': application({ status: 'open', reopen_count: 1 }) }, calls),
    { discord_applications_manage_role_id: 'manage-role' } as GuildSettingsView,
    '42',
    channel,
    7,
    'Galvdon',
    'active-category',
    'bot',
  );

  assert.equal(reopened.status, 'open');
  assert.deepEqual(calls, ['POST api/applications/7/reopen {"ingame_name":"Galvdon"}']);
  assert.deepEqual(moved, ['active-category']);
  assert.ok(Array.isArray(overwritesSet));
});

test('linkIngameName links the exact character match', async () => {
  const calls: string[] = [];
  const outcome = await linkIngameName(
    api(
      {
        'api/albion/search': { players: [{ id: 'p1', name: 'Galvdon' }], guilds: [] },
        'api/albion/link': { linked: true },
      },
      calls,
    ),
    '42',
    'galvdon',
  );
  assert.equal(outcome, 'linked');
  assert.ok(calls.some((call) => call.includes('POST api/albion/link')));
});

/** A near-match is not the applicant's character; guessing one would be worse. */
test('linkIngameName reports a name Albion does not know', async () => {
  const outcome = await linkIngameName(
    api({ 'api/albion/search': { players: [{ id: 'p1', name: 'Galvdonio' }], guilds: [] } }),
    '42',
    'Galvdon',
  );
  assert.equal(outcome, 'not-found');
});

test('linkIngameName reports an account that already has a character', async () => {
  const client = {
    guildId: GUILD_ID,
    get: async () => ({ players: [{ id: 'p1', name: 'Galvdon' }], guilds: [] }),
    post: async () => {
      throw new Error('Your Discord account is already linked to an Albion player');
    },
  } as unknown as ApiClient;
  assert.equal(await linkIngameName(client, '42', 'Galvdon'), 'already-linked');
});
