import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { EventSignupBuildOption } from '../api/types.js';
import {
  executeEventThreadAction,
  resolveEventFromThread,
  resolveSignupBuildByName,
} from './event-thread-command.js';
import { registerPoller, unregisterPoller, type Poller } from './poller.js';
import { forgetTenantStatus } from './tenant-gate.js';

// The thread join flow resolves guild attribution before signing up; these
// tests run in a plain guild tenant so no guild choice is ever prompted.
forgetTenantStatus('thread-test-guild');

interface ReplyPayload {
  embeds: Array<{ data: { title?: string; description?: string } }>;
  components?: unknown[];
}

function makeInteraction(options: {
  threadId?: string | null;
  locale?: string;
  build?: string | null;
}): {
  interaction: ChatInputCommandInteraction;
  replies: ReplyPayload[];
  threadMessages: unknown[];
} {
  const replies: ReplyPayload[] = [];
  const threadMessages: unknown[] = [];
  const channel = options.threadId
    ? {
        id: options.threadId,
        isThread: () => true,
        send: async (payload: unknown) => {
          threadMessages.push(payload);
          return payload;
        },
      }
    : { id: 'not-a-thread', isThread: () => false };
  return {
    replies,
    threadMessages,
    interaction: {
      channel,
      locale: options.locale ?? 'en',
      user: { id: '424242' },
      guildId: 'thread-test-guild',
      guild: null,
      client: { channels: { fetch: async () => null } },
      options: { getString: (_name: string) => options.build ?? null },
      deferReply: async () => undefined,
      editReply: async (payload: ReplyPayload) => {
        replies.push(payload);
        return payload;
      },
    } as unknown as ChatInputCommandInteraction,
  };
}

function makePoller(threadByEvent: Record<string, string>): Poller {
  const inverted = new Map(Object.entries(threadByEvent).map(([eventId, threadId]) => [threadId, eventId]));
  return {
    guildId: 'thread-test-guild',
    stop: () => undefined,
    findEventIdForThread: (threadId: string) => {
      const eventId = inverted.get(threadId);
      return eventId ? Number(eventId) : null;
    },
    eventSignupMessageIdFor: () => 'card-message-1',
    pollNow: async () => undefined,
    closeEventThread: async () => true,
    finalizeStoppedEventThread: async () => true,
    rememberEventThread: () => undefined,
  } as unknown as Poller;
}

function makeApi(routes: {
  get?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
  del?: (path: string) => unknown;
}): ApiClient & { calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    guildId: 'thread-test-guild',
    calls,
    async get(path: string) {
      calls.push({ method: 'get', path });
      if (path === 'api/users/me') return {};
      if (path === 'api/tenants/thread-test-guild/status') {
        return { id: 'thread-test-guild', registered: true, status: 'active', name: 'A Guild', kind: 'guild' };
      }
      const result = routes.get?.(path);
      if (result === undefined) throw new Error(`Unexpected GET ${path}`);
      return result;
    },
    async post(path: string, body: unknown) {
      calls.push({ method: 'post', path, body });
      const result = routes.post?.(path, body);
      if (result === undefined) throw new Error(`Unexpected POST ${path}`);
      return result;
    },
    async delete(path: string) {
      calls.push({ method: 'delete', path });
      const result = routes.del?.(path);
      if (result === undefined) throw new Error(`Unexpected DELETE ${path}`);
      return result;
    },
  } as unknown as ApiClient & { calls: Array<{ method: string; path: string; body?: unknown }> };
}

const builds: EventSignupBuildOption[] = [
  { build_id: 10, name: 'Great Fire', role: 'dps', quantity: 2 },
  { build_id: 11, name: 'Grail', role: 'healer', quantity: 1 },
  { build_id: 12, name: 'Greatsword', role: 'dps', quantity: 3 },
];

test('resolveEventFromThread maps a known thread to its event id', () => {
  const poller = makePoller({ '5': 'thread-5' });
  assert.equal(resolveEventFromThread({ id: 'thread-5', isThread: () => true }, poller), 5);
});

