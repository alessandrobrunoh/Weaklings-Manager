import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiClient } from './client.js';
import { resolveInternalUserId } from './resolve-user.js';

interface Call {
  path: string;
  body: unknown;
  discordId: string | undefined;
}

function api(result: unknown, calls: Call[] = [], failure?: Error): ApiClient {
  return {
    post: async (path: string, body: unknown, discordId?: string) => {
      calls.push({ path, body, discordId });
      if (failure) throw failure;
      return result;
    },
    get: async (path: string) => {
      throw new Error(`no lookups expected, got ${path}`);
    },
  } as unknown as ApiClient;
}

const target = { id: '222222222222222222', username: 'Never Logged In' };

test('resolveInternalUserId provisions a verified server member through members/ensure', async () => {
  const calls: Call[] = [];
  const id = await resolveInternalUserId(
    api({ user_id: 41, created: true, active: true }, calls),
    target,
    true,
  );
  assert.equal(id, 41);
  assert.deepEqual(calls, [
    {
      path: 'api/members/ensure',
      body: { discord_id: '222222222222222222', username: 'Never Logged In' },
      discordId: undefined,
    },
  ]);
});

test('resolveInternalUserId refuses a user option that is not a server member, without calling the backend', async () => {
  const calls: Call[] = [];
  const id = await resolveInternalUserId(api({ user_id: 1 }, calls), target, false);
  assert.equal(id, null);
  assert.equal(calls.length, 0);
});

test('resolveInternalUserId returns null when the backend refuses', async () => {
  const id = await resolveInternalUserId(
    api(null, [], new Error('Invalid bot secret')),
    target,
    true,
  );
  assert.equal(id, null);
});

test('resolveInternalUserId ignores a malformed backend answer', async () => {
  const id = await resolveInternalUserId(api({ user_id: 0 }), target, true);
  assert.equal(id, null);
});