test('resolveEventFromThread rejects unknown threads, plain channels, and missing pollers', () => {
  const poller = makePoller({ '5': 'thread-5' });
  assert.equal(resolveEventFromThread({ id: 'thread-9', isThread: () => true }, poller), null);
  assert.equal(resolveEventFromThread({ id: 'thread-5', isThread: () => false }, poller), null);
  assert.equal(resolveEventFromThread({ id: 'thread-5', isThread: () => true }, null), null);
  assert.equal(resolveEventFromThread(null, poller), null);
});

test('resolveSignupBuildByName accepts exact and unique partial names', () => {
  assert.deepEqual(resolveSignupBuildByName(builds, 'great fire'), { kind: 'unique', build: builds[0] });
  assert.deepEqual(resolveSignupBuildByName(builds, 'grail'), { kind: 'unique', build: builds[1] });
});

test('resolveSignupBuildByName reports ambiguity and misses', () => {
  assert.deepEqual(resolveSignupBuildByName(builds, 'great'), {
    kind: 'ambiguous',
    matches: [builds[0], builds[2]],
  });
  assert.deepEqual(resolveSignupBuildByName(builds, 'blazing'), { kind: 'none' });
});

test('/join outside an event thread replies with a localized hint', async () => {
  registerPoller(makePoller({ '5': 'thread-5' }));
  try {
    const { interaction, replies } = makeInteraction({ threadId: null, locale: 'it' });
    await executeEventThreadAction(interaction, makeApi({}), 'join');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].embeds[0].data.title, '⚠️ Usa dentro un thread evento');
  } finally {
    unregisterPoller('thread-test-guild');
  }
});

test('/join in an unknown thread also refuses', async () => {
  registerPoller(makePoller({ '5': 'thread-5' }));
  try {
    const { interaction, replies } = makeInteraction({ threadId: 'thread-9' });
    await executeEventThreadAction(interaction, makeApi({}), 'join');
    assert.match(replies[0].embeds[0].data.description ?? '', /inside an event's discussion thread/);
  } finally {
    unregisterPoller('thread-test-guild');
  }
});

test('/join on a flash mass signs up directly with no build', async () => {
  registerPoller(makePoller({ '7': 'thread-7' }));
  try {
    const { interaction, replies } = makeInteraction({ threadId: 'thread-7' });
    const api = makeApi({
      get: (path) => {
        if (path === 'api/events/7') {
          return {
            id: 7,
            event_kind: 'flash',
            status: 'scheduled',
            participants: [],
            event_date_utc: '2030-01-01T00:00:00Z',
          };
        }
        throw new Error(`Unexpected GET ${path}`);
      },
      post: (path) => {
        if (path === 'api/events/7/participate') {
          return { id: 7, event_kind: 'flash', event_date_utc: '2030-01-01T00:00:00Z' };
        }
        throw new Error(`Unexpected POST ${path}`);
      },
    });
    await executeEventThreadAction(interaction, api, 'join');
    assert.ok(api.calls.some((call) => call.method === 'post' && call.path === 'api/events/7/participate'));
    assert.equal(replies[0].embeds[0].data.title, "✅ You're In");
  } finally {
    unregisterPoller('thread-test-guild');
  }
});

test('/join on an organized event with a resolvable build signs up for that build', async () => {
  registerPoller(makePoller({ '5': 'thread-5' }));
  try {
    const { interaction, replies } = makeInteraction({ threadId: 'thread-5', build: 'grail' });
    const api = makeApi({
      get: (path) => {
        if (path === 'api/events/5') return { id: 5, event_kind: 'organized', status: 'scheduled', participants: [] };
        if (path === 'api/events/5/signup-options') return { builds, is_already_registered: false };
        throw new Error(`Unexpected GET ${path}`);
      },
      post: (path, body) => {
        if (path === 'api/events/5/participate') return { id: 5 };
        throw new Error(`Unexpected POST ${path} ${JSON.stringify(body)}`);
      },
    });
    await executeEventThreadAction(interaction, api, 'join');
    const signup = api.calls.find((call) => call.method === 'post' && call.path === 'api/events/5/participate');
    assert.deepEqual(signup?.body, { primary_build_id: 11 });
    assert.match(replies[0].embeds[0].data.description ?? '', /Grail/);
  } finally {
    unregisterPoller('thread-test-guild');
  }
});

test('/join with an ambiguous build lists the matches', async () => {
  registerPoller(makePoller({ '5': 'thread-5' }));
  try {
    const { interaction, replies } = makeInteraction({ threadId: 'thread-5', build: 'great' });
    const api = makeApi({
      get: (path) => {
        if (path === 'api/events/5') return { id: 5, event_kind: 'organized', status: 'scheduled', participants: [] };
        if (path === 'api/events/5/signup-options') return { builds, is_already_registered: false };
        throw new Error(`Unexpected GET ${path}`);
      },
    });
    await executeEventThreadAction(interaction, api, 'join');
    assert.equal(api.calls.some((call) => call.method === 'post'), false);
    const description = replies[0].embeds[0].data.description ?? '';
    assert.match(description, /Great Fire/);
    assert.match(description, /Greatsword/);
  } finally {
    unregisterPoller('thread-test-guild');
  }
});

test('/leave removes the participant and confirms', async () => {
  registerPoller(makePoller({ '5': 'thread-5' }));
  try {
    const { interaction, replies } = makeInteraction({ threadId: 'thread-5' });
    const api = makeApi({
      get: (path) => {
        if (path === 'api/events/5') {
          return {
            id: 5,
            event_kind: 'organized',
            status: 'scheduled',
            participants: [{ discord_id: '424242', username: 'tester' }],
          };
        }
        throw new Error(`Unexpected GET ${path}`);
      },
      del: (path) => {
        if (path === 'api/events/5/participate') return {};
        throw new Error(`Unexpected DELETE ${path}`);
      },
    });
    await executeEventThreadAction(interaction, api, 'leave');
    assert.ok(api.calls.some((call) => call.method === 'delete' && call.path === 'api/events/5/participate'));
    assert.equal(replies[0].embeds[0].data.title, '✅ Left Event');
  } finally {
    unregisterPoller('thread-test-guild');
  }
});

test('/ping verifies authority, posts the reminder, and confirms', async () => {
  registerPoller(makePoller({ '5': 'thread-5' }));
  try {
    const { interaction, replies, threadMessages } = makeInteraction({ threadId: 'thread-5' });
    const api = makeApi({
      get: (path) => {
        if (path === 'api/events/5/management-authority') {
          return { is_organizer: false, can_manage: true, required_permission: 'events.edit' };
        }
        throw new Error(`Unexpected GET ${path}`);
      },
      post: (path) => {
        if (path === 'api/events/5/remind') {
          return { id: 5, title: 'Castle Dive', event_date_utc: '2030-01-01T00:00:00Z', discord_role_ids: [] };
        }
        throw new Error(`Unexpected POST ${path}`);
      },
    });
    await executeEventThreadAction(interaction, api, 'ping');
    assert.equal(threadMessages.length, 1);
    assert.equal(replies[0].embeds[0].data.title, '✅ Reminder Sent');
  } finally {
    unregisterPoller('thread-test-guild');
  }
});

test('/ping refuses callers the authority endpoint does not clear', async () => {
  registerPoller(makePoller({ '5': 'thread-5' }));
  try {
    const { interaction, replies, threadMessages } = makeInteraction({ threadId: 'thread-5' });
    const api = makeApi({
      get: (path) => {
        if (path === 'api/events/5/management-authority') {
          return { is_organizer: false, can_manage: false, required_permission: 'events.edit' };
        }
        throw new Error(`Unexpected GET ${path}`);
      },
    });
    await executeEventThreadAction(interaction, api, 'ping');
    assert.equal(threadMessages.length, 0);
    assert.equal(replies[0].embeds[0].data.title, '⚠️ Not Allowed');
  } finally {
    unregisterPoller('thread-test-guild');
  }
});